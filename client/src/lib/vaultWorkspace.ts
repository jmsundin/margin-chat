import type { AppState } from "../types";
import { createEmptyState } from "../initialState";
import { hydratePersistedState } from "./appState";
import { createAppStateFromWorkspaceMetadata } from "./workspaceModel";
import {
  createMarkdownWorkspace, createMarkdownWorkspaceRenderer, discoverMarkdownWorkspace, parseMarkdownWorkspace,
  assignMarkdownFileIdentities, parseMarkdownWorkspaceManifest,
  type MarkdownWorkspace, type MarkdownWorkspaceManifest,
} from "./workspaceMarkdown";
import type { VaultFile } from "./vaultTypes";

/** Check the complete prospective working set before its durable index changes. */
export function validateVaultWorkspace(files: Record<string, VaultFile>) {
  const workspace = workspaceFromVault(files);
  if (workspace.manifest.files.length) {
    const state = parseMarkdownWorkspace(workspace.manifest, workspace.files);
    if (!state || !hydratePersistedState(state)) throw new Error("A Markdown document could not be opened. Your previous vault has been preserved.");
  }
}

/** A portable identity belongs to the existing document even when an archive uses an older path. */
export function reconcileVaultImportPaths(incoming: Record<string, VaultFile>, current: Record<string, VaultFile>) {
  const existingById = new Map(workspaceFromVault(current).manifest.files.map((record) => [record.id, record.path]));
  const paths = new Map(workspaceFromVault(incoming).manifest.files.map((record) => [record.path, existingById.get(record.id) ?? record.path]));
  return Object.entries(incoming).map(([path, file]) => ({ path: paths.get(path) ?? path, sourcePath: path, file }));
}

export function workspaceFromVault(files: Record<string, VaultFile>, previous?: MarkdownWorkspace): MarkdownWorkspace {
  const sidecar = files["workspace.json"];
  let metadata = previous?.manifest;
  if (sidecar) {
    if (sidecar.encoding) throw new Error("The vault settings file must be readable JSON.");
    const source = JSON.parse(sidecar.content) as MarkdownWorkspaceManifest;
    if (!parseMarkdownWorkspaceManifest(source)) throw new Error("The vault settings file is invalid. Its original content has been preserved.");
    metadata = source;
  }
  const markdown = Object.fromEntries(Object.entries(files)
    .filter(([path, file]) => /\.md$/iu.test(path) && !file.encoding)
    .map(([path, file]) => [path, file.content]));
  return discoverMarkdownWorkspace(markdown, metadata, previous?.files);
}

export function workspaceVaultFiles(workspace: MarkdownWorkspace, stampIdentities = true): Record<string, VaultFile> {
  if (stampIdentities) workspace = assignMarkdownFileIdentities(workspace);
  const manifest = structuredClone(workspace.manifest);
  manifest.files = [];
  manifest.savedAt = "1970-01-01T00:00:00.000Z";
  manifest.workspace.view.activeItemId = "";
  manifest.workspace.view.activeRootId = "";
  manifest.workspace.view.railOpen = false;
  return {
    ...Object.fromEntries(Object.entries(workspace.files).map(([path, content]) => [path, { content, contentType: "text/markdown; charset=utf-8" }])),
    "workspace.json": { content: JSON.stringify(manifest, null, 2), contentType: "application/json" },
  };
}

export function stateToVaultFiles(state: AppState, previous: Record<string, VaultFile>): Record<string, VaultFile> {
  const workspace = workspaceFromVault(previous);
  const rendered = createMarkdownWorkspace(state, "1970-01-01T00:00:00.000Z", workspace);
  const retained = Object.fromEntries(Object.entries(previous).filter(([path]) => !(path in workspace.files) && path !== "workspace.json"));
  // Existing raw revisions must stay byte-identical until the user edits them.
  // Import boundaries assign IDs; createMarkdownWorkspace assigns them to edited plain notes.
  return { ...retained, ...workspaceVaultFiles(rendered, false) };
}

/** Keeps the renderer's baseline only while files are the exact snapshot it emitted. */
export function createVaultFileRenderer() {
  const render = createMarkdownWorkspaceRenderer();
  let emittedFiles: Record<string, VaultFile> | undefined;
  let workspace: MarkdownWorkspace | undefined;
  return (state: AppState, previous: Record<string, VaultFile>) => {
    if (previous !== emittedFiles || !workspace) workspace = workspaceFromVault(previous);
    const rendered = render(state, "1970-01-01T00:00:00.000Z", workspace);
    const retained = Object.fromEntries(Object.entries(previous).filter(([path]) => !(path in workspace!.files) && path !== "workspace.json"));
    const next = { ...retained, ...workspaceVaultFiles(rendered, false) };
    for (const [path, file] of Object.entries(next)) {
      const before = previous[path];
      if (before && before.content === file.content && before.encoding === file.encoding && before.contentType === file.contentType) next[path] = before;
    }
    workspace = rendered;
    emittedFiles = next;
    return next;
  };
}

export function hasSameAuthoredState(left: AppState, right: AppState) {
  return left.conversations === right.conversations && left.graphLayouts === right.graphLayouts
    && left.groups === right.groups && left.pinnedThreadIds === right.pinnedThreadIds
    && left.defaultModelId === right.defaultModelId && left.defaultServiceId === right.defaultServiceId;
}

export function normalizeVaultMarkdownIdentities(files: Record<string, VaultFile>): Record<string, VaultFile> {
  const workspace = assignMarkdownFileIdentities(workspaceFromVault(files));
  return {
    ...files,
    ...Object.fromEntries(Object.entries(workspace.files).map(([path, content]) => [path, { ...files[path], content }])),
  };
}

export function vaultToState(files: Record<string, VaultFile>, current: AppState): AppState {
  const workspace = workspaceFromVault(files);
  const empty = !workspace.manifest.files.length;
  const parsed = empty
    ? createAppStateFromWorkspaceMetadata(workspace.manifest.workspace, createEmptyState().conversations)
    : parseMarkdownWorkspace(workspace.manifest, workspace.files);
  const hydrated = parsed && hydratePersistedState(parsed);
  if (!hydrated) throw new Error("A Markdown document could not be opened. Its original content is preserved in your vault.");
  if (empty) {
    const placeholder = hydrated.conversations[hydrated.rootId];
    placeholder.serviceId = hydrated.defaultServiceId;
    placeholder.modelId = hydrated.defaultModelId;
  }
  // View navigation belongs to the device, while authored relationships/settings travel with the vault.
  if (hydrated.conversations[current.activeConversationId]) hydrated.activeConversationId = current.activeConversationId;
  if (hydrated.conversations[current.rootId]) hydrated.rootId = current.rootId;
  hydrated.railOpen = current.railOpen;
  return hydrated;
}
