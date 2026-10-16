import type { LocalDirectoryStatus } from "./workspaceStorage";
import { isSafeMarkdownPath } from "./workspaceMarkdown";

/**
 * What the desktop app asks for before showing the workspace: a vault folder to
 * choose on first run, one click to allow a remembered folder again (desktop
 * apps without the permission check handler), or a remembered folder that can't
 * be found or opened.
 */
export type VaultFolderPrompt = "choose" | "allow" | "missing";

export function vaultFolderPrompt(input: {
  desktop: boolean;
  ready: boolean;
  /** "Not now" was chosen since the app opened. */
  snoozed: boolean;
  status: Pick<LocalDirectoryStatus, "directoryName" | "permission" | "supported">;
  /** The remembered folder itself could not be opened; it must never be read as empty. */
  unavailable: boolean;
}): VaultFolderPrompt | null {
  if (!input.desktop || !input.ready || input.snoozed || !input.status.supported) return null;
  if (!input.status.directoryName) return "choose";
  if (input.unavailable) return "missing";
  return input.status.permission === "prompt" || input.status.permission === "denied" ? "allow" : null;
}

const snoozeKey = (userId: string) => `margin-chat:vault-folder-prompt-snoozed:${userId}`;
function sessionStore(): Storage | null {
  try { return typeof window === "undefined" ? null : window.sessionStorage; } catch { return null; }
}

/** "Not now" lasts until the app is opened again; reloads in the same window keep it. */
export function isVaultFolderPromptSnoozed(userId: string, storage = sessionStore()) {
  try { return storage?.getItem(snoozeKey(userId)) === "1"; } catch { return false; }
}

export function saveVaultFolderPromptSnooze(userId: string, storage = sessionStore()) {
  try { storage?.setItem(snoozeKey(userId), "1"); } catch { /* Without storage, "Not now" lasts until the page reloads. */ }
}

/** Above either, opening a folder asks first: it may be a whole drive or home folder chosen by mistake. */
export const LARGE_FOLDER_FILES = 5_000;
export const LARGE_FOLDER_BYTES = 2 * 1024 ** 3;

export interface FolderPreview {
  markdownFiles: number;
  otherFiles: number;
  /** Sizes of the files counted, from the file system; nothing is read. */
  totalBytes: number;
  /** False when counting stopped early because the folder has more files than `stopAfter`. */
  complete: boolean;
}

type DirectoryEntries = FileSystemDirectoryHandle & { entries(): AsyncIterableIterator<[string, FileSystemHandle]> };

/**
 * Counts what a folder holds before it is connected, skipping what the folder
 * watcher skips (hidden files and Margin Chat's own folders), without reading
 * any file. Stops, incomplete, on finding more than `stopAfter` files.
 */
export async function previewLocalDirectory(handle: FileSystemDirectoryHandle, stopAfter = LARGE_FOLDER_FILES): Promise<FolderPreview> {
  const preview: FolderPreview = { markdownFiles: 0, otherFiles: 0, totalBytes: 0, complete: true };
  async function walk(directory: FileSystemDirectoryHandle, prefix: string): Promise<boolean> {
    for await (const [name, entry] of (directory as DirectoryEntries).entries()) {
      if (name.startsWith(".")) continue;
      const path = prefix ? `${prefix}/${name}` : name;
      if (/^(?:attachments|_conflicts|\.margin-chat)(?:\/|$)/i.test(path)) continue;
      if (entry.kind === "directory") {
        if (!await walk(entry as FileSystemDirectoryHandle, path)) return false;
        continue;
      }
      if (preview.markdownFiles + preview.otherFiles >= stopAfter) { preview.complete = false; return false; }
      if (isSafeMarkdownPath(path)) preview.markdownFiles += 1; else preview.otherFiles += 1;
      try { preview.totalBytes += (await (entry as FileSystemFileHandle).getFile()).size; }
      catch { /* A file removed while counting still counts, without its size. */ }
    }
    return true;
  }
  await walk(handle, "");
  return preview;
}

export function isLargeFolder(preview: FolderPreview) {
  return !preview.complete || preview.markdownFiles + preview.otherFiles > LARGE_FOLDER_FILES || preview.totalBytes > LARGE_FOLDER_BYTES;
}

export function formatFolderSize(bytes: number) {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value < 10 ? value.toFixed(1).replace(/\.0$/, "") : Math.round(value)} ${units[unit]}`;
}

const count = (value: number, one: string, many: string) => `${value.toLocaleString("en-US")} ${value === 1 ? one : many}`;

/** "12 notes and 3 other files (1.4 MB)", or "more than 5,000 files". */
export function describeFolderPreview(preview: FolderPreview) {
  const files = preview.markdownFiles + preview.otherFiles;
  if (!preview.complete) return `more than ${count(files, "file", "files")}`;
  if (!files) return "no files yet";
  const parts = [preview.markdownFiles ? count(preview.markdownFiles, "note", "notes") : "",
    preview.otherFiles ? count(preview.otherFiles, preview.markdownFiles ? "other file" : "file", preview.markdownFiles ? "other files" : "files") : ""];
  return `${parts.filter(Boolean).join(" and ")} (${formatFolderSize(preview.totalBytes)})`;
}

/** The folder to create for a new vault, or a plain explanation of why the name can't be used. */
export function vaultFolderName(name: string) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Give your vault a name.");
  if (/[\\/:*?"<>|\u0000-\u001f]/u.test(trimmed)) throw new Error("A vault name can’t contain / \\ : * ? \" < > or |.");
  if (trimmed.startsWith(".") || trimmed.endsWith(".")) throw new Error("A vault name can’t start or end with a dot.");
  if (/^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i.test(trimmed)) throw new Error(`“${trimmed}” can’t be used as a folder name. Choose another name.`);
  if (trimmed.length > 100) throw new Error("Choose a shorter name for your vault.");
  return trimmed;
}

/** A folder with this name already exists where the new vault was to go, and it holds files. */
export class VaultFolderExistsError extends Error {
  constructor(readonly handle: FileSystemDirectoryHandle) {
    super(`There’s already a folder named “${handle.name}” there, and it has files in it. Open it instead, or choose another name.`);
    this.name = "VaultFolderExistsError";
  }
}

const named = (error: unknown, name: string) => !!error && typeof error === "object" && "name" in error && error.name === name;
/** Files the system adds to folders by itself. */
const SYSTEM_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

async function holdsFiles(handle: FileSystemDirectoryHandle) {
  for await (const [name] of (handle as DirectoryEntries).entries()) if (!SYSTEM_FILES.has(name)) return true;
  return false;
}

/**
 * Makes the folder for a new vault inside `parent`. An empty folder with that
 * name is used as it is; one that already holds files is never used as a new
 * vault, so the caller can offer to open it instead.
 */
export async function createVaultFolder(parent: FileSystemDirectoryHandle, name: string): Promise<FileSystemDirectoryHandle> {
  const folderName = vaultFolderName(name);
  let existing: FileSystemDirectoryHandle | null = null;
  try {
    existing = await parent.getDirectoryHandle(folderName);
  } catch (error) {
    if (named(error, "TypeMismatchError")) throw new Error(`There’s already a file named “${folderName}” there. Choose another name.`);
    if (!named(error, "NotFoundError")) throw error;
  }
  if (existing) {
    if (await holdsFiles(existing)) throw new VaultFolderExistsError(existing);
    return existing;
  }
  return parent.getDirectoryHandle(folderName, { create: true });
}
