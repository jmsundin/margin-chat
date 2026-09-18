// Browser imports retain recovery semantics for legacy local snapshots.
export {
  WORKSPACE_DOCUMENT_SCHEMA_VERSION,
  createAppStateFromWorkspaceDocument,
  createAppStateFromWorkspaceMetadata,
  createWorkspaceDocument,
  createWorkspaceDocumentMetadata,
  parseWorkspaceDocument,
} from "@margin-chat/workspace-contracts/browser";
export type {
  WorkspaceAnnotation,
  WorkspaceChatItem,
  WorkspaceDocument,
  WorkspaceDocumentMetadata,
  WorkspaceDocumentReadMode,
  WorkspaceDocumentReadOptions,
  WorkspaceItem,
  WorkspaceNoteItem,
} from "@margin-chat/workspace-contracts";
