import { normalizePublicTopicId, normalizePublicTopicSource } from "@margin-chat/workspace-contracts";
import { createStandaloneNoteConversation } from "../initialState";
import type { AppState, Conversation, DocumentRelation, DocumentRelationOrigin, PublicTopicSource } from "../types";
import { addRootConversation } from "./workspaceCommands";
import { setPersonalMapConnection } from "./graphWorkspaceEdits";

type TopicIdentity = Pick<PublicTopicSource, "id"> & Partial<Pick<PublicTopicSource, "aliases">>;

export function findSavedPublicTopic(
  conversations: Record<string, Conversation>,
  topicOrId: TopicIdentity | string,
): Conversation | null {
  const topic = typeof topicOrId === "string" ? { id: topicOrId } : topicOrId;
  const ids = new Set([topic.id, ...(topic.aliases ?? [])].map(normalizePublicTopicId).filter(Boolean));
  if (!ids.size) return null;
  const saved = Object.values(conversations).filter((conversation) => conversation.publicTopic);
  // Prefer the canonical identity if older imported records contain duplicates.
  const canonicalId = normalizePublicTopicId(topic.id);
  return (canonicalId ? saved.find((conversation) => normalizePublicTopicId(conversation.publicTopic!.id) === canonicalId) : null)
    ?? saved.find((conversation) => [conversation.publicTopic!.id, ...(conversation.publicTopic!.aliases ?? [])]
      .some((id) => ids.has(normalizePublicTopicId(id))))
    ?? null;
}

/** Saves public provenance separately from an empty personal note; never changes navigation. */
export function savePublicTopic(state: AppState, topic: PublicTopicSource): {
  state: AppState;
  conversationId: string;
  created: boolean;
} {
  const publicTopic = normalizePublicTopicSource(topic);
  if (!publicTopic) throw new Error("The public topic has no valid source identity.");
  const existing = findSavedPublicTopic(state.conversations, publicTopic);
  if (existing) {
    const previous = normalizePublicTopicSource(existing.publicTopic)!;
    const updated = normalizePublicTopicSource({
      ...(previous.id === publicTopic.id ? previous : publicTopic),
      aliases: [...previous.aliases, previous.id, ...publicTopic.aliases],
    })!;
    const changed = updated.id !== previous.id || updated.aliases.length !== previous.aliases.length
      || updated.aliases.some((alias, index) => alias !== previous.aliases[index]);
    return {
      state: changed ? { ...state, conversations: { ...state.conversations, [existing.id]: { ...existing, publicTopic: updated } } } : state,
      conversationId: existing.id,
      created: false,
    };
  }

  // Deterministic identities make repeated evaluation of the same update safe.
  const baseId = `public-topic-${publicTopic.id}`;
  const noteIds = new Set(Object.values(state.conversations).flatMap((conversation) => (conversation.notes ?? []).map((note) => note.id)));
  let id = baseId;
  for (let suffix = 2; state.conversations[id] || noteIds.has(`${id}-note`); suffix += 1) id = `${baseId}-${suffix}`;
  const conversation = createStandaloneNoteConversation({
    id,
    noteId: `${id}-note`,
    createdAt: publicTopic.retrievedAt,
    modelId: state.defaultModelId,
    serviceId: state.defaultServiceId,
  });
  conversation.title = publicTopic.label;
  conversation.publicTopic = publicTopic;
  const next = addRootConversation(state, conversation);
  return {
    state: { ...next, activeConversationId: state.activeConversationId, rootId: state.rootId },
    conversationId: id,
    created: true,
  };
}

/** How a public topic joins a note in My map. */
export interface PublicTopicConnection {
  topic: PublicTopicSource;
  /** Broader: the note is part of it. Narrower: it elaborates the note. Related: an untyped link. */
  kind: "broader" | "narrower" | "related";
  /** Where the connection came from, such as a Wikipedia section or an AI relation phrase. */
  note?: string;
}

export function wikipediaConnectionKind(propertyId: string): PublicTopicConnection["kind"] {
  return propertyId === "wikipedia-broader" ? "broader" : propertyId === "wikipedia-see-also" ? "related" : "narrower";
}

function connected(state: AppState, a: string, b: string) {
  const first = state.conversations[a], second = state.conversations[b];
  return !!first.linkedConversationIds?.includes(b) || !!second.linkedConversationIds?.includes(a)
    || !!first.relations?.some((relation) => relation.targetConversationId === b)
    || !!second.relations?.some((relation) => relation.targetConversationId === a)
    || first.parentId === b || second.parentId === a;
}

function addRelation(state: AppState, ownerId: string, relation: DocumentRelation): AppState {
  const owner = state.conversations[ownerId];
  return { ...state, conversations: { ...state.conversations, [ownerId]: { ...owner, relations: [...owner.relations ?? [], relation], updatedAt: relation.createdAt ?? owner.updatedAt } } };
}

/**
 * Saves each topic as a note in My map (reusing notes already saved for it)
 * and connects it to the source note as a typed relation in Markdown
 * frontmatter. Topics already connected to the source are left alone.
 * Returns the new state and how many connections were added.
 */
export function connectPublicTopics(state: AppState, sourceId: string, connections: PublicTopicConnection[], options: { createdAt: string; origin: DocumentRelationOrigin }): { state: AppState; added: number } {
  if (!state.conversations[sourceId]) return { state, added: 0 };
  let next = state, added = 0;
  for (const connection of connections) {
    let saved: ReturnType<typeof savePublicTopic>;
    try { saved = savePublicTopic(next, connection.topic); } catch { continue; }
    const targetId = saved.conversationId;
    if (targetId === sourceId || (!saved.created && connected(saved.state, sourceId, targetId))) continue;
    next = saved.state;
    const base = { origin: options.origin, createdAt: options.createdAt, ...(connection.note ? { note: connection.note.slice(0, 200) } : {}) };
    if (connection.kind === "broader") next = addRelation(next, sourceId, { ...base, type: "part-of", targetConversationId: targetId });
    else if (connection.kind === "narrower") next = addRelation(next, targetId, { ...base, type: "elaborates", targetConversationId: sourceId });
    else next = setPersonalMapConnection(next, sourceId, targetId, true, options.createdAt);
    added += 1;
  }
  return { state: next, added };
}
