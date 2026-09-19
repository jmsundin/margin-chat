import type { AppState, Conversation, Message } from "../types";
import { buildBranchGraphNodeLayout, buildRootGraphNodeLayout, normalizeGraphLayouts } from "./graphLayout";
import { assignConversationToGroup, getConversationGroupId, removeConversationsFromGroups } from "./conversationGroups";
import { buildThreadSummaries } from "./conversationSearch";
import { collectConversationTreeIds, getConversationRootId } from "./tree";
import { upsertStandaloneNoteContextMessage } from "./standaloneNotes";

/** Commands receive identities/timestamps from the caller and have no UI side effects. */
export function addRootConversation(state: AppState, conversation: Conversation): AppState {
  if (conversation.parentId !== null || state.conversations[conversation.id]) return state;
  return {
    ...state,
    activeConversationId: conversation.id,
    rootId: conversation.id,
    conversations: { ...state.conversations, [conversation.id]: conversation },
    graphLayouts: {
      ...state.graphLayouts,
      [conversation.id]: buildRootGraphNodeLayout(state.conversations, normalizeGraphLayouts(state.conversations, state.graphLayouts)),
    },
  };
}

export function addChildConversation(state: AppState, child: Conversation, options: {
  activate?: boolean;
  groupSourceId?: string;
  sourceNoteId?: string;
} = {}): AppState {
  const parent = child.parentId ? state.conversations[child.parentId] : null;
  if (!parent || state.conversations[child.id]) return state;
  const note = options.sourceNoteId
    ? parent.notes?.find((item) => item.id === options.sourceNoteId && item.kind === "standalone")
    : undefined;
  const groupId = getConversationGroupId(state.groups, options.groupSourceId ?? parent.id);
  return {
    ...state,
    ...(options.activate ? {
      activeConversationId: child.id,
      railOpen: false,
      rootId: getConversationRootId(state.conversations, parent.id) ?? state.rootId,
    } : {}),
    conversations: {
      ...state.conversations,
      [parent.id]: {
        ...parent,
        childIds: [...parent.childIds, child.id],
        messages: note ? upsertStandaloneNoteContextMessage(parent.messages, note, child.createdAt) : parent.messages,
        updatedAt: child.createdAt,
      },
      [child.id]: parent.grouping === "manual" ? { ...child, grouping: "manual" } : child,
    },
    graphLayouts: {
      ...state.graphLayouts,
      [child.id]: buildBranchGraphNodeLayout({
        conversations: state.conversations,
        graphLayouts: normalizeGraphLayouts(state.conversations, state.graphLayouts),
        parentConversationId: parent.id,
      }),
    },
    groups: groupId ? assignConversationToGroup(state.groups, child.id, groupId) : state.groups,
  };
}

export function deleteThread(state: AppState, id: string, replacement: Conversation): AppState {
  if (!state.conversations[id] || state.conversations[id].parentId !== null) return state;
  const removed = new Set(collectConversationTreeIds(state.conversations, id));
  const conversations = Object.fromEntries(Object.entries(state.conversations).filter(([key]) => !removed.has(key)));
  const graphLayouts = Object.fromEntries(Object.entries(state.graphLayouts).filter(([key]) => !removed.has(key)));
  // Decide against the latest state, including threads created since deletion was requested.
  if (!Object.keys(conversations).length) {
    conversations[replacement.id] = replacement;
    graphLayouts[replacement.id] = buildRootGraphNodeLayout(conversations, graphLayouts);
  }
  const fallback = buildThreadSummaries(conversations)[0]?.id ?? replacement.id;
  return {
    ...state,
    conversations,
    graphLayouts,
    rootId: removed.has(state.rootId) ? fallback : state.rootId,
    activeConversationId: removed.has(state.activeConversationId) ? fallback : state.activeConversationId,
    pinnedThreadIds: state.pinnedThreadIds.filter((key) => !removed.has(key)),
    groups: removeConversationsFromGroups(state.groups, removed),
  };
}

export function appendMessage(state: AppState, conversationId: string, message: Message): AppState {
  const conversation = state.conversations[conversationId];
  if (!conversation) return state;
  return { ...state, conversations: { ...state.conversations, [conversationId]: {
    ...conversation, messages: [...conversation.messages, message], updatedAt: message.createdAt,
  } } };
}

/** Detaching an attachment must not delete its original or another chat's reference. */
export function removeConversationDocument(state: AppState, conversationId: string, documentId: string, updatedAt: string): AppState {
  const conversation = state.conversations[conversationId];
  if (!conversation?.documents?.some((document) => document.id === documentId)) return state;
  return {
    ...state,
    conversations: {
      ...state.conversations,
      [conversationId]: {
        ...conversation,
        documents: conversation.documents.filter((document) => document.id !== documentId),
        updatedAt,
      },
    },
  };
}

export function appendMessageDelta(state: AppState, conversationId: string, messageId: string, delta: string, createdAt: string): AppState {
  const conversation = state.conversations[conversationId];
  if (!conversation || !delta) return state;
  const index = conversation.messages.findIndex((message) => message.id === messageId);
  if (index < 0) return appendMessage(state, conversationId, { id: messageId, role: "assistant", content: delta, createdAt });
  const messages = [...conversation.messages];
  messages[index] = { ...messages[index], content: messages[index].content + delta };
  return { ...state, conversations: { ...state.conversations, [conversationId]: { ...conversation, messages, updatedAt: createdAt } } };
}
