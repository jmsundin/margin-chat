import { DEFAULT_BACKEND_SERVICE_ID } from "./lib/services";
import type { AppState, Conversation } from "./types";

export const DEFAULT_MAIN_CHAT_TITLE = "New chat";

export function createMainConversation({
  createdAt = new Date().toISOString(),
  id = "conversation-root",
}: {
  createdAt?: string;
  id?: string;
} = {}): Conversation {
  return {
    id,
    title: DEFAULT_MAIN_CHAT_TITLE,
    parentId: null,
    serviceId: DEFAULT_BACKEND_SERVICE_ID,
    branchAnchor: null,
    childIds: [],
    messages: [],
    createdAt,
    updatedAt: createdAt,
  };
}

export function createEmptyState(): AppState {
  const rootConversation = createMainConversation();

  return {
    rootId: rootConversation.id,
    activeConversationId: rootConversation.id,
    railOpen: false,
    pinnedThreadIds: [],
    conversations: {
      [rootConversation.id]: rootConversation,
    },
  };
}
