import {
  DEFAULT_BACKEND_SERVICE_ID,
  getDefaultModelIdForService,
  resolveBackendServiceModelId,
} from "./lib/services";
import { createDefaultGraphNodeLayout } from "./lib/graphLayout";
import type { AppState, BackendServiceId, Conversation } from "./types";

export const DEFAULT_MAIN_CHAT_TITLE = "New chat";
export const DEFAULT_SIDE_CHAT_TITLE = "Side chat";
export const DEFAULT_CHILD_CHAT_TITLE = "New child chat";
export const DEFAULT_STANDALONE_NOTE_TITLE = "Untitled note";

export function createMainConversation({
  createdAt = new Date().toISOString(),
  id = "conversation-root",
  modelId = getDefaultModelIdForService(DEFAULT_BACKEND_SERVICE_ID),
  serviceId = DEFAULT_BACKEND_SERVICE_ID,
}: {
  createdAt?: string;
  id?: string;
  modelId?: string;
  serviceId?: BackendServiceId;
} = {}): Conversation {
  return {
    id,
    kind: "chat",
    title: DEFAULT_MAIN_CHAT_TITLE,
    parentId: null,
    serviceId,
    modelId: resolveBackendServiceModelId(serviceId, modelId),
    branchAnchor: null,
    childIds: [],
    messages: [],
    notes: [],
    createdAt,
    updatedAt: createdAt,
  };
}

export function createSideConversation({
  createdAt = new Date().toISOString(),
  id,
  sourceConversation,
}: {
  createdAt?: string;
  id: string;
  sourceConversation: Conversation;
}): Conversation {
  return {
    id,
    kind: "chat",
    title: DEFAULT_SIDE_CHAT_TITLE,
    parentId: sourceConversation.parentId ?? sourceConversation.id,
    serviceId: sourceConversation.serviceId,
    modelId: sourceConversation.modelId,
    branchAnchor: null,
    childIds: [],
    messages: [],
    notes: [],
    createdAt,
    updatedAt: createdAt,
  };
}

export function createChildConversation({
  createdAt = new Date().toISOString(),
  id,
  parentConversation,
}: {
  createdAt?: string;
  id: string;
  parentConversation: Conversation;
}): Conversation {
  return {
    id,
    kind: "chat",
    title: DEFAULT_CHILD_CHAT_TITLE,
    parentId: parentConversation.id,
    serviceId: parentConversation.serviceId,
    modelId: parentConversation.modelId,
    branchAnchor: null,
    childIds: [],
    messages: [],
    notes: [],
    createdAt,
    updatedAt: createdAt,
  };
}

export function createStandaloneNoteConversation({
  createdAt = new Date().toISOString(),
  id,
  modelId = getDefaultModelIdForService(DEFAULT_BACKEND_SERVICE_ID),
  noteId,
  serviceId = DEFAULT_BACKEND_SERVICE_ID,
}: {
  createdAt?: string;
  id: string;
  modelId?: string;
  noteId: string;
  serviceId?: BackendServiceId;
}): Conversation {
  return {
    id,
    kind: "note",
    title: DEFAULT_STANDALONE_NOTE_TITLE,
    parentId: null,
    serviceId,
    modelId: resolveBackendServiceModelId(serviceId, modelId),
    branchAnchor: null,
    childIds: [],
    messages: [],
    notes: [
      {
        id: noteId,
        content: "",
        kind: "standalone",
        sourceMessageId: null,
        startOffset: null,
        endOffset: null,
        quote: null,
        createdAt,
        updatedAt: createdAt,
      },
    ],
    createdAt,
    updatedAt: createdAt,
  };
}

export function createEmptyState(): AppState {
  const defaultServiceId = DEFAULT_BACKEND_SERVICE_ID;
  const defaultModelId = getDefaultModelIdForService(defaultServiceId);
  const rootConversation = createMainConversation({
    modelId: defaultModelId,
    serviceId: defaultServiceId,
  });

  return {
    rootId: rootConversation.id,
    activeConversationId: rootConversation.id,
    defaultServiceId,
    defaultModelId,
    graphLayouts: {
      [rootConversation.id]: createDefaultGraphNodeLayout(),
    },
    groups: {},
    railOpen: false,
    pinnedThreadIds: [],
    conversations: {
      [rootConversation.id]: rootConversation,
    },
  };
}
