import type {
  AppState,
  BranchAnchor,
  Conversation,
  ConversationDocument,
  ConversationGroup,
  ConversationNote,
  GraphNodeLayout,
  Message,
} from "./types.mjs";

export const WORKSPACE_DOCUMENT_SCHEMA_VERSION: 2;
export const DEFAULT_WORKSPACE_PREFERENCES: Readonly<{
  defaultServiceId: "backend-services";
  defaultModelId: "smart-routing";
}>;

interface WorkspaceItemBase {
  document?: Conversation["document"];
  grouping?: Conversation["grouping"];
  publicTopic?: Conversation["publicTopic"];
  linkedConversationIds?: Conversation["linkedConversationIds"];
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

export type WorkspaceDocumentReadMode = "strict" | "recovery";
export interface WorkspaceDocumentReadOptions {
  /** Strict rejects orphan annotations and accepts empty documents; recovery skips orphans and returns null for an empty legacy document. */
  mode?: WorkspaceDocumentReadMode;
}

export function createWorkspaceDocument(state: AppState): WorkspaceDocument;
export function parseWorkspaceDocument(input: unknown): WorkspaceDocument | null;
export function createAppStateFromWorkspaceDocument(
  input: unknown,
  options?: WorkspaceDocumentReadOptions,
): AppState | null;
export function createWorkspaceDocumentMetadata(state: AppState): WorkspaceDocumentMetadata;
export function createAppStateFromWorkspaceMetadata(
  metadata: WorkspaceDocumentMetadata,
  conversations: Record<string, Conversation>,
): AppState;
