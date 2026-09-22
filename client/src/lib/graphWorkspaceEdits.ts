import type { AppState, Conversation } from "../types";
import { createStandaloneNoteConversation } from "../initialState";
import { addChildConversation, addRootConversation, deleteThread } from "./workspaceCommands";
import { getStandaloneNote } from "./standaloneNotes";
import { getConversationRootId } from "./tree";
import { removeConversationsFromGroups } from "./conversationGroups";
import { isTopicExpansion, type TopicExpansion, type TopicExpansionNode } from "./topicExpansion";

export type { TopicExpansion, TopicExpansionNode } from "./topicExpansion";

export function setPersonalMapConnection(state: AppState, sourceId: string, targetId: string, connected: boolean, updatedAt: string): AppState {
  const source = state.conversations[sourceId];
  const target = state.conversations[targetId];
  if (!source || !target || sourceId === targetId) return state;
  // A personal connection is undirected and has a single owner for persistence.
  const [ownerId, otherId] = [sourceId, targetId].sort();
  const owner = state.conversations[ownerId];
  const existing = owner.linkedConversationIds ?? [];
  const reverse = state.conversations[otherId].linkedConversationIds ?? [];
  if (connected && (existing.includes(otherId) || reverse.includes(ownerId))) return state;
  if (!connected && !existing.includes(otherId) && !reverse.includes(ownerId)) return state;
  return { ...state, conversations: { ...state.conversations,
    [ownerId]: { ...owner, linkedConversationIds: connected ? [...existing, otherId] : existing.filter((id) => id !== otherId), updatedAt },
    ...(!connected && reverse.includes(ownerId) ? { [otherId]: { ...state.conversations[otherId], linkedConversationIds: reverse.filter((id) => id !== ownerId), updatedAt } } : {}),
  } };
}

