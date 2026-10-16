import type { AppState, AuthenticatedUser } from "../types";
import {
  createMarkdownWorkspace,
  discoverMarkdownWorkspace,
  isSafeMarkdownPath,
  parseMarkdownWorkspace,
  parseMarkdownWorkspaceManifest,
  type MarkdownWorkspaceManifest,
  type MarkdownWorkspace,
} from "./workspaceMarkdown";
import { createWorkspaceDocument } from "./workspaceModel";
import { validVaultPath, type DirectoryFileStat, type DirectoryStats, type VaultFile } from "./vaultTypes";
import { readFreshBytes, readFreshFile, readFreshText, scanWhileFolderSettles } from "./fileSnapshot";
import { isSyncableVaultFileSize, isVaultFileDocumentPath, vaultFileContentType, type VaultFileListing } from "./vaultFileDocuments";

const DIRECTORY_DATABASE_NAME = "margin-chat-local-storage";
const DIRECTORY_DATABASE_VERSION = 1;
const DIRECTORY_HANDLE_STORE = "directory-handles";
const LOCAL_FILE_FORMAT_VERSION = 1;

type FileSystemPermissionState = "denied" | "granted" | "prompt";
type PermissionCapableDirectoryHandle = FileSystemDirectoryHandle & {
  queryPermission(options?: {
    mode?: "read" | "readwrite";
  }): Promise<FileSystemPermissionState>;
  requestPermission(options?: {
    mode?: "read" | "readwrite";
  }): Promise<FileSystemPermissionState>;
};
type DirectoryPickerWindow = Window & {
  showDirectoryPicker(options?: {
    id?: string;
    mode?: "read" | "readwrite";
  }): Promise<FileSystemDirectoryHandle>;
};

export interface LocalDirectoryStatus {
  directoryId?: string;
  directoryName: string | null;
  fileName: string;
  permission: FileSystemPermissionState | "unselected" | "unsupported";
  supported: boolean;
}

export interface LocalWorkspaceRecord {
  formatVersion: number;
  savedAt: string;
  state: AppState;
}

let directoryWriteQueue = Promise.resolve();
const observedDirectoryWorkspaces = new Map<string, MarkdownWorkspace>();

export class LocalDirectoryConflictError extends Error {
  constructor(public readonly paths: string[]) {
    super(`The connected folder changed again while saving (${paths.join(", ")}). Its files are preserved; sync will retry.`);
    this.name = "LocalDirectoryConflictError";
  }
}

/** The connected folder itself can't be opened: moved, deleted, on a drive that isn't connected, or refused. */
export class FolderUnavailableError extends Error {
  constructor(readonly folderName: string, readonly reason: "missing" | "refused") {
    super(`Margin Chat can’t find or open the folder “${folderName}”. Nothing was changed in it or in your vault.`);
    this.name = "FolderUnavailableError";
  }
}

export interface LocalDirectoryWorkspace {
  workspace: MarkdownWorkspace;
  savedAt: string;
  /** Each Markdown file's modification time on disk. */
  modifiedAt?: Record<string, string>;
  /** For Markdown files whose text the scan read (or reused), the size and date of those bytes. */
  stats: DirectoryStats;
}

export function canSyncWorkspaceToCloud(user: AuthenticatedUser) {
  return user.role === "admin" || user.billing.accessKind === "subscription";
}

export function isRecoverableCloudSyncError(error: unknown) {
  return (
    error instanceof TypeError ||
    (error !== null &&
      typeof error === "object" &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode >= 500)
  );
}

export function areWorkspaceStatesEqual(left: AppState, right: AppState) {
  return stableSerialize(createWorkspaceDocument(left)) ===
    stableSerialize(createWorkspaceDocument(right));
}

export function createLocalWorkspaceRecord(
  state: AppState,
  savedAt = new Date().toISOString(),
): LocalWorkspaceRecord {
  return {
    formatVersion: LOCAL_FILE_FORMAT_VERSION,
    savedAt,
    state,
  };
}

export function parseLocalWorkspaceRecord(
  input: unknown,
): LocalWorkspaceRecord | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }

  const candidate = input as Partial<LocalWorkspaceRecord>;

  if (
    typeof candidate.savedAt !== "string" ||
    Number.isNaN(Date.parse(candidate.savedAt)) ||
    !candidate.state ||
    typeof candidate.state !== "object" ||
    !("conversations" in candidate.state)
  ) {
    return null;
  }

  return {
    formatVersion:
      typeof candidate.formatVersion === "number"
        ? candidate.formatVersion
        : LOCAL_FILE_FORMAT_VERSION,
    savedAt: candidate.savedAt,
    state: candidate.state,
  };
}

export function getLocalWorkspaceFileName(userId: string) {
  const safeUserId = userId.replace(/[^a-z0-9_-]/gi, "-");
  return `margin-chat-workspace-${safeUserId}.json`;
}

export async function getLocalDirectoryStatus(
  userId: string,
): Promise<LocalDirectoryStatus> {
  const fileName = getLocalWorkspaceFileName(userId);

  if (!supportsDirectoryPicker()) {
    return {
      directoryName: null,
      fileName,
      permission: "unsupported",
      supported: false,
    };
  }

  const selection = await getStoredDirectorySelection(userId);
  const handle = selection?.handle;

  if (!handle) {
    return {
      directoryName: null,
      fileName,
      permission: "unselected",
      supported: true,
    };
  }

  return buildDirectoryStatus(handle, fileName, selection!.id);
}

/** Invoke directly in the click handler; selecting it is separately serialized with folder I/O. */
export async function pickLocalDirectory(): Promise<FileSystemDirectoryHandle | null> {
  if (!supportsDirectoryPicker()) return null;
  return (
    window as unknown as DirectoryPickerWindow
  ).showDirectoryPicker({
    id: "margin-chat-workspaces",
    mode: "readwrite",
  });
}

