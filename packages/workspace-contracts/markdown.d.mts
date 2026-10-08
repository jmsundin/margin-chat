import type { AppState, ConversationDocument } from "./types.mjs";
import type { WorkspaceDocumentMetadata } from "./workspaceModel.mjs";

export const MARKDOWN_WORKSPACE_FORMAT_VERSION: 5;

export interface MarkdownWorkspaceFileRecord {
  id: string;
  path: string;
  type: "conversation" | "note";
  aliases?: string[];
  managedPath?: string;
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
  options?: { preservePaths?: boolean },
): MarkdownWorkspace;
/** Supply immutable editor states and the previous result; external snapshots reset the cache. */
export function createMarkdownWorkspaceRenderer(): (
  state: AppState, savedAt?: string, previousWorkspace?: MarkdownWorkspace,
) => MarkdownWorkspace;
export function parseMarkdownWorkspaceManifest(input: unknown): MarkdownWorkspaceManifest | null;
export function discoverMarkdownWorkspace(
  files: Record<string, string>,
  fallbackManifest?: MarkdownWorkspaceManifest,
  previousFiles?: Record<string, string>,
): MarkdownWorkspace;
export function assignMarkdownFileIdentities(workspace: MarkdownWorkspace, createdAtByPath?: Record<string, string>): MarkdownWorkspace;
export function parseMarkdownWorkspace(
  manifest: MarkdownWorkspaceManifest,
  fileContents: Record<string, string>,
): AppState | null;
export interface MarkdownVaultFileSummary {
  path: string;
  id: string;
  type: "conversation" | "note";
  kind: "chat" | "note";
  title: string;
  created?: string;
  updated?: string;
  aliases?: string[];
  parentTarget: string | null;
  linkedTargets: string[];
}
export interface MarkdownVaultIndexEntry {
  path: string;
  id: string;
  type: "conversation" | "note";
  kind: "chat" | "note";
  title: string;
  created?: string;
  updated?: string;
  /** The conversation this file belongs under: a branch's parent or a note's document. */
  parentPath?: string;
  linkedPaths?: string[];
}
export function summarizeMarkdownVaultFile(path: string, source: string): MarkdownVaultFileSummary | null;
export function buildMarkdownVaultIndex(summaries: MarkdownVaultFileSummary[]): MarkdownVaultIndexEntry[];
export function getAttachmentVaultPath(document: Pick<ConversationDocument, "id" | "filename">): string | null;
export function isSafeMarkdownPath(path: string): boolean;

export { encodeReadableMarkdown, decodeReadableMarkdown, isReadableMarkdown } from "./markdownReadable.mjs";

export function preserveMarkdownFileLocation(source: string, currentSource: string, path: string): string;
