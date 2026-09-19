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

export interface VaultManifest {
  schemaVersion: 1;
  revision: number;
  files: Record<string, VaultEntry>;
}

export interface VaultConflict {
  id: string;
  path: string;
  local: VaultFile | null;
  remote: VaultFile | null;
  createdAt: string;
  sourcePath?: string;
}

export interface VaultSnapshot {
  schemaVersion: 1;
  files: Record<string, VaultFile>;
  base: Record<string, { revision: string; file: VaultFile | null }>;
  conflicts: VaultConflict[];
  remoteRevision: number;
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

export interface VaultTransport {
  manifest(): Promise<VaultManifest>;
  read(path: string, entry: VaultEntry): Promise<VaultFile>;
  commit(changes: VaultChange[]): Promise<VaultManifest>;
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
