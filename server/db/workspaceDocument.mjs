export const WORKSPACE_DOCUMENT_SCHEMA_VERSION = 2;

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

export function createAppStateFromWorkspaceDocument(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    input.schemaVersion !== WORKSPACE_DOCUMENT_SCHEMA_VERSION ||
    !input.items ||
    typeof input.items !== "object" ||
    Array.isArray(input.items) ||
    !input.annotations ||
    typeof input.annotations !== "object" ||
    Array.isArray(input.annotations) ||
    !input.preferences ||
    typeof input.preferences !== "object" ||
    !input.view ||
    typeof input.view !== "object"
  ) {
    return null;
  }

  const conversations = {};
  const noteEntriesByParent = new Map();

  for (const [itemId, item] of Object.entries(input.items)) {
    if (!item || typeof item !== "object" || item.id !== itemId) return null;
    if (item.kind !== "chat" && item.kind !== "note") return null;

    conversations[itemId] = {
      branchAnchor: item.branchAnchor ?? null,
      childIds: [],
      createdAt: item.createdAt,
      documents: item.documents ?? [],
      id: item.id,
      kind: item.kind,
      messages: item.messages ?? [],
      modelId: item.modelId,
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
    if (
      !annotation ||
      typeof annotation !== "object" ||
      annotation.id !== annotationId ||
      !conversations[annotation.parentId]
    ) {
      return null;
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

  return {
    activeConversationId: input.view.activeItemId,
    conversations,
    defaultModelId: input.preferences.defaultModelId,
    defaultServiceId: input.preferences.defaultServiceId,
    graphLayouts: input.view.graphLayouts ?? {},
    groups: input.view.groups ?? {},
    pinnedThreadIds: input.view.pinnedItemIds ?? [],
    railOpen: Boolean(input.view.railOpen),
    rootId: input.view.activeRootId,
  };
}
