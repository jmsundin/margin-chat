import type { MarkdownWorkspaceManifest } from "./workspaceMarkdown";

export interface VaultFile {
  content: string;
  encoding?: "base64";
  contentType?: string;
}

export interface VaultEntry {
  revision: string;
  deleted: boolean;
  encoding?: "base64";
  contentType?: string;
}

/** The document identity travels with a deferred file so settings that refer
 * to it are kept while it is not on this device. A requested entry downloads
 * on the next sync. */
export type VaultDeferredEntry = VaultEntry & { id?: string; requested?: boolean };

export interface VaultManifest {
  schemaVersion: 1;
  revision: number;
  files: Record<string, VaultEntry>;
}

/** A commit receipt lists the saved entries and the cloud revision the commit
 * was built on, when the server reports it. */
export type VaultCommitReceipt = VaultManifest & { previousRevision?: number };

export interface VaultConflict {
  id: string;
  path: string;
  local: VaultFile | null;
  remote: VaultFile | null;
  createdAt: string;
  sourcePath?: string;
  /** Automatic recovery records retain the actual ancestor and selected result. */
  base?: VaultFile | null;
  result?: VaultFile | null;
  automatic?: boolean;
}

export interface VaultSnapshot {
  schemaVersion: 1;
  files: Record<string, VaultFile>;
  base: Record<string, { revision: string; file: VaultFile | null }>;
  conflicts: VaultConflict[];
  /** Dismissing an alternative is local UI state; its portable recovery files remain. */
  dismissedRecoveryIds?: string[];
  remoteRevision: number;
  /** Every cloud change up to this revision is reflected in `base` or
   * `deferred`, so the next sync asks only for later changes. */
  pulledRevision?: number;
  /** Cloud files this device has not downloaded yet. A new device opens its most
   * recent documents first; the rest arrive when opened. Absent means complete. */
  deferred?: Record<string, VaultDeferredEntry>;
  /** Device-only observations, keyed by the identity of the selected directory handle. */
  directoryBaselines?: Record<string, {
    files: Record<string, VaultFile>;
    manifest: MarkdownWorkspaceManifest;
  }>;
}

export interface VaultChange {
  path: string;
  baseRevision: string | null;
  content: string | null;
  encoding?: "base64";
  contentType?: string;
}

export interface VaultStore {
  read(): Promise<VaultSnapshot | null>;
  write(snapshot: VaultSnapshot): Promise<void>;
  lock<T>(operation: () => Promise<T>): Promise<T>;
}

export interface VaultIndexEntry {
  path: string;
  id: string;
  type: "conversation" | "note";
  kind: "chat" | "note";
  title: string;
  revision: string;
  created?: string;
  updated?: string;
  parentPath?: string;
  linkedPaths?: string[];
}

export interface VaultIndex {
  revision: number;
  entries: VaultIndexEntry[];
}

/** A matching passage inside a document, message or note, located for opening. */
export interface VaultSearchPassage {
  /** The document (conversation) it belongs to. */
  id: string;
  /** Its vault path, when the index lists it. */
  path?: string;
  title: string;
  source: "document" | "message" | "note";
  snippet: string;
  /** The matched text's range within `snippet`. */
  match: { start: number; end: number };
  /** Where the match is: the block, message or note, and its range in that text. */
  position: { blockId?: string; messageId?: string; noteId?: string; start: number; end: number };
  updated?: string;
}

/** One step of a streamed search: titles first, then passages from each source. */
export type VaultSearchEvent =
  | { type: "documents"; results: VaultIndexEntry[] }
  | { type: "passages"; source: "documents" | "messages" | "notes"; results: VaultSearchPassage[]; error?: string }
  | { type: "done"; revision: number; indexedRevision?: number | null }
  | { type: "error"; error: string };

export interface VaultDownloadProgress {
  done: number;
  total: number;
}

export interface VaultTransport {
  manifest(): Promise<VaultManifest>;
  /** The entries that changed after `since`, with the current revision. */
  changes?(since: number): Promise<VaultManifest>;
  /** The index, newest first; `onProgress` sees it grow while it downloads. */
  index?(onProgress?: (index: VaultIndex) => void): Promise<VaultIndex>;
  /** Streams search results to `onEvent` as the server finds them. */
  search?(query: string, options: { limit?: number; signal?: AbortSignal }, onEvent: (event: VaultSearchEvent) => void): Promise<void>;
  read(path: string, entry: VaultEntry): Promise<VaultFile>;
  commit(changes: VaultChange[]): Promise<VaultCommitReceipt>;
}

export function emptyVault(): VaultSnapshot {
  return { schemaVersion: 1, files: {}, base: {}, conflicts: [], remoteRevision: 0 };
}

export function validVaultPath(path: string): boolean {
  return path.length > 0 && path.length <= 512 && !/[\\\u0000-\u001f\u007f\ud800-\udfff]/u.test(path)
    && !path.startsWith("/") && path.split("/").every((part) => part && part !== "." && part !== "..")
    && !path.split("/").some((part) => ["__proto__", "constructor", "prototype"].includes(part));
}

export function sameVaultFile(a: VaultFile | null | undefined, b: VaultFile | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.content === b.content && a.encoding === b.encoding;
}