export async function connectLocalDirectory(userId: string, handle: FileSystemDirectoryHandle): Promise<LocalDirectoryStatus> {
  const previous = await getStoredDirectorySelection(userId);
  const directories = previous?.directories ?? (previous ? [{ id: previous.id, handle: previous.handle }] : []);
  let known: DirectoryIdentity | undefined;
  for (const entry of directories) {
    if (entry.handle === handle || await entry.handle.isSameEntry?.(handle)) { known = entry; break; }
  }
  const selected = known ?? { id: crypto.randomUUID(), handle };
  await setStoredDirectorySelection(userId, { ...selected, directories: known ? directories : [...directories, selected] });
  observedDirectoryWorkspaces.delete(userId);
  return buildDirectoryStatus(handle, getLocalWorkspaceFileName(userId), selected.id);
}

/**
 * Browsers forget folder access between visits, so a remembered folder can be
 * unreadable until the user allows it again. Call from a click handler.
 */
export async function requestLocalDirectoryPermission(userId: string): Promise<LocalDirectoryStatus> {
  const selection = await getStoredDirectorySelection(userId);
  if (!selection) return getLocalDirectoryStatus(userId);
  const handle = selection.handle as Partial<PermissionCapableDirectoryHandle>;
  if (typeof handle.requestPermission === "function") await handle.requestPermission({ mode: "readwrite" });
  return buildDirectoryStatus(selection.handle, getLocalWorkspaceFileName(userId), selection.id);
}

export interface RememberedLocalDirectory {
  id: string;
  name: string;
  current: boolean;
}

/** Folders connected before on this device, the connected one first. */
export async function listLocalDirectories(userId: string): Promise<RememberedLocalDirectory[]> {
  const selection = await getStoredDirectorySelection(userId);
  if (!selection) return [];
  const directories = selection.directories.length ? selection.directories : [{ id: selection.id, handle: selection.handle }];
  return directories
    .map((entry) => ({ id: entry.id, name: entry.handle.name, current: entry.id === selection.id }))
    .sort((a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name));
}

/**
 * Reconnects a folder connected before, asking the browser for access again.
 * Call from a click handler. Returns null when the folder is not remembered.
 */
export async function reconnectLocalDirectory(userId: string, directoryId: string): Promise<FileSystemDirectoryHandle | null> {
  const selection = await getStoredDirectorySelection(userId);
  const entry = selection?.directories.find((candidate) => candidate.id === directoryId);
  if (!entry) return null;
  const handle = entry.handle as Partial<PermissionCapableDirectoryHandle>;
  if (typeof handle.requestPermission === "function" && await handle.requestPermission({ mode: "readwrite" }) !== "granted") return null;
  return entry.handle;
}

/**
 * Names, sizes and modification times of the folder's Markdown files, PDFs and images, without
 * reading their text, so the folder can be checked for new files often.
 */
export async function localDirectorySignature(handle: FileSystemDirectoryHandle, prefix = ""): Promise<string> {
  const parts: string[] = [];
  const entries = handle as FileSystemDirectoryHandle & { entries(): AsyncIterableIterator<[string, FileSystemHandle]> };
  for await (const [name, entry] of entries.entries()) {
    if (name.startsWith(".")) continue;
    const path = prefix ? `${prefix}/${name}` : name;
    if (/^(?:attachments|_conflicts|\.margin-chat)(?:\/|$)/i.test(path)) continue;
    if (entry.kind === "directory") parts.push(await localDirectorySignature(entry as FileSystemDirectoryHandle, path));
    else if (isSafeMarkdownPath(path) || isVaultFileDocumentPath(path)) {
      const file = await (entry as FileSystemFileHandle).getFile();
      parts.push(`${path}\t${file.size}\t${file.lastModified}`);
    }
  }
  return parts.sort().join("\n");
}

type FileSystemObserverConstructor = new (callback: () => void) => {
  observe(handle: FileSystemHandle, options?: { recursive?: boolean }): Promise<void>;
  disconnect(): void;
};

/** Checks between folder scans; a scan that takes longer spaces the next one out. */
const FOLDER_WATCH_MIN_MS = 2_500;
const FOLDER_WATCH_MAX_MS = 60_000;

/**
 * Calls `onChange` soon after a Markdown file, PDF or image is added, edited, renamed or
 * removed in the connected folder by another app. Uses the browser's folder
 * observer where there is one, and otherwise compares cheap scans while the
 * page is visible. Returns a function that stops watching.
 */
export function watchLocalDirectory(userId: string, directoryId: string, onChange: () => void): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let observer: InstanceType<FileSystemObserverConstructor> | null = null;
  let last: string | null = null;
  let scanning = false;

  async function scan() {
    if (stopped || scanning) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") { schedule(FOLDER_WATCH_MIN_MS); return; }
    scanning = true;
    const started = Date.now();
    try {
      const handle = await getStoredDirectoryHandle(userId, directoryId);
      if (!handle || (await queryDirectoryPermission(handle)) !== "granted") return;
      const signature = await localDirectorySignature(handle);
      if (stopped) return;
      if (last !== null && signature !== last) onChange();
      last = signature;
    } catch {
      // A folder that moved or lost access is reported by the regular sync.
    } finally {
      scanning = false;
      schedule(Math.min(FOLDER_WATCH_MAX_MS, Math.max(FOLDER_WATCH_MIN_MS, (Date.now() - started) * 20)));
    }
  }

  function schedule(delay: number) {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => void scan(), delay);
  }

  const Observer = (globalThis as { FileSystemObserver?: FileSystemObserverConstructor }).FileSystemObserver;
  if (Observer) {
    void getStoredDirectoryHandle(userId, directoryId).then((handle) => {
      if (!handle || stopped) return;
      // Changes arrive in bursts while another app saves; one check covers them.
      observer = new Observer(() => schedule(300));
      return observer.observe(handle, { recursive: true });
    }).catch(() => { observer = null; });
  }
  void scan();
  return () => {
    stopped = true;
    clearTimeout(timer);
    observer?.disconnect();
  };
}