export function createMapNote(state: AppState, args: { id: string; noteId: string; createdAt: string; linkedTo?: string; url?: string }): AppState {
  const note = createStandaloneNoteConversation({ ...args, serviceId: state.defaultServiceId, modelId: state.defaultModelId });
  if (args.url) {
    const url = new URL(args.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Use an http or https web address.");
    note.title = url.hostname;
    note.notes![0].content = `Source: <${url.href.replace(/[<>]/g, (character) => encodeURIComponent(character))}>\n\n`;
  }
  let next = addRootConversation(state, note);
  if (args.linkedTo) next = setPersonalMapConnection(next, args.linkedTo, note.id, true, args.createdAt);
  return next;
}

export function addMapChildNote(state: AppState, args: {
  parentId: string;
  id: string;
  noteId: string;
  createdAt: string;
  title?: string;
  content?: string;
  activate?: boolean;
}): AppState {
  const parent = Object.hasOwn(state.conversations, args.parentId) ? state.conversations[args.parentId] : null;
  if (!parent || Object.hasOwn(state.conversations, args.id)) return state;
  if (!args.id || !args.noteId || !Number.isFinite(Date.parse(args.createdAt))
    || Object.values(state.conversations).some((conversation) => conversation.notes?.some((note) => note.id === args.noteId))) {
    throw new Error("The child note needs a unique identity and a valid creation time.");
  }
  const child = createStandaloneNoteConversation({ ...args, serviceId: parent.serviceId, modelId: parent.modelId });
  child.parentId = parent.id;
  if (args.title?.trim()) child.title = args.title.trim();
  child.notes![0].content = args.content ?? "";
  if (parent.ai) child.ai = structuredClone(parent.ai);
  const next = addChildConversation(state, child, { activate: args.activate ?? true });
  // A pending expansion must not move a more recent authored edit backwards in time.
  if (Date.parse(parent.updatedAt) > Date.parse(args.createdAt)) {
    next.conversations[parent.id] = { ...next.conversations[parent.id], updatedAt: parent.updatedAt };
  }
  return next;
}

/** Validate the complete local outline before any workspace items are created. */
function orderTopicExpansion(expansion: TopicExpansion): TopicExpansionNode[] {
  if (!isTopicExpansion(expansion)) {
    throw new Error("The generated outline must contain two to six valid notes, without circular or missing parents.");
  }
  const nodes = new Map(expansion.nodes.map((node) => [node.id, { ...node, title: node.title.trim() }]));
  const ordered: TopicExpansionNode[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(node: TopicExpansionNode) {
    if (visiting.has(node.id)) throw new Error("The generated outline contains a circular parent relationship.");
    if (visited.has(node.id)) return;
    visiting.add(node.id);
    if (node.parentId !== null) {
      const parent = nodes.get(node.parentId);
      if (!parent) throw new Error("The generated outline references a missing parent note.");
      visit(parent);
    }
    visiting.delete(node.id);
    visited.add(node.id);
    ordered.push(node);
  }
  for (const node of nodes.values()) visit(node);
  return ordered;
}

/** Applies one generated outline atomically; retries never rewrite existing drafts. */
export function applyTopicExpansion(state: AppState, parentId: string, expansion: TopicExpansion, options: {
  requestId: string;
  createdAt: string;
}): AppState {
  const parent = Object.hasOwn(state.conversations, parentId) ? state.conversations[parentId] : null;
  if (!parent) return state;
  if (typeof options.requestId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(options.requestId)
    || typeof options.createdAt !== "string" || !Number.isFinite(Date.parse(options.createdAt))) {
    throw new Error("The generated outline needs a valid request identity and creation time.");
  }
  const ordered = orderTopicExpansion(expansion);
  // The length prefix keeps request/local identifier boundaries unambiguous.
  const workspaceId = (localId: string) => `topic-expansion-${options.requestId.length}-${options.requestId}-${localId}`;
  const noteIds = new Set(Object.values(state.conversations).flatMap((conversation) => (conversation.notes ?? []).map((note) => note.id)));
  for (const node of ordered) {
    const id = workspaceId(node.id);
    const existing = state.conversations[id];
    const noteId = `${id}-note`;
    if (existing ? existing.kind !== "note" || getStandaloneNote(existing)?.id !== noteId : noteIds.has(noteId)) {
      throw new Error("The generated outline conflicts with an existing workspace item.");
    }
  }
  const title = parent.title.replace(/\s+/g, " ").replace(/[\\`*_{}\[\]<>#!|]/g, "\\$&");
  const topicUrl = parent.publicTopic?.wikidataUrl;
  const reference = topicUrl && /^https:\/\/www\.wikidata\.org\/wiki\/Q[1-9][0-9]*$/.test(topicUrl)
    ? `\n\nTopic reference: <${topicUrl}>` : "";
  const provenance = `> AI-generated exploration of ${title}. Review before relying on it.${reference}`;
  let next = state;
  for (const node of ordered) {
    next = addMapChildNote(next, {
      id: workspaceId(node.id), noteId: `${workspaceId(node.id)}-note`,
      parentId: node.parentId === null ? parentId : workspaceId(node.parentId),
      title: node.title, content: `${provenance}\n\n${node.content}`,
      createdAt: options.createdAt, activate: false,
    });
  }
  return next;
}

export interface RemovedMapNote {
  conversation: Conversation;
  layout: AppState["graphLayouts"][string] | undefined;
  groupIds: string[];
  pinned: boolean;
  incomingIds: string[];
  parentChildIndex?: number;
}

export function getRemovableMapNote(state: AppState, id: string): RemovedMapNote | null {
  const conversation = state.conversations[id];
  if (!conversation || conversation.kind !== "note" || conversation.childIds.length
    || Object.values(state.conversations).some((item) => item.parentId === id)) return null;
  return { conversation, layout: state.graphLayouts[id], groupIds: Object.values(state.groups).filter((group) => group.conversationIds.includes(id)).map((group) => group.id), pinned: state.pinnedThreadIds.includes(id), incomingIds: Object.values(state.conversations).filter((item) => item.linkedConversationIds?.includes(id)).map((item) => item.id),
    ...(conversation.parentId ? { parentChildIndex: state.conversations[conversation.parentId]?.childIds.indexOf(id) } : {}),
  };
}

export function removeMapNote(state: AppState, id: string, replacement: Conversation): AppState {
  if (!getRemovableMapNote(state, id)) return state;
  const parentId = state.conversations[id].parentId;
  let next: AppState;
  if (parentId) {
    const parent = state.conversations[parentId];
    if (!parent) return state;
    const conversations = { ...state.conversations, [parentId]: { ...parent, childIds: parent.childIds.filter((childId) => childId !== id) } };
    delete conversations[id];
    const graphLayouts = { ...state.graphLayouts };
    delete graphLayouts[id];
    next = { ...state, conversations, graphLayouts,
      ...(state.activeConversationId === id ? {
        activeConversationId: parentId,
        rootId: getConversationRootId(conversations, parentId) ?? state.rootId,
      } : {}),
      groups: removeConversationsFromGroups(state.groups, [id]),
      pinnedThreadIds: state.pinnedThreadIds.filter((pinnedId) => pinnedId !== id),
    };
  } else {
    next = deleteThread(state, id, replacement);
  }
  return { ...next, conversations: Object.fromEntries(Object.entries(next.conversations).map(([key, conversation]) => [key, conversation.linkedConversationIds?.includes(id) ? { ...conversation, linkedConversationIds: conversation.linkedConversationIds.filter((target) => target !== id) } : conversation])) };
}

/** Undo restores only the removed item; it never rolls back subsequent workspace edits. */
export function restoreMapNote(state: AppState, removed: RemovedMapNote): AppState {
  const { conversation } = removed;
  if (state.conversations[conversation.id] || (conversation.parentId && !Object.hasOwn(state.conversations, conversation.parentId))) return state;
  const conversations = { ...state.conversations, [conversation.id]: { ...conversation, linkedConversationIds: conversation.linkedConversationIds?.filter((id) => Boolean(state.conversations[id])) } };
  if (conversation.parentId) {
    const parent = conversations[conversation.parentId];
    const childIds = parent.childIds.filter((id) => id !== conversation.id);
    childIds.splice(Math.max(0, Math.min(removed.parentChildIndex ?? childIds.length, childIds.length)), 0, conversation.id);
    conversations[parent.id] = { ...parent, childIds };
  }
  for (const id of removed.incomingIds) if (conversations[id]) conversations[id] = { ...conversations[id], linkedConversationIds: [...new Set([...(conversations[id].linkedConversationIds ?? []), conversation.id])] };
  return { ...state, conversations,
    graphLayouts: removed.layout ? { ...state.graphLayouts, [conversation.id]: removed.layout } : state.graphLayouts,
    groups: Object.fromEntries(Object.entries(state.groups).map(([id, group]) => [id, removed.groupIds.includes(id) ? { ...group, conversationIds: [...new Set([...group.conversationIds, conversation.id])] } : group])),
    pinnedThreadIds: removed.pinned ? [...new Set([...state.pinnedThreadIds, conversation.id])] : state.pinnedThreadIds,
  };
}
