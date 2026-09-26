import type { AppState, Conversation, Message } from "../types";
import { normalizeDocumentDock } from "@margin-chat/workspace-contracts";
import { buildBranchGraphNodeLayout, buildRootGraphNodeLayout, normalizeGraphLayouts } from "./graphLayout";
import { assignConversationToGroup, getConversationGroupId, removeConversationsFromGroups } from "./conversationGroups";
import { buildThreadSummaries } from "./conversationSearch";
import { collectConversationTreeIds, getConversationRootId } from "./tree";
import { upsertStandaloneNoteContextMessage } from "./standaloneNotes";
import { focusDocument, placeNewSideDocument } from "./documentWorkspace";

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
  return placeNewSideDocument({
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
  }, child.id);
}

export function deleteThread(state: AppState, id: string, replacement: Conversation): AppState {
  if (!state.conversations[id]) return state;
  const removed = new Set(collectConversationTreeIds(state.conversations, id));
  const conversations = Object.fromEntries(Object.entries(state.conversations).filter(([key]) => !removed.has(key)));
  for (const [key, conversation] of Object.entries(conversations)) {
    const childIds = conversation.childIds.filter((childId) => !removed.has(childId));
    const linkedConversationIds = conversation.linkedConversationIds?.filter((linkedId) => !removed.has(linkedId));
    const widthsById = Object.fromEntries(Object.entries(conversation.documentLayout?.widthsById ?? {})
      .filter(([documentId]) => !removed.has(documentId)));
    const documentLayout = conversation.documentLayout && {
      order: conversation.documentLayout.order.filter((documentId) => !removed.has(documentId)),
      minimizedIds: conversation.documentLayout.minimizedIds.filter((documentId) => !removed.has(documentId)),
      ...(Object.keys(widthsById).length ? { widthsById } : {}),
    };
    const layoutChanged = documentLayout && (
      documentLayout.order.length !== conversation.documentLayout!.order.length ||
      documentLayout.minimizedIds.length !== conversation.documentLayout!.minimizedIds.length ||
      Object.keys(widthsById).length !== Object.keys(conversation.documentLayout!.widthsById ?? {}).length
    );
    if (childIds.length !== conversation.childIds.length || layoutChanged ||
      linkedConversationIds?.length !== conversation.linkedConversationIds?.length) {
      conversations[key] = { ...conversation, childIds,
        ...(linkedConversationIds ? { linkedConversationIds } : {}),
        ...(documentLayout ? { documentLayout } : {}),
      };
    }
  }
  const graphLayouts = Object.fromEntries(Object.entries(state.graphLayouts).filter(([key]) => !removed.has(key)));
  // Decide against the latest state, including threads created since deletion was requested.
  if (!Object.keys(conversations).length) {
    conversations[replacement.id] = replacement;
    graphLayouts[replacement.id] = buildRootGraphNodeLayout(conversations, graphLayouts);
  }
  const parentId = state.conversations[id].parentId;
  const fallback = (parentId && conversations[parentId] ? parentId : null)
    ?? buildThreadSummaries(conversations)[0]?.id ?? replacement.id;
  const next = {
    ...state,
    ...(state.documentDock ? { documentDock: normalizeDocumentDock(state.documentDock, conversations) } : {}),
    conversations,
    graphLayouts,
    rootId: removed.has(state.rootId) ? getConversationRootId(conversations, fallback) ?? fallback : state.rootId,
    activeConversationId: removed.has(state.activeConversationId) ? fallback : state.activeConversationId,
    pinnedThreadIds: state.pinnedThreadIds.filter((key) => !removed.has(key)),
    groups: removeConversationsFromGroups(state.groups, removed),
  };
  return removed.has(state.activeConversationId) ? focusDocument(next, fallback) : next;
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
