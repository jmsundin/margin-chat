import { normalizeAISettings, normalizeAIExecution } from "./ai.mjs";
export const WORKSPACE_DOCUMENT_SCHEMA_VERSION = 2;

// Format-level defaults for standalone Markdown imported without a manifest.
export const DEFAULT_WORKSPACE_PREFERENCES = Object.freeze({
  defaultServiceId: "backend-services",
  defaultModelId: "smart-routing",
});

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate the document envelope; persistence validates individual domain fields. */
export function parseWorkspaceDocument(input) {
  if (!isRecord(input) || input.schemaVersion !== WORKSPACE_DOCUMENT_SCHEMA_VERSION ||
      !isRecord(input.items) || !isRecord(input.annotations) ||
      !isRecord(input.preferences) || !isRecord(input.view)) return null;
  return input;
}

export function createWorkspaceDocument(state) {
  const items = {};
  const annotations = {};

  for (const conversation of Object.values(state.conversations)) {
    const {
      childIds: _childIds,
      kind: conversationKind,
      notes = [],
      ...base
    } = conversation;
    const primaryNote =
      conversationKind === "note"
        ? notes.find((note) => note.kind === "standalone") ?? null
        : null;

    items[conversation.id] =
      conversationKind === "note" && primaryNote
        ? {
            ...base,
            content: primaryNote.content,
            documents: base.documents ?? [],
            kind: "note",
            noteCreatedAt: primaryNote.createdAt,
            noteId: primaryNote.id,
            noteSortOrder: notes.indexOf(primaryNote),
            noteUpdatedAt: primaryNote.updatedAt,
          }
        : {
            ...base,
            documents: base.documents ?? [],
            kind: "chat",
          };

    for (const [sortOrder, note] of notes.entries()) {
      if (note === primaryNote) continue;
      annotations[note.id] = {
        ...note,
        kind: note.kind === "side-chat" ? "side-chat" : "comment",
        parentId: conversation.id,
        sortOrder,
      };
    }
  }

  return {
    annotations,
    items,
    preferences: {
      defaultModelId: state.defaultModelId,
      defaultServiceId: state.defaultServiceId,
    },
    schemaVersion: WORKSPACE_DOCUMENT_SCHEMA_VERSION,
    view: {
      activeItemId: state.activeConversationId,
      activeRootId: state.rootId,
      graphLayouts: state.graphLayouts,
      groups: state.groups,
      pinnedItemIds: state.pinnedThreadIds,
      railOpen: state.railOpen,
    },
  };
}

/**
 * Strict reads reject orphan annotations, so server writes cannot silently drop them.
 * Recovery reads skip them and reject empty legacy snapshots, retaining the browser's
 * fallback behavior. Markdown discovery has its own empty-vault semantics.
 * Both modes validate identities/kinds and apply the same optional-field defaults.
 */
export function createAppStateFromWorkspaceDocument(input, { mode = "strict" } = {}) {
  if (mode !== "strict" && mode !== "recovery") return null;
  const document = parseWorkspaceDocument(input);
  if (!document) return null;
  try {
    return readWorkspaceDocument(document, mode);
  } catch {
    // Malformed persisted data must not bypass the caller's invalid-document path.
    return null;
  }
}

function readWorkspaceDocument(input, mode) {
  const conversations = Object.create(null);
  const noteEntriesByParent = new Map();

  for (const [itemId, item] of Object.entries(input.items)) {
    if (!isRecord(item) || item.id !== itemId) return null;
    if (item.kind !== "chat" && item.kind !== "note") return null;

    conversations[itemId] = {
      branchAnchor: item.branchAnchor ?? null,
      childIds: [],
      createdAt: item.createdAt,
      documents: item.documents ?? [],
      id: item.id,
      kind: item.kind,
      messages: (item.messages ?? []).map((message) => ({ ...message,
        ...(message.execution ? { execution: normalizeAIExecution(message.execution) } : {}),
      })),
      modelId: item.modelId,
      ...(item.ai ? { ai: normalizeAISettings(item.ai) } : {}),
      notes: [],
      parentId: item.parentId ?? null,
      serviceId: item.serviceId,
      title: item.title,
      updatedAt: item.updatedAt,
    };

    if (item.kind === "note") {
      noteEntriesByParent.set(itemId, [
        {
          note: {
            content: item.content ?? "",
            createdAt: item.noteCreatedAt ?? item.createdAt,
            endOffset: null,
            id: item.noteId,
            kind: "standalone",
            quote: null,
            sourceMessageId: null,
            startOffset: null,
            updatedAt: item.noteUpdatedAt ?? item.updatedAt,
          },
          sortOrder: Number.isInteger(item.noteSortOrder)
            ? item.noteSortOrder
            : 0,
        },
      ]);
    }
  }

  for (const [annotationId, annotation] of Object.entries(input.annotations)) {
    if (!isRecord(annotation) || annotation.id !== annotationId) return null;
    if (!Object.hasOwn(conversations, annotation.parentId)) {
      if (mode === "strict") return null;
      continue;
    }

    const { parentId, sortOrder, ...note } = annotation;
    const bucket = noteEntriesByParent.get(parentId) ?? [];
    bucket.push({
      note,
      sortOrder: Number.isInteger(sortOrder) ? sortOrder : bucket.length,
    });
    noteEntriesByParent.set(parentId, bucket);
  }

  for (const conversation of Object.values(conversations)) {
    conversation.notes = (noteEntriesByParent.get(conversation.id) ?? [])
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .map(({ note }) => note);

    if (conversation.parentId && conversations[conversation.parentId]) {
      conversations[conversation.parentId].childIds.push(conversation.id);
    }
  }

  for (const conversation of Object.values(conversations)) {
    conversation.childIds.sort((left, right) =>
      conversations[left].createdAt.localeCompare(conversations[right].createdAt),
    );
  }

  if (mode === "recovery" && !Object.keys(conversations).length) return null;

  return {
    activeConversationId: input.view.activeItemId,
    conversations: { ...conversations },
    defaultModelId: input.preferences.defaultModelId,
    defaultServiceId: input.preferences.defaultServiceId,
    graphLayouts: input.view.graphLayouts ?? {},
    groups: input.view.groups ?? {},
    pinnedThreadIds: input.view.pinnedItemIds ?? [],
    railOpen: Boolean(input.view.railOpen),
    rootId: input.view.activeRootId,
  };
}

export function createWorkspaceDocumentMetadata(state) {
  const { annotations: _annotations, items: _items, ...metadata } = createWorkspaceDocument(state);
  return metadata;
}
export function createAppStateFromWorkspaceMetadata(metadata, conversations) {
  return {
    activeConversationId: metadata.view.activeItemId,
    conversations,
    defaultModelId: metadata.preferences.defaultModelId,
    defaultServiceId: metadata.preferences.defaultServiceId,
    graphLayouts: metadata.view.graphLayouts,
    groups: metadata.view.groups,
    pinnedThreadIds: metadata.view.pinnedItemIds,
    railOpen: metadata.view.railOpen,
    rootId: metadata.view.activeRootId
  };
}
