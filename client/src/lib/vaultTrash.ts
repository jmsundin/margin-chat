import { isVaultFileDocumentPath } from "@margin-chat/workspace-contracts";
import { sameVaultFile, validVaultPath, type VaultFile, type VaultSnapshot } from "./vaultTypes";
import { workspaceFromVault } from "./vaultWorkspace";

/** Deleted documents can be restored for this long, then their copies are removed. */
export const TRASH_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const TRASH_PREFIX = ".margin-chat/trash/";
const DESCRIPTOR = /^\.margin-chat\/trash\/([^/]+)\/deleted\.json$/u;

export interface TrashedFile {
  /** Where the file lived in the vault. */
  path: string;
  /** Its saved copy inside the trash entry. */
  copy: string;
  title: string;
}

/** Everything one save deleted, such as a document with its margin notes. */
export interface TrashEntry {
  key: string;
  deletedAt: string;
  files: TrashedFile[];
}

/** Markdown documents and the PDFs and images that open as documents. */
function isDocumentPath(path: string) {
  if (/^(?:attachments|_conflicts|\.margin-chat)\//iu.test(path)) return false;
  if (/\.md$/iu.test(path)) return path.split("/").every((segment) => segment && !segment.startsWith("."));
  return isVaultFileDocumentPath(path);
}

function fileName(path: string) {
  return path.split("/").at(-1) ?? path;
}

/** The title a person would recognize: the header title, else the first heading, else the file name. */
export function trashTitle(path: string, file: VaultFile) {
  if (!file.encoding && /\.md$/iu.test(path)) {
    const header = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(file.content)?.[1];
    const raw = header ? /^title:[ \t]*(.+)$/mu.exec(header)?.[1]?.trim() : undefined;
    if (raw) {
      try { const parsed: unknown = JSON.parse(raw); if (typeof parsed === "string" && parsed.trim()) return parsed.trim(); }
      catch { if (!/^["']/u.test(raw)) return raw; }
    }
    const heading = /^#[ \t]+(.+)$/mu.exec(header ? file.content.slice(file.content.indexOf(header) + header.length) : file.content)?.[1]?.trim();
    if (heading) return heading;
    return fileName(path).replace(/\.md$/iu, "");
  }
  return fileName(path);
}

function identities(files: Record<string, VaultFile>) {
  try {
    return new Map(workspaceFromVault(files).manifest.files.map((record) => [record.path, record.id]));
  } catch {
    return new Map<string, string>();
  }
}

function newKey(now: Date) {
  const stamp = now.toISOString().replace(/[-:]/gu, "").replace(/\.\d+Z$/u, "Z");
  return `${stamp}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Saves a copy of each document that `next` deletes, so it can be restored for
 * TRASH_DAYS. Renames and moves are not deletions: a Markdown file that keeps its
 * identity, or a PDF or image whose bytes appear at a new path, is skipped.
 * Changes `snapshot` in place; `before` is the vault as it was before the edit.
 */
export function moveDeletionsToTrash(snapshot: VaultSnapshot, before: Record<string, VaultFile>,
  next: Record<string, VaultFile>, expected: Record<string, VaultFile>, now = new Date()): TrashEntry | null {
  const deleted = Object.keys(before).filter((path) => isDocumentPath(path) && expected[path] && !next[path] && !snapshot.files[path]);
  if (!deleted.length) return null;
  const added = Object.keys(snapshot.files).filter((path) => !before[path]);
  const beforeIds = added.length ? identities(before) : new Map<string, string>();
  const keptIds = added.length ? new Set(identities(snapshot.files).values()) : new Set<string>();
  const kept = deleted.filter((path) => {
    const id = beforeIds.get(path);
    if (id && keptIds.has(id)) return false;
    return !(before[path].encoding && added.some((other) => sameVaultFile(snapshot.files[other], before[path])));
  });
  if (!kept.length) return null;
  const key = newKey(now);
  const files = kept.sort().map((path, index) => {
    const copy = `${TRASH_PREFIX}${key}/${index + 1}-${fileName(path)}`;
    return { path, copy: validVaultPath(copy) ? copy : `${TRASH_PREFIX}${key}/${index + 1}`, title: trashTitle(path, before[path]) };
  });
  for (const file of files) snapshot.files[file.copy] = { ...before[file.path] };
  const entry: TrashEntry = { key, deletedAt: now.toISOString(), files };
  snapshot.files[`${TRASH_PREFIX}${key}/deleted.json`] = {
    content: JSON.stringify({ schemaVersion: 1, deletedAt: entry.deletedAt, files }, null, 2),
    contentType: "application/json",
  };
  return entry;
}

/** Recently deleted documents, newest first. Entries whose copies are missing are left out. */
export function listTrash(files: Record<string, VaultFile>): TrashEntry[] {
  const entries: TrashEntry[] = [];
  for (const [path, file] of Object.entries(files)) {
    const key = DESCRIPTOR.exec(path)?.[1];
    if (!key || file.encoding) continue;
    try {
      const descriptor = JSON.parse(file.content) as { deletedAt?: unknown; files?: unknown };
      if (typeof descriptor.deletedAt !== "string" || !Number.isFinite(Date.parse(descriptor.deletedAt)) || !Array.isArray(descriptor.files)) continue;
      const trashed = descriptor.files.filter((item): item is TrashedFile => Boolean(item) && typeof item.path === "string"
        && typeof item.copy === "string" && typeof item.title === "string" && validVaultPath(item.path)
        && item.copy.startsWith(`${TRASH_PREFIX}${key}/`) && Boolean(files[item.copy]));
      if (trashed.length) entries.push({ key, deletedAt: descriptor.deletedAt, files: trashed });
    } catch { /* An unreadable descriptor stays as a file; it lists nothing. */ }
  }
  return entries.sort((left, right) => right.deletedAt.localeCompare(left.deletedAt) || right.key.localeCompare(left.key));
}

function entryPaths(files: Record<string, VaultFile>, key: string) {
  return Object.keys(files).filter((path) => path.startsWith(`${TRASH_PREFIX}${key}/`));
}

function freePath(files: Record<string, VaultFile>, path: string) {
  if (!files[path]) return path;
  const slash = path.lastIndexOf("/") + 1;
  const dot = path.lastIndexOf(".");
  const [stem, extension] = dot > slash ? [path.slice(0, dot), path.slice(dot)] : [path, ""];
  for (let attempt = 1; ; attempt += 1) {
    const candidate = `${stem} (restored${attempt > 1 ? ` ${attempt}` : ""})${extension}`;
    if (!files[candidate]) return candidate;
  }
}

/**
 * Puts every file of one trash entry back where it was, or beside it with
 * "(restored)" when that path is taken, and removes the entry. A document whose
 * identity is already back in the vault is not restored a second time.
 * Changes `snapshot` in place and returns the paths written.
 */
export function restoreFromTrash(snapshot: VaultSnapshot, key: string): string[] {
  const entry = listTrash(snapshot.files).find((candidate) => candidate.key === key);
  if (!entry) throw new Error("That deleted document is no longer in Recently deleted.");
  const present = new Set(identities(snapshot.files).values());
  const restored: string[] = [];
  for (const file of entry.files) {
    const copy = snapshot.files[file.copy];
    if (sameVaultFile(snapshot.files[file.path], copy)) continue;
    const id = !copy.encoding && /\.md$/iu.test(file.path) ? identities({ [file.path]: copy }).get(file.path) : undefined;
    if (id && present.has(id)) continue;
    const path = freePath(snapshot.files, file.path);
    snapshot.files[path] = { ...copy };
    restored.push(path);
  }
  for (const path of entryPaths(snapshot.files, key)) delete snapshot.files[path];
  return restored;
}

/** Removes trash entries older than TRASH_DAYS. Returns how many were removed. */
export function purgeExpiredTrash(snapshot: VaultSnapshot, now = Date.now()) {
  let removed = 0;
  for (const entry of listTrash(snapshot.files)) {
    if (now - Date.parse(entry.deletedAt) < TRASH_DAYS * DAY_MS) continue;
    for (const path of entryPaths(snapshot.files, entry.key)) delete snapshot.files[path];
    removed += 1;
  }
  return removed;
}

export function hasExpiredTrash(files: Record<string, VaultFile>, now = Date.now()) {
  return listTrash(files).some((entry) => now - Date.parse(entry.deletedAt) >= TRASH_DAYS * DAY_MS);
}

export function isTrashPath(path: string) {
  return path.startsWith(TRASH_PREFIX);
}