export async function chooseLocalDirectory(userId: string): Promise<LocalDirectoryStatus> {
  const handle = await pickLocalDirectory();
  return handle ? connectLocalDirectory(userId, handle) : getLocalDirectoryStatus(userId);
}

export async function clearLocalDirectory(userId: string) {
  observedDirectoryWorkspaces.delete(userId);
  if (typeof indexedDB === "undefined") {
    return;
  }

  const database = await openDirectoryDatabase();

  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(DIRECTORY_HANDLE_STORE, "readwrite");
    transaction.objectStore(DIRECTORY_HANDLE_STORE).delete(userId);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });

  database.close();
}

/** `stats` holds the size and date each of `previousFiles` was read at; a file still the same isn't read again. */
export async function readLocalDirectoryWorkspace(
  userId: string,
  fallbackManifest?: MarkdownWorkspaceManifest,
  previousFiles?: Record<string, string>,
  directoryId?: string,
  stats?: DirectoryStats,
): Promise<LocalDirectoryWorkspace | null> {
  const handle = await getStoredDirectoryHandle(userId, directoryId);
  if (!handle || (await queryDirectoryPermission(handle)) !== "granted") return null;
  const snapshot = await scanWhileFolderSettles(handle.name, () => readDirectoryWorkspace(handle, userId,
    fallbackManifest ?? observedDirectoryWorkspaces.get(userId)?.manifest, previousFiles ?? observedDirectoryWorkspaces.get(userId)?.files,
    previousFiles ? stats : undefined));
  observedDirectoryWorkspaces.set(userId, snapshot.workspace);
  return snapshot;
}

export async function readLocalDirectoryState(
  userId: string,
): Promise<LocalWorkspaceRecord | null> {
  const snapshot = await readLocalDirectoryWorkspace(userId);
  if (!snapshot || !snapshot.workspace.manifest.files.length) return null;
  const state = parseMarkdownWorkspace(snapshot.workspace.manifest, snapshot.workspace.files);
  return state ? { formatVersion: snapshot.workspace.manifest.formatVersion, savedAt: snapshot.savedAt, state } : null;
}

/** expectedWorkspace must be the last folder snapshot incorporated by the caller. */
export function writeLocalDirectoryWorkspace(
  userId: string,
  workspace: MarkdownWorkspace,
  expectedWorkspace: MarkdownWorkspace | null,
  directoryId?: string,
): Promise<LocalDirectoryStatus> {
  const write = directoryWriteQueue.then(async () => {
    const status = await getLocalDirectoryStatus(userId);
    if (status.permission !== "granted") return status;
    const handle = await getStoredDirectoryHandle(userId, directoryId);
    if (!handle) return getLocalDirectoryStatus(userId);
    await writeConnectedDirectoryWorkspace(handle, userId, workspace, expectedWorkspace);
    observedDirectoryWorkspaces.set(userId, workspace);
    return status;
  });
  directoryWriteQueue = write.then(() => undefined, () => undefined);
  return write;
}

export function writeLocalDirectoryState(
  userId: string,
  record: LocalWorkspaceRecord,
): Promise<LocalDirectoryStatus> {
  const previous = observedDirectoryWorkspaces.get(userId) ?? null;
  return writeLocalDirectoryWorkspace(userId, createMarkdownWorkspace(record.state, record.savedAt, previous ?? undefined), previous);
}

/** What a write to the connected folder starts from and should leave there. */
export interface DirectoryWrite {
  /** The Markdown to leave in the folder, and the folder's Markdown as last read. */
  workspace: MarkdownWorkspace;
  expectedWorkspace: MarkdownWorkspace | null;
  /** The vault's files, whose companions (Margin Chat's folders, settings, PDFs and images) go to the folder, and the folder's companions as last read. */
  files: Record<string, VaultFile>;
  expectedFiles: Record<string, VaultFile>;
  /** The size and date each file as last read was read at. */
  stats?: DirectoryStats;
}

/**
 * Writes the vault into the connected folder. Once the folder's Markdown checks out against what was last read,
 * companions go first, then Markdown, so a deleted document's copy in .margin-chat/trash/ (or a replaced one's in
 * .margin-chat/history/) is on disk before the document leaves or changes. Returns the companions now in the
 * folder and the stats of the files it left as they were.
 */
export async function writeConnectedDirectory(handle: FileSystemDirectoryHandle, userId: string, write: DirectoryWrite) {
  let companions: { files: Record<string, VaultFile>; stats: DirectoryStats } | undefined;
  const markdownStats = await writeConnectedDirectoryWorkspace(handle, userId, write.workspace, write.expectedWorkspace, write.stats, async () => {
    companions = await syncConnectedDirectoryCompanions(handle, write.files, write.expectedFiles, write.stats);
  });
  return { companions: companions!.files, stats: { ...markdownStats, ...companions!.stats } };
}

/** Writes the vault into the connected folder (see writeConnectedDirectory); null when it can't be written now. */
export function writeLocalDirectory(userId: string, write: DirectoryWrite, directoryId?: string) {
  const result = directoryWriteQueue.then(async () => {
    const status = await getLocalDirectoryStatus(userId);
    if (status.permission !== "granted") return null;
    const handle = await getStoredDirectoryHandle(userId, directoryId);
    if (!handle) return null;
    const written = await writeConnectedDirectory(handle, userId, write);
    observedDirectoryWorkspaces.set(userId, write.workspace);
    return { status, ...written };
  });
  directoryWriteQueue = result.then(() => undefined, () => undefined);
  return result;
}

/**
 * Also exported to allow storage adapters to verify identical conflict semantics. A Markdown file still the size and
 * date `knownStats` holds for it keeps its text from `previousFiles` instead of being read again.
 */
