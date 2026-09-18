export * from "./index.mjs";
import type { AppState } from "./types.mjs";
import type { WorkspaceDocumentReadOptions } from "./workspaceModel.mjs";

/** Defaults to recovery mode for legacy browser snapshots. */
export function createAppStateFromWorkspaceDocument(
  input: unknown,
  options?: WorkspaceDocumentReadOptions,
): AppState | null;
