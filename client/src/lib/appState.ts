import { createEmptyState } from "../initialState";
import { normalizeAISettings, normalizeAIExecution, normalizePublicTopicSource, normalizeLinkedConversationIds, normalizeEditableDocument, normalizeDocumentLayout, normalizeDocumentDock } from "@margin-chat/workspace-contracts";
import type { AppState, Conversation } from "../types";
import { normalizeConversationGroups } from "./conversationGroups";
import { normalizeGraphLayouts } from "./graphLayout";
import { sanitizePinnedThreadIds } from "./pinnedThreads";
import {
  DEFAULT_BACKEND_SERVICE_ID,
  getDefaultModelIdForService,
  isBackendServiceId,
  resolveBackendServiceModelId,
  sanitizeRecentBackendServiceSelections,
  type RecentBackendServiceSelection,
} from "./services";
import {
  deriveChildIds,
  getConversationRootId,
  getRootConversations,
} from "./tree";

const STORAGE_KEY = "margin-chat-state";
const STORAGE_SAVED_AT_KEY = "margin-chat-state-saved-at";
const RECENT_MODEL_SELECTIONS_STORAGE_KEY =
  "margin-chat-recent-model-selections";

function resolvePersistedDefaultSelection(args: {
  activeConversationId?: string;
  conversations: Record<string, Conversation>;
  defaultModelId?: unknown;
  defaultServiceId?: unknown;
  rootId?: string;
}): Pick<AppState, "defaultModelId" | "defaultServiceId"> {
  const fallbackConversation =
    (typeof args.activeConversationId === "string"
      ? args.conversations[args.activeConversationId]
      : null) ??
    (typeof args.rootId === "string"
      ? args.conversations[args.rootId]
      : null) ??
    getRootConversations(args.conversations)[0] ??
    Object.values(args.conversations)[0] ??
    null;
  const defaultServiceId = isBackendServiceId(args.defaultServiceId)
    ? args.defaultServiceId
    : (fallbackConversation?.serviceId ?? DEFAULT_BACKEND_SERVICE_ID);
  const fallbackModelId =
    fallbackConversation?.serviceId === defaultServiceId
      ? fallbackConversation.modelId
      : getDefaultModelIdForService(defaultServiceId);
  const requestedModelId =
    typeof args.defaultModelId === "string" && args.defaultModelId.trim()
      ? args.defaultModelId
      : fallbackModelId;

  return {
    defaultModelId: resolveBackendServiceModelId(
      defaultServiceId,
      requestedModelId,
    ),
    defaultServiceId,
  };
}