export async function readDirectoryWorkspace(
  handle: FileSystemDirectoryHandle,
  userId: string,
  fallbackManifest?: MarkdownWorkspaceManifest,
  previousFiles?: Record<string, string>,
  knownStats?: DirectoryStats,
): Promise<LocalDirectoryWorkspace> {
  const manifestRaw = await readDirectoryFileOrNull(handle, getLocalWorkspaceFileName(userId));
  let manifest = fallbackManifest;
  let legacy: LocalWorkspaceRecord | null = null;
  if (manifestRaw !== null) {
    const parsed = JSON.parse(manifestRaw);
    legacy = parseLocalWorkspaceRecord(parsed);
    if (!legacy) {
      const parsedManifest = parseMarkdownWorkspaceManifest(parsed);
      if (!parsedManifest) throw new Error("The connected folder manifest is invalid. Its files were preserved.");
      manifest = parsedManifest;
    }
  }
  const portableMetadata = await readDirectoryFileOrNull(handle, "workspace.json");
  if (portableMetadata !== null) {
    const parsedManifest = parseMarkdownWorkspaceManifest(JSON.parse(portableMetadata));
    if (!parsedManifest) throw new Error("The connected folder settings are invalid. Its files were preserved.");
    manifest = parsedManifest;
  }
  const scanned = await scanMarkdownDirectory(handle, previousFiles && knownStats ? { files: previousFiles, stats: knownStats } : undefined);
  if (legacy && !Object.keys(scanned.files).length) {
    return { workspace: createMarkdownWorkspace(legacy.state, legacy.savedAt), savedAt: legacy.savedAt, stats: {} };
  }
  const workspace = discoverMarkdownWorkspace(scanned.files, manifest, previousFiles);
  if (!parseMarkdownWorkspace(workspace.manifest, workspace.files)) {
    throw new Error("A connected Markdown file could not be read. Its files were preserved.");
  }
  const savedAt = new Date(Math.max(scanned.latestModified, Date.parse(workspace.manifest.savedAt))).toISOString();
  return { workspace, savedAt, modifiedAt: scanned.modifiedAt, stats: scanned.stats };
}

/**
 * `knownStats` holds the size and date each of expectedWorkspace's files was read at. Returns the same for the
 * Markdown files this write left as they were; a file it wrote or removed has none until a scan reads it.
 * `beforeChanges` runs once the folder's Markdown checks out, before any of it changes.
 */
export async function writeConnectedDirectoryWorkspace(
  handle: FileSystemDirectoryHandle,
  userId: string,
  workspace: MarkdownWorkspace,
  expectedWorkspace: MarkdownWorkspace | null,
  knownStats?: DirectoryStats,
  beforeChanges?: () => Promise<void>,
): Promise<DirectoryStats> {
  for (const path of Object.keys(workspace.files)) {
    if (!isSafeMarkdownPath(path)) throw new Error(`Invalid Markdown path: ${path}`);
  }
  const manifestName = getLocalWorkspaceFileName(userId);
  const manifestBefore = await readDirectoryFileOrNull(handle, manifestName);
  const actual = await scanWhileFolderSettles(handle.name, () => readDirectoryWorkspace(handle, userId, expectedWorkspace?.manifest, expectedWorkspace?.files,
    expectedWorkspace ? knownStats : undefined));
  const expectedFiles = markdownContentFiles(expectedWorkspace?.files ?? {});
  const desiredFiles = markdownContentFiles(workspace.files);
  const conflicts = changedFilePaths(expectedFiles, actual.workspace.files);
  if (expectedWorkspace && stableSerialize(expectedWorkspace.manifest.workspace) !== stableSerialize(actual.workspace.manifest.workspace)) {
    conflicts.push(manifestName);
  }
  if (conflicts.length) throw new LocalDirectoryConflictError(conflicts);
  // Look again for changes made during that read; a file unchanged since then costs only its size and date.
  const disk = await scanWhileFolderSettles(handle.name, () => scanMarkdownDirectory(handle, { files: actual.workspace.files, stats: actual.stats }));
  const diskFiles = disk.files;
  // A legacy JSON-only workspace has synthetic Markdown in its read snapshot.
  const legacyOnly = manifestBefore !== null && Object.keys(diskFiles).length === 0
    && parseLocalWorkspaceRecord(JSON.parse(manifestBefore)) !== null;
  if (!legacyOnly) {
    const changedDuringRead = changedFilePaths(expectedFiles, diskFiles);
    if (changedDuringRead.length) throw new LocalDirectoryConflictError(changedDuringRead);
  }
  const changes = changedFilePaths(diskFiles, desiredFiles);
  await beforeChanges?.();
  const stats = { ...disk.stats };
  for (const path of changes) {
    // Check once more immediately before changing a file, from its bytes on disk; external editors do not share our queue.
    const current = await readDirectoryFileOrNull(handle, path);
    if (current !== (diskFiles[path] ?? null)) throw new LocalDirectoryConflictError([path]);
    const next = desiredFiles[path];
    delete stats[path];
    if (next === undefined) await removeDirectoryFile(handle, path);
    else await writeDirectoryFile(handle, path, next);
  }
  const serializedManifest = `${JSON.stringify(workspace.manifest, null, 2)}\n`;
  if (serializedManifest !== manifestBefore) {
    if (await readDirectoryFileOrNull(handle, manifestName) !== manifestBefore) throw new LocalDirectoryConflictError([manifestName]);
    await writeDirectoryFile(handle, manifestName, serializedManifest);
  }
  return stats;
}

function changedFilePaths(left: Record<string, string>, right: Record<string, string>) {
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].filter((path) => left[path] !== right[path]);
}

function markdownContentFiles(files: Record<string, string>) {
  return Object.fromEntries(Object.entries(files).filter(([path]) => !isCompanionPath(path)));
}

