export * from "./index.mjs";
import { createAppStateFromWorkspaceDocument as readDocument } from "./workspaceModel.mjs";

// Preserve the local recovery policy while sharing the server's parser and converter.
export function createAppStateFromWorkspaceDocument(input, options = {}) {
  return readDocument(input, { mode: "recovery", ...options });
}
