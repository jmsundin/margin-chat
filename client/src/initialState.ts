import {
  DEFAULT_BACKEND_SERVICE_ID,
  getDefaultModelIdForService,
  resolveBackendServiceModelId,
} from "./lib/services";
import type { AppState, BackendServiceId, Conversation } from "./types";

export const DEFAULT_MAIN_CHAT_TITLE = "New chat";

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
    title: DEFAULT_MAIN_CHAT_TITLE,
    parentId: null,
    serviceId,
    modelId: resolveBackendServiceModelId(serviceId, modelId),
    branchAnchor: null,
    childIds: [],
    messages: [],
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
    railOpen: false,
    pinnedThreadIds: [],
    conversations: {
      [rootConversation.id]: rootConversation,
    },
  };
}