/** Files synced byte for byte beside the Markdown: Margin Chat's own folders, and PDFs and images. */
export function isCompanionPath(path: string) {
  return path === "workspace.json" || /^(?:attachments|_conflicts|\.margin-chat)\/.+/i.test(path) || isVaultFileDocumentPath(path);
}

function companionFiles(files: Record<string, VaultFile>) {
  for (const path of Object.keys(files)) {
    if (!validVaultPath(path)) throw new Error(`Invalid vault companion path: ${path}`);
  }
  return Object.fromEntries(Object.entries(files).filter(([path]) => isCompanionPath(path)));
}

export async function readLocalDirectoryCompanions(
  userId: string,
  knownFiles?: Record<string, VaultFile>,
  directoryId?: string,
  listing?: VaultFileListing[],
  stats?: DirectoryStats,
): Promise<{ files: Record<string, VaultFile>; stats: DirectoryStats } | null> {
  const handle = await getStoredDirectoryHandle(userId, directoryId);
  if (!handle || (await queryDirectoryPermission(handle)) !== "granted") return null;
  return scanWhileFolderSettles(handle.name, () => readConnectedDirectoryCompanions(handle, knownFiles, listing, stats));
}

/** The PDFs and images in the connected folder, with their sizes and dates. */
export async function listLocalDirectoryFiles(userId: string, directoryId?: string): Promise<VaultFileListing[] | null> {
  const handle = await getStoredDirectoryHandle(userId, directoryId);
  if (!handle || (await queryDirectoryPermission(handle)) !== "granted") return null;
  return scanWhileFolderSettles(handle.name, () => listConnectedDirectoryFiles(handle));
}

export async function listConnectedDirectoryFiles(handle: FileSystemDirectoryHandle, prefix = ""): Promise<VaultFileListing[]> {
  const listings: VaultFileListing[] = [];
  const entries = handle as FileSystemDirectoryHandle & { entries(): AsyncIterableIterator<[string, FileSystemHandle]> };
  for await (const [name, entry] of entries.entries()) {
    if (name.startsWith(".")) continue;
    const path = prefix ? `${prefix}/${name}` : name;
    if (/^(?:attachments|_conflicts|\.margin-chat)(?:\/|$)/i.test(path)) continue;
    if (entry.kind === "directory") listings.push(...await listConnectedDirectoryFiles(entry as FileSystemDirectoryHandle, path));
    else if (isVaultFileDocumentPath(path) && validVaultPath(path)) {
      try {
        const file = await (entry as FileSystemFileHandle).getFile();
        listings.push({ path, size: file.size, ...(file.lastModified > 0 ? { modifiedAt: new Date(file.lastModified).toISOString() } : {}),
          ...(isSyncableVaultFileSize(file.size) ? {} : { localOnly: true }) });
      } catch { /* A file removed mid-scan is picked up by the next one. */ }
    }
  }
  return listings;
}

/**
 * Whether the connected folder itself can be listed. Reading a missing folder's
 * files can look like reading an empty one, so check the folder first.
 */
export async function localDirectoryAvailability(userId: string, directoryId?: string): Promise<"available" | "missing" | "refused"> {
  const handle = await getStoredDirectoryHandle(userId, directoryId);
  if (!handle) return "missing";
  const entries = (handle as FileSystemDirectoryHandle & { entries(): AsyncIterableIterator<[string, FileSystemHandle]> }).entries();
  try {
    await entries.next();
    return "available";
  } catch (error) {
    if (isDomExceptionNamed(error, "NotFoundError")) return "missing";
    if (isDomExceptionNamed(error, "NotAllowedError") || isDomExceptionNamed(error, "SecurityError")) return "refused";
    throw error;
  } finally {
    await entries.return?.().catch(() => undefined);
  }
}

/** A file read straight from the connected folder, for one too large to sync. */
export async function readLocalDirectoryFile(userId: string, path: string, directoryId?: string): Promise<Blob | null> {
  if (!validVaultPath(path)) return null;
  const handle = await getStoredDirectoryHandle(userId, directoryId);
  if (!handle || (await queryDirectoryPermission(handle)) !== "granted") return null;
  try {
    const file = await (await getNestedFileHandle(handle, path)).getFile();
    return new Blob([file], { type: vaultFileContentType(path) });
  } catch (error) {
    if (isDomExceptionNamed(error, "NotFoundError")) return null;
    throw error;
  }
}

const CONFLICT_NOTE = /^(?:_conflicts|\.margin-chat\/history)\/[^/]+\/conflict\.json$/i;

/**
 * Scan managed namespaces and use prior file records as encoding/type hints. A file still the size and date
 * `knownStats` holds for it keeps its record from `knownFiles` instead of being read again. Returns the files
 * and, for those read or kept, the size and date of their bytes.
 */
