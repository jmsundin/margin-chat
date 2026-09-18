import type { AppState, ConversationDocument } from "./types.mjs";
import type { WorkspaceDocumentMetadata } from "./workspaceModel.mjs";

export const MARKDOWN_WORKSPACE_FORMAT_VERSION: 3;

export interface MarkdownWorkspaceFileRecord {
  id: string;
  path: string;
  type: "conversation" | "note";
  aliases?: string[];
}

export interface MarkdownWorkspaceManifest {
  files: MarkdownWorkspaceFileRecord[];
  formatVersion: number;
  savedAt: string;
  workspace: WorkspaceDocumentMetadata;
}

export interface MarkdownWorkspace {
  files: Record<string, string>;
  manifest: MarkdownWorkspaceManifest;
}

export function createMarkdownWorkspace(
  state: AppState,
  savedAt?: string,
  previousWorkspace?: MarkdownWorkspace,
): MarkdownWorkspace;
/** Supply immutable editor states and the previous result; external snapshots reset the cache. */
export function createMarkdownWorkspaceRenderer(): typeof createMarkdownWorkspace;
export function parseMarkdownWorkspaceManifest(input: unknown): MarkdownWorkspaceManifest | null;
export function discoverMarkdownWorkspace(
  files: Record<string, string>,
  fallbackManifest?: MarkdownWorkspaceManifest,
  previousFiles?: Record<string, string>,
): MarkdownWorkspace;
export function assignMarkdownFileIdentities(workspace: MarkdownWorkspace): MarkdownWorkspace;
export function parseMarkdownWorkspace(
  manifest: MarkdownWorkspaceManifest,
  fileContents: Record<string, string>,
): AppState | null;
export function getAttachmentVaultPath(document: Pick<ConversationDocument, "id" | "filename">): string | null;
export function isSafeMarkdownPath(path: string): boolean;