export function hydratePersistedState(input: unknown): AppState | null {
  try {
    if (!input || typeof input !== "object" || !("conversations" in input)) {
      return null;
    }

    const parsed = input as Partial<AppState> & {
      conversations: Record<string, Conversation>;
    };

    if (
      !parsed.conversations ||
      typeof parsed.conversations !== "object" ||
      Array.isArray(parsed.conversations)
    ) {
      return null;
    }

    const conversations = deriveChildIds(
      Object.fromEntries(
        Object.entries(parsed.conversations).map(
          ([conversationId, conversation]) => [
            conversationId,
            (() => {
              const serviceId = isBackendServiceId(conversation.serviceId)
                ? conversation.serviceId
                : DEFAULT_BACKEND_SERVICE_ID;
              const { publicTopic, linkedConversationIds, document, documentLayout, ...base } = conversation;
              const source = normalizePublicTopicSource(publicTopic);
              const layout = normalizeDocumentLayout(documentLayout, conversationId, parsed.conversations);
              const editableDocument = document === undefined ? undefined : normalizeEditableDocument(document);
              if (document !== undefined && !editableDocument) throw new Error("Invalid editable document.");

              return {
                ...base,
                ...(editableDocument ? { document: editableDocument } : {}),
                ...(layout ? { documentLayout: layout } : {}),
                ...(source ? { publicTopic: source } : {}),
                ...(Array.isArray(linkedConversationIds) ? { linkedConversationIds: normalizeLinkedConversationIds(linkedConversationIds, conversationId, parsed.conversations) } : {}),
                ...(conversation.ai ? { ai: normalizeAISettings(conversation.ai) } : {}),
                messages: (conversation.messages ?? []).map((message) => ({ ...message,
                  ...(message.execution ? { execution: normalizeAIExecution(message.execution) } : {}),
                })),
                documents: Array.isArray(conversation.documents)
                  ? conversation.documents
                  : [],
                kind: conversation.kind === "note" ? "note" : "chat",
                notes: Array.isArray(conversation.notes)
                  ? conversation.notes.map((note) => ({
                      ...note,
                      kind:
                        note.kind === "side-chat" || note.kind === "standalone"
                          ? note.kind
                          : "comment",
                    }))
                  : [],
                modelId: resolveBackendServiceModelId(
                  serviceId,
                  conversation.modelId,
                ),
                serviceId,
              };
            })(),
          ],
        ),
      ),
    );
    const rootConversations = getRootConversations(conversations);

    if (!rootConversations.length) {
      return null;
    }

    const nextActiveConversationId =
      parsed.activeConversationId && conversations[parsed.activeConversationId]
        ? parsed.activeConversationId
        : rootConversations[0].id;
    const nextRootId =
      getConversationRootId(conversations, nextActiveConversationId) ??
      rootConversations[0].id;
    const { defaultModelId, defaultServiceId } =
      resolvePersistedDefaultSelection({
        activeConversationId: nextActiveConversationId,
        conversations,
        defaultModelId: parsed.defaultModelId,
        defaultServiceId: parsed.defaultServiceId,
        rootId: nextRootId,
      });

    const documentDock = normalizeDocumentDock(parsed.documentDock, conversations);
    return {
      activeConversationId: nextActiveConversationId,
      ...(documentDock ? { documentDock } : {}),
      conversations,
      defaultModelId,
      defaultServiceId,
      graphLayouts: normalizeGraphLayouts(conversations, parsed.graphLayouts),
      groups: normalizeConversationGroups(parsed.groups, conversations),
      pinnedThreadIds: sanitizePinnedThreadIds(
        parsed.pinnedThreadIds,
        conversations,
      ),
      railOpen: false,
      rootId: nextRootId,
    };
  } catch {
    return null;
  }
}

export function getStateStorageKey(userId: string) {
  return `${STORAGE_KEY}:${userId}`;
}

export function getStateSavedAtStorageKey(userId: string) {
  return `${STORAGE_SAVED_AT_KEY}:${userId}`;
}

export function loadLastFocusedDocument(userId: string): string | null {
  try {
    return window.localStorage.getItem(`margin-chat-last-focused-document:${userId}`) || null;
  } catch {
    return null;
  }
}

export function saveLastFocusedDocument(userId: string, conversationId: string) {
  try {
    window.localStorage.setItem(`margin-chat-last-focused-document:${userId}`, conversationId);
  } catch {
    // Unavailable browser preferences must not prevent opening or saving documents.
  }
}

export function getRecentModelSelectionsStorageKey(userId: string) {
  return `${RECENT_MODEL_SELECTIONS_STORAGE_KEY}:${userId}`;
}

export function loadStoredState(
  storageKey: string,
  savedAtStorageKey: string,
): { hasStoredState: boolean; savedAt: string | null; state: AppState } {
  const fallback = createEmptyState();

  if (typeof window === "undefined") {
    return { hasStoredState: false, savedAt: null, state: fallback };
  }

  try {
    const storedValue = window.localStorage.getItem(storageKey);

    if (!storedValue) {
      return { hasStoredState: false, savedAt: null, state: fallback };
    }

    const hydratedState = hydratePersistedState(JSON.parse(storedValue));

    if (!hydratedState) {
      return { hasStoredState: false, savedAt: null, state: fallback };
    }

    const savedAt = window.localStorage.getItem(savedAtStorageKey);

    return {
      hasStoredState: true,
      savedAt: savedAt && !Number.isNaN(Date.parse(savedAt)) ? savedAt : null,
      state: hydratedState,
    };
  } catch {
    return { hasStoredState: false, savedAt: null, state: fallback };
  }
}

export function loadRecentModelSelections(
  storageKey: string,
): RecentBackendServiceSelection[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const storedValue = window.localStorage.getItem(storageKey);

    if (!storedValue) {
      return [];
    }

    return sanitizeRecentBackendServiceSelections(JSON.parse(storedValue));
  } catch {
    return [];
  }
}