export async function readConnectedDirectoryCompanions(
  handle: FileSystemDirectoryHandle,
  knownFiles?: Record<string, VaultFile>,
  listing?: VaultFileListing[],
  knownStats?: DirectoryStats,
): Promise<{ files: Record<string, VaultFile>; stats: DirectoryStats }> {
  const known = knownFiles ? companionFiles(knownFiles) : null;
  const files = listing ?? await listConnectedDirectoryFiles(handle);
  // A file too large to sync stays in the folder; it opens from there on this device.
  const localOnly = new Set(files.filter((file) => file.localOnly).map((file) => file.path));
  const paths: string[] = [...Object.keys(known ?? {}), "workspace.json", ...files.filter((file) => !file.localOnly).map((file) => file.path)]
    .filter((path) => !localOnly.has(path));
  const entries = handle as FileSystemDirectoryHandle & { entries(): AsyncIterableIterator<[string, FileSystemHandle]> };
  for await (const [name, entry] of entries.entries()) {
    if (entry.kind === "directory" && /^(?:attachments|_conflicts|\.margin-chat)$/i.test(name)) {
      await collectCompanionPaths(entry as FileSystemDirectoryHandle, name, paths);
    }
  }
  const bytesByPath = new Map<string, Uint8Array>();
  const reused: Record<string, VaultFile> = {};
  const stats: DirectoryStats = {};
  for (const path of new Set(paths)) {
    if (!validVaultPath(path) || !isCompanionPath(path)) throw new Error(`Invalid vault companion path: ${path}`);
    // A file unchanged on disk since its known record was read costs only its size and date.
    const record = known?.[path];
    const stat = knownStats?.[path];
    if (record && stat) {
      const file = await directoryFileInfoOrNull(handle, path);
      if (!file) continue;
      if (unchangedSince(file, stat)) {
        reused[path] = record;
        stats[path] = stat;
        continue;
      }
    }
    const read = await readDirectoryBytesWithStat(handle, path);
    if (!read) continue;
    bytesByPath.set(path, read.bytes);
    if (read.stat) stats[path] = read.stat;
  }
  // Conflict notes say which copies hold binary bytes, whether read now or kept from before.
  const notes: string[] = [];
  for (const [path, bytes] of bytesByPath) {
    if (!CONFLICT_NOTE.test(path)) continue;
    try { notes.push(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { /* Not a readable note. */ }
  }
  for (const [path, file] of Object.entries(reused)) if (CONFLICT_NOTE.test(path) && !file.encoding) notes.push(file.content);
  const binaryCopies = new Set<string>();
  for (const note of notes) {
    try {
      const descriptor = JSON.parse(note);
      if (descriptor.localEncoding === "base64" && typeof descriptor.copy === "string") binaryCopies.add(descriptor.copy);
      if (descriptor.remoteEncoding === "base64" && typeof descriptor.remoteCopy === "string") binaryCopies.add(descriptor.remoteCopy);
      if (descriptor.baseEncoding === "base64" && typeof descriptor.baseCopy === "string") binaryCopies.add(descriptor.baseCopy);
      if (descriptor.resultEncoding === "base64" && typeof descriptor.resultCopy === "string") binaryCopies.add(descriptor.resultCopy);
      if (typeof descriptor.path === "string" && /^attachments\//i.test(descriptor.path)
        && !/\/metadata\.json$/u.test(descriptor.path)
      ) {
        for (const copy of [descriptor.copy, descriptor.remoteCopy, descriptor.baseCopy, descriptor.resultCopy]) if (typeof copy === "string") binaryCopies.add(copy);
      }
    } catch { /* Preserve unreadable conflict notes as files; they are not authoritative sync controls. */ }
  }
  const companions: Record<string, VaultFile> = { ...reused };
  for (const [path, bytes] of bytesByPath) {
    const metadata = known?.[path];
    const binary = metadata ? metadata.encoding === "base64" : binaryCopies.has(path)
      || /^attachments\//i.test(path) && !/\/metadata\.json$/u.test(path) || !/\.(?:md|markdown|json|txt)$/i.test(path);
    companions[path] = {
      content: binary ? bytesToBase64(bytes) : new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ...(binary ? { encoding: "base64" as const } : {}),
      ...(metadata?.contentType ? { contentType: metadata.contentType }
        : isVaultFileDocumentPath(path) ? { contentType: vaultFileContentType(path) } : {}),
    };
  }
  return { files: companions, stats };
}

const sameCompanion = (a: VaultFile | undefined, b: VaultFile | undefined) =>
  !!a && !!b && a.content === b.content && (a.encoding ?? "utf8") === (b.encoding ?? "utf8");

/**
 * Reject changed bytes before a batch and again immediately before each mutation. Every file is written before
 * any is removed, so a deleted document's copy in .margin-chat/trash/ is on disk first. `knownStats` holds the size
 * and date each expected file was read at; returns the same for the files this sync left as they were.
 */
export async function syncConnectedDirectoryCompanions(
  handle: FileSystemDirectoryHandle,
  nextFiles: Record<string, VaultFile>,
  expectedFiles: Record<string, VaultFile>,
  knownStats?: DirectoryStats,
): Promise<{ files: Record<string, VaultFile>; stats: DirectoryStats }> {
  const next = companionFiles(nextFiles);
  const expected = companionFiles(expectedFiles);
  const all = [...new Set([...Object.keys(next), ...Object.keys(expected)])];
  const stats: DirectoryStats = {};
  // A file this write leaves alone, still the size and date it had when its expected bytes were read, isn't read and compared again.
  const unchangedOnDisk = new Set<string>();
  for (const path of all) {
    const stat = knownStats?.[path];
    if (!stat || !sameCompanion(next[path], expected[path])) continue;
    const file = await directoryFileInfoOrNull(handle, path);
    if (file && unchangedSince(file, stat)) {
      unchangedOnDisk.add(path);
      stats[path] = stat;
    }
  }
  const paths = all.filter((path) => !unchangedOnDisk.has(path));
  const expectedBytes = new Map(paths.map((path) => [path, expected[path] ? companionBytes(expected[path]) : null]));
  const nextBytes = new Map(paths.map((path) => [path, next[path] ? companionBytes(next[path]) : null]));
  const conflicts: string[] = [];
  const changes: string[] = [];
  for (const path of paths) {
    const current = await readDirectoryBytesWithStat(handle, path);
    if (!sameBytes(current?.bytes ?? null, expectedBytes.get(path)!)) conflicts.push(path);
    else if (!sameBytes(nextBytes.get(path)!, expectedBytes.get(path)!)) changes.push(path);
    else if (current?.stat) stats[path] = current.stat;
  }
  if (conflicts.length) throw new LocalDirectoryConflictError(conflicts);
  const writes = changes.filter((path) => nextBytes.get(path) !== null);
  const removals = changes.filter((path) => nextBytes.get(path) === null);
  for (const path of [...writes, ...removals]) {
    const bytes = nextBytes.get(path)!;
    if (!sameBytes(await readDirectoryBytesOrNull(handle, path), expectedBytes.get(path)!)) throw new LocalDirectoryConflictError([path]);
    if (bytes === null) await removeDirectoryFile(handle, path);
    else await writeDirectoryBytes(handle, path, bytes);
  }
  // Copies of the records; their (possibly very large) contents are immutable strings, shared.
  return { files: Object.fromEntries(Object.entries(next).map(([path, file]) => [path, { ...file }])), stats };
}

async function collectCompanionPaths(handle: FileSystemDirectoryHandle, prefix: string, paths: string[]) {
  const entries = handle as FileSystemDirectoryHandle & { entries(): AsyncIterableIterator<[string, FileSystemHandle]> };
  for await (const [name, entry] of entries.entries()) {
    const path = `${prefix}/${name}`;
    if (!validVaultPath(path)) throw new Error(`Invalid vault companion path: ${path}`);
    if (entry.kind === "directory") await collectCompanionPaths(entry as FileSystemDirectoryHandle, path, paths);
    else paths.push(path);
  }
}

function companionBytes(file: VaultFile): Uint8Array {
  return file.encoding === "base64"
    ? Uint8Array.from(atob(file.content), (character) => character.charCodeAt(0))
    : new TextEncoder().encode(file.content);
}

function bytesToBase64(bytes: Uint8Array) {
  let result = "";
  for (let index = 0; index < bytes.length; index += 8192) result += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(result);
}

function sameBytes(left: Uint8Array | null, right: Uint8Array | null) {
  return left === null || right === null ? left === right
    : left.length === right.length && left.every((byte, index) => byte === right[index]);
}

async function directoryFileInfoOrNull(handle: FileSystemDirectoryHandle, path: string): Promise<File | null> {
  try {
    return await (await getNestedFileHandle(handle, path)).getFile();
  } catch (error) {
    if (isDomExceptionNamed(error, "NotFoundError")) return null;
    throw error;
  }
}

async function readDirectoryBytesOrNull(handle: FileSystemDirectoryHandle, path: string): Promise<Uint8Array | null> {
  try {
    return await readFreshBytes(() => getNestedFileHandle(handle, path));
  } catch (error) {
    if (isDomExceptionNamed(error, "NotFoundError")) return null;
    throw error;
  }
}

/**
 * Some disks keep file dates only to the second (or two), so a file saved again within the same second keeps its
 * date, and can keep its size. Bytes read this soon after their file's date get no stats and are read again.
 */
const SAME_DATE_MS = 3_000;

/** The size and date of the bytes just read from this snapshot, or null when they couldn't tell a later change apart. */
function statWhenRead(file: File, readStartedAt: number): DirectoryFileStat | null {
  return file.lastModified > 0 && readStartedAt - file.lastModified >= SAME_DATE_MS ? [file.size, file.lastModified] : null;
}

/** Whether a file is still the size and date it had when its saved bytes were read. */
function unchangedSince(file: File, stat: DirectoryFileStat | undefined) {
  return !!stat && stat[1] > 0 && file.size === stat[0] && file.lastModified === stat[1];
}

/** A file's bytes with, from the same snapshot, their size and date; null when the file doesn't exist. */
async function readDirectoryBytesWithStat(handle: FileSystemDirectoryHandle, path: string) {
  const readStartedAt = Date.now();
  try {
    return await readFreshFile(() => getNestedFileHandle(handle, path),
      async (file) => ({ bytes: new Uint8Array(await file.arrayBuffer()), stat: statWhenRead(file, readStartedAt) }));
  } catch (error) {
    if (isDomExceptionNamed(error, "NotFoundError")) return null;
    throw error;
  }
}

async function writeDirectoryBytes(handle: FileSystemDirectoryHandle, path: string, bytes: Uint8Array) {
  const segments = path.split("/");
  const name = segments.pop()!;
  let directory = handle;
  for (const segment of segments) directory = await directory.getDirectoryHandle(segment, { create: true });
  const file = await directory.getFileHandle(name, { create: true });
  const writer = await file.createWritable();
  try {
    await writer.write(new Uint8Array(bytes).buffer);
    await writer.close();
  } catch (error) {
    await writer.abort?.().catch(() => undefined);
    throw error;
  }
}

async function readDirectoryFileOrNull(handle: FileSystemDirectoryHandle, path: string) {
  try {
    return await readFreshText(() => getNestedFileHandle(handle, path));
  } catch (error) {
    if (isDomExceptionNamed(error, "NotFoundError")) return null;
    throw error;
  }
}

/**
 * Reads the folder's Markdown files. A file still the size and date `known.stats` holds for it keeps its text from
 * `known.files`, so an unchanged folder costs its listing and file sizes and dates, not its files' text.
 */
async function scanMarkdownDirectory(handle: FileSystemDirectoryHandle, known?: { files: Record<string, string>; stats: DirectoryStats }, prefix = "") {
  const files: Record<string, string> = {};
  const modifiedAt: Record<string, string> = {};
  const stats: DirectoryStats = {};
  let latestModified = 0;
  const entries = handle as FileSystemDirectoryHandle & { entries(): AsyncIterableIterator<[string, FileSystemHandle]> };
  for await (const [name, entry] of entries.entries()) {
    if (name.startsWith(".")) continue;
    const path = prefix ? `${prefix}/${name}` : name;
    if (/^(?:attachments|_conflicts|\.margin-chat)(?:\/|$)/i.test(path)) continue;
    if (entry.kind === "directory") {
      const child = await scanMarkdownDirectory(entry as FileSystemDirectoryHandle, known, path);
      Object.assign(files, child.files);
      Object.assign(modifiedAt, child.modifiedAt);
      Object.assign(stats, child.stats);
      latestModified = Math.max(latestModified, child.latestModified);
    } else if (isSafeMarkdownPath(path)) {
      const fileHandle = entry as FileSystemFileHandle;
      const saved = known && Object.hasOwn(known.files, path) ? known.files[path] : undefined;
      const stat = known && Object.hasOwn(known.stats, path) ? known.stats[path] : undefined;
      const current = saved !== undefined && stat ? await fileHandle.getFile() : null;
      let lastModified: number;
      if (current && unchangedSince(current, stat)) {
        files[path] = saved!;
        stats[path] = stat!;
        lastModified = current.lastModified;
      } else {
        const readStartedAt = Date.now();
        const read = await readFreshFile(async () => fileHandle, async (file) => ({ text: await file.text(), file }));
        files[path] = read.text;
        const readStat = statWhenRead(read.file, readStartedAt);
        if (readStat) stats[path] = readStat;
        lastModified = read.file.lastModified;
      }
      if (lastModified > 0) modifiedAt[path] = new Date(lastModified).toISOString();
      latestModified = Math.max(latestModified, lastModified);
    }
  }
  return { files, modifiedAt, stats, latestModified };
}

async function removeDirectoryFile(handle: FileSystemDirectoryHandle, path: string) {
  const segments = path.split("/");
  const name = segments.pop()!;
  let directory = handle;
  for (const segment of segments) directory = await directory.getDirectoryHandle(segment);
  await directory.removeEntry(name);
}

function supportsDirectoryPicker() {
  return (
    typeof window !== "undefined" &&
    // Chrome only permits the directory picker in a top-level browsing context.
    window.top === window &&
    typeof (window as Partial<DirectoryPickerWindow>).showDirectoryPicker ===
      "function" &&
    typeof indexedDB !== "undefined"
  );
}

async function buildDirectoryStatus(
  handle: FileSystemDirectoryHandle,
  fileName: string,
  directoryId?: string,
): Promise<LocalDirectoryStatus> {
  return {
    directoryId,
    directoryName: handle.name,
    fileName,
    permission: await queryDirectoryPermission(handle),
    supported: true,
  };
}

async function queryDirectoryPermission(
  handle: FileSystemDirectoryHandle,
): Promise<FileSystemPermissionState> {
  const permissionHandle = handle as Partial<PermissionCapableDirectoryHandle>;

  if (typeof permissionHandle.queryPermission !== "function") {
    return "granted";
  }

  return permissionHandle.queryPermission({ mode: "readwrite" });
}

async function getStoredDirectoryHandle(
  userId: string,
  expectedId?: string,
): Promise<FileSystemDirectoryHandle | null> {
  const selection = await getStoredDirectorySelection(userId);
  if (expectedId && selection?.id !== expectedId) throw new Error("The connected folder changed. Read the selected folder before saving.");
  return selection?.handle ?? null;
}

interface DirectoryIdentity { id: string; handle: FileSystemDirectoryHandle }
interface DirectorySelection extends DirectoryIdentity { directories: DirectoryIdentity[] }

async function getStoredDirectorySelection(userId: string): Promise<DirectorySelection | null> {
  if (!supportsDirectoryPicker()) {
    return null;
  }

  const database = await openDirectoryDatabase();
  const stored = await new Promise<FileSystemDirectoryHandle | DirectorySelection | null>(
    (resolve, reject) => {
      const transaction = database.transaction(DIRECTORY_HANDLE_STORE, "readonly");
      const request = transaction.objectStore(DIRECTORY_HANDLE_STORE).get(userId);
      request.onsuccess = () =>
        resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    },
  );

  database.close();
  if (!stored) return null;
  if ("handle" in stored) return stored;
  // Upgrade old saved handles without inventing a baseline for unseen disk content.
  const identity = { id: crypto.randomUUID(), handle: stored };
  const selection = { ...identity, directories: [identity] };
  await setStoredDirectorySelection(userId, selection);
  return selection;
}

async function setStoredDirectorySelection(
  userId: string,
  selection: DirectorySelection,
) {
  const database = await openDirectoryDatabase();

  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(DIRECTORY_HANDLE_STORE, "readwrite");
    transaction.objectStore(DIRECTORY_HANDLE_STORE).put(selection, userId);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });

  database.close();
}

function openDirectoryDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(
      DIRECTORY_DATABASE_NAME,
      DIRECTORY_DATABASE_VERSION,
    );

    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DIRECTORY_HANDLE_STORE)) {
        request.result.createObjectStore(DIRECTORY_HANDLE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(
        ([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`,
      )
      .join(",")}}`;
  }

  return JSON.stringify(value) ?? "null";
}

async function writeDirectoryFile(
  handle: FileSystemDirectoryHandle,
  path: string,
  contents: string,
) {
  const segments = path.split("/");
  const fileName = segments.pop();
  if (!fileName) throw new Error("Local workspace file path is invalid.");

  let directory = handle;
  for (const segment of segments) {
    directory = await directory.getDirectoryHandle(segment, { create: true });
  }

  const fileHandle = await directory.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();

  try {
    await writable.write(contents);
    await writable.close();
  } catch (error) {
    // Aborting leaves the file as it was; closing would replace it with whatever was written before the failure.
    await writable.abort?.().catch(() => undefined);
    throw error;
  }
}

async function getNestedFileHandle(
  handle: FileSystemDirectoryHandle,
  path: string,
) {
  const segments = path.split("/");
  const fileName = segments.pop();
  if (!fileName) throw new Error("Local workspace file path is invalid.");

  let directory = handle;
  for (const segment of segments) {
    directory = await directory.getDirectoryHandle(segment);
  }

  return directory.getFileHandle(fileName);
}

function isDomExceptionNamed(error: unknown, name: string) {
  return (
    (typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      error.name === name) ||
    (error instanceof Error && error.name === name)
  );
}
