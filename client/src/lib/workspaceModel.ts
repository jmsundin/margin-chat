import type {
  AppState,
  BranchAnchor,
  Conversation,
  ConversationDocument,
  ConversationGroup,
  ConversationNote,
  GraphNodeLayout,
  Message,
} from "../types";

export const WORKSPACE_DOCUMENT_SCHEMA_VERSION = 2;

interface WorkspaceItemBase {
  branchAnchor: BranchAnchor | null;
  createdAt: string;
  documents: ConversationDocument[];
  id: string;
  messages: Message[];
  modelId: Conversation["modelId"];
  parentId: string | null;
  serviceId: Conversation["serviceId"];
  title: string;
  updatedAt: string;
}

export interface WorkspaceChatItem extends WorkspaceItemBase {
  kind: "chat";
}

export interface WorkspaceNoteItem extends WorkspaceItemBase {
  content: string;
  kind: "note";
  noteCreatedAt: string;
  noteId: string;
  noteSortOrder: number;
  noteUpdatedAt: string;
}

export type WorkspaceItem = WorkspaceChatItem | WorkspaceNoteItem;

export interface WorkspaceAnnotation extends ConversationNote {
  parentId: string;
  sortOrder: number;
}

export interface WorkspaceDocument {
  annotations: Record<string, WorkspaceAnnotation>;
  items: Record<string, WorkspaceItem>;
  preferences: {
    defaultModelId: AppState["defaultModelId"];
    defaultServiceId: AppState["defaultServiceId"];
  };
  schemaVersion: number;
  view: {
    activeItemId: string;
    activeRootId: string;
    graphLayouts: Record<string, GraphNodeLayout>;
    groups: Record<string, ConversationGroup>;
    pinnedItemIds: string[];
    railOpen: boolean;
  };
}

export type WorkspaceDocumentMetadata = Pick<
  WorkspaceDocument,
  "preferences" | "schemaVersion" | "view"
>;

export function createWorkspaceDocument(state: AppState): WorkspaceDocument {
  const items: Record<string, WorkspaceItem> = {};
  const annotations: Record<string, WorkspaceAnnotation> = {};

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

export function parseWorkspaceDocument(input: unknown): WorkspaceDocument | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const candidate = input as Partial<WorkspaceDocument>;

  if (
    candidate.schemaVersion !== WORKSPACE_DOCUMENT_SCHEMA_VERSION ||
    !candidate.items ||
    typeof candidate.items !== "object" ||
    Array.isArray(candidate.items) ||
    !candidate.annotations ||
    typeof candidate.annotations !== "object" ||
    Array.isArray(candidate.annotations) ||
    !candidate.preferences ||
    typeof candidate.preferences !== "object" ||
    !candidate.view ||
    typeof candidate.view !== "object"
  ) {
    return null;
  }

  return candidate as WorkspaceDocument;
}

export function createAppStateFromWorkspaceDocument(
  document: WorkspaceDocument,
): AppState | null {
  try {
    const conversations: Record<string, Conversation> = {};

    for (const [itemId, item] of Object.entries(document.items)) {
      if (!item || item.id !== itemId) return null;

      const notes: ConversationNote[] = [];
      if (item.kind === "note") {
        notes.push({
          content: item.content,
          createdAt: item.noteCreatedAt,
          endOffset: null,
          id: item.noteId,
          kind: "standalone",
          quote: null,
          sourceMessageId: null,
          startOffset: null,
          updatedAt: item.noteUpdatedAt,
        });
      }

      conversations[itemId] = {
        branchAnchor: item.branchAnchor,
        childIds: [],
        createdAt: item.createdAt,
        documents: item.documents ?? [],
        id: item.id,
        kind: item.kind,
        messages: item.messages ?? [],
        modelId: item.modelId,
        notes,
        parentId: item.parentId,
        serviceId: item.serviceId,
        title: item.title,
        updatedAt: item.updatedAt,
      };
    }

    const annotationsByParent = new Map<
      string,
      Array<{ note: ConversationNote; sortOrder: number }>
    >();
    for (const item of Object.values(document.items)) {
      if (item.kind !== "note") continue;
      const primaryNote = conversations[item.id]?.notes?.[0];
      if (!primaryNote) continue;
      annotationsByParent.set(item.id, [
        { note: primaryNote, sortOrder: item.noteSortOrder ?? 0 },
      ]);
      conversations[item.id].notes = [];
    }
    for (const [annotationId, annotation] of Object.entries(
      document.annotations,
    )) {
      if (!annotation || annotation.id !== annotationId) return null;
      if (!conversations[annotation.parentId]) continue;

      const { parentId, sortOrder, ...note } = annotation;
      const bucket = annotationsByParent.get(parentId) ?? [];
      bucket.push({ note, sortOrder });
      annotationsByParent.set(parentId, bucket);
    }

    for (const conversation of Object.values(conversations)) {
      const annotations = (annotationsByParent.get(conversation.id) ?? [])
        .sort((left, right) => left.sortOrder - right.sortOrder)
        .map(({ note }) => note);
      conversation.notes = annotations;

      if (conversation.parentId && conversations[conversation.parentId]) {
        conversations[conversation.parentId].childIds.push(conversation.id);
      }
    }

    for (const conversation of Object.values(conversations)) {
      conversation.childIds.sort((left, right) =>
        conversations[left].createdAt.localeCompare(conversations[right].createdAt),
      );
    }

    if (!Object.keys(conversations).length) return null;

    return {
      activeConversationId: document.view.activeItemId,
      conversations,
      defaultModelId: document.preferences.defaultModelId,
      defaultServiceId: document.preferences.defaultServiceId,
      graphLayouts: document.view.graphLayouts ?? {},
      groups: document.view.groups ?? {},
      pinnedThreadIds: document.view.pinnedItemIds ?? [],
      railOpen: Boolean(document.view.railOpen),
      rootId: document.view.activeRootId,
    };
  } catch {
    return null;
  }
}

export function createWorkspaceDocumentMetadata(
  state: AppState,
): WorkspaceDocumentMetadata {
  const { annotations: _annotations, items: _items, ...metadata } =
    createWorkspaceDocument(state);
  return metadata;
}

export function createAppStateFromWorkspaceMetadata(
  metadata: WorkspaceDocumentMetadata,
  conversations: Record<string, Conversation>,
): AppState {
  return {
    activeConversationId: metadata.view.activeItemId,
    conversations,
    defaultModelId: metadata.preferences.defaultModelId,
    defaultServiceId: metadata.preferences.defaultServiceId,
    graphLayouts: metadata.view.graphLayouts,
    groups: metadata.view.groups,
    pinnedThreadIds: metadata.view.pinnedItemIds,
    railOpen: metadata.view.railOpen,
    rootId: metadata.view.activeRootId,
  };
}
