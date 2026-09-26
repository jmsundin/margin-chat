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
import { validVaultPath, type VaultFile } from "./vaultTypes";

const DIRECTORY_DATABASE_NAME = "margin-chat-local-storage";
const DIRECTORY_DATABASE_VERSION = 1;
const DIRECTORY_HANDLE_STORE = "directory-handles";
const LOCAL_FILE_FORMAT_VERSION = 1;

type FileSystemPermissionState = "denied" | "granted" | "prompt";
type PermissionCapableDirectoryHandle = FileSystemDirectoryHandle & {
  queryPermission(options?: {
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

export interface LocalDirectoryWorkspace {
  workspace: MarkdownWorkspace;
  savedAt: string;
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

export async function readLocalDirectoryWorkspace(
  userId: string,
  fallbackManifest?: MarkdownWorkspaceManifest,
  previousFiles?: Record<string, string>,
  directoryId?: string,
): Promise<LocalDirectoryWorkspace | null> {
  const handle = await getStoredDirectoryHandle(userId, directoryId);
  if (!handle || (await queryDirectoryPermission(handle)) !== "granted") return null;
  const snapshot = await readDirectoryWorkspace(handle, userId, fallbackManifest ?? observedDirectoryWorkspaces.get(userId)?.manifest, previousFiles ?? observedDirectoryWorkspaces.get(userId)?.files);
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

/** Also exported to allow storage adapters to verify identical conflict semantics. */
export async function readDirectoryWorkspace(
  handle: FileSystemDirectoryHandle,
  userId: string,
  fallbackManifest?: MarkdownWorkspaceManifest,
  previousFiles?: Record<string, string>,
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
  const scanned = await scanMarkdownDirectory(handle);
  if (legacy && !Object.keys(scanned.files).length) {
    return { workspace: createMarkdownWorkspace(legacy.state, legacy.savedAt), savedAt: legacy.savedAt };
  }
  const workspace = discoverMarkdownWorkspace(scanned.files, manifest, previousFiles);
  if (!parseMarkdownWorkspace(workspace.manifest, workspace.files)) {
    throw new Error("A connected Markdown file could not be read. Its files were preserved.");
  }
  const savedAt = new Date(Math.max(scanned.latestModified, Date.parse(workspace.manifest.savedAt))).toISOString();
  return { workspace, savedAt };
}

export async function writeConnectedDirectoryWorkspace(
  handle: FileSystemDirectoryHandle,
  userId: string,
  workspace: MarkdownWorkspace,
  expectedWorkspace: MarkdownWorkspace | null,
) {
  for (const path of Object.keys(workspace.files)) {
    if (!isSafeMarkdownPath(path)) throw new Error(`Invalid Markdown path: ${path}`);
  }
  const manifestName = getLocalWorkspaceFileName(userId);
  const manifestBefore = await readDirectoryFileOrNull(handle, manifestName);
  const actual = await readDirectoryWorkspace(handle, userId, expectedWorkspace?.manifest, expectedWorkspace?.files);
  const expectedFiles = markdownContentFiles(expectedWorkspace?.files ?? {});
  const desiredFiles = markdownContentFiles(workspace.files);
  const conflicts = changedFilePaths(expectedFiles, actual.workspace.files);
  if (expectedWorkspace && stableSerialize(expectedWorkspace.manifest.workspace) !== stableSerialize(actual.workspace.manifest.workspace)) {
    conflicts.push(manifestName);
  }
  if (conflicts.length) throw new LocalDirectoryConflictError(conflicts);
  const diskFiles = (await scanMarkdownDirectory(handle)).files;
  // A legacy JSON-only workspace has synthetic Markdown in its read snapshot.
  const legacyOnly = manifestBefore !== null && Object.keys(diskFiles).length === 0
    && parseLocalWorkspaceRecord(JSON.parse(manifestBefore)) !== null;
  if (!legacyOnly) {
    const changedDuringRead = changedFilePaths(expectedFiles, diskFiles);
    if (changedDuringRead.length) throw new LocalDirectoryConflictError(changedDuringRead);
  }
  const changes = changedFilePaths(diskFiles, desiredFiles);
  for (const path of changes) {
    const current = await readDirectoryFileOrNull(handle, path);
    // Check once more immediately before changing a file; external editors do not share our queue.
    if (current !== (diskFiles[path] ?? null)) throw new LocalDirectoryConflictError([path]);
    const next = desiredFiles[path];
    if (next === undefined) await removeDirectoryFile(handle, path);
    else await writeDirectoryFile(handle, path, next);
  }
  if (await readDirectoryFileOrNull(handle, manifestName) !== manifestBefore) {
    throw new LocalDirectoryConflictError([manifestName]);
  }
  const serializedManifest = `${JSON.stringify(workspace.manifest, null, 2)}\n`;
  if (serializedManifest !== manifestBefore) await writeDirectoryFile(handle, manifestName, serializedManifest);
}

function changedFilePaths(left: Record<string, string>, right: Record<string, string>) {
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].filter((path) => left[path] !== right[path]);
}

function markdownContentFiles(files: Record<string, string>) {
  return Object.fromEntries(Object.entries(files).filter(([path]) => !isCompanionPath(path)));
}

function isCompanionPath(path: string) {
  return path === "workspace.json" || /^(?:attachments|_conflicts)\/.+/i.test(path);
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
): Promise<Record<string, VaultFile> | null> {
  const handle = await getStoredDirectoryHandle(userId, directoryId);
  if (!handle || (await queryDirectoryPermission(handle)) !== "granted") return null;
  return readConnectedDirectoryCompanions(handle, knownFiles);
}

export function syncLocalDirectoryCompanions(
  userId: string,
  nextFiles: Record<string, VaultFile>,
  expectedFiles: Record<string, VaultFile>,
  directoryId?: string,
): Promise<Record<string, VaultFile> | null> {
  const write = directoryWriteQueue.then(async () => {
    const handle = await getStoredDirectoryHandle(userId, directoryId);
    if (!handle || (await queryDirectoryPermission(handle)) !== "granted") return null;
    return syncConnectedDirectoryCompanions(handle, nextFiles, expectedFiles);
  });
  directoryWriteQueue = write.then(() => undefined, () => undefined);
  return write;
}

/** Scan managed namespaces and use prior file records as encoding/type hints. */
export async function readConnectedDirectoryCompanions(
  handle: FileSystemDirectoryHandle,
  knownFiles?: Record<string, VaultFile>,
): Promise<Record<string, VaultFile>> {
  const known = knownFiles ? companionFiles(knownFiles) : null;
  const paths: string[] = [...Object.keys(known ?? {}), "workspace.json"];
  const entries = handle as FileSystemDirectoryHandle & { entries(): AsyncIterableIterator<[string, FileSystemHandle]> };
  for await (const [name, entry] of entries.entries()) {
    if (entry.kind === "directory" && /^(?:attachments|_conflicts)$/i.test(name)) {
      await collectCompanionPaths(entry as FileSystemDirectoryHandle, name, paths);
    }
  }
  const bytesByPath = new Map<string, Uint8Array>();
  for (const path of new Set(paths)) {
    if (!validVaultPath(path) || !isCompanionPath(path)) throw new Error(`Invalid vault companion path: ${path}`);
    const bytes = await readDirectoryBytesOrNull(handle, path);
    if (bytes !== null) bytesByPath.set(path, bytes);
  }
  const binaryCopies = new Set<string>();
  for (const [path, bytes] of bytesByPath) {
    if (!/^_conflicts\/[^/]+\/conflict\.json$/i.test(path)) continue;
    try {
      const descriptor = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
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
  const files: Record<string, VaultFile> = {};
  for (const [path, bytes] of bytesByPath) {
    const metadata = known?.[path];
    const binary = metadata ? metadata.encoding === "base64" : binaryCopies.has(path)
      || /^attachments\//i.test(path) && !/\/metadata\.json$/u.test(path) || !/\.(?:md|markdown|json|txt)$/i.test(path);
    files[path] = {
      content: binary ? bytesToBase64(bytes) : new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ...(binary ? { encoding: "base64" as const } : {}),
      ...(metadata?.contentType ? { contentType: metadata.contentType } : {}),
    };
  }
  return files;
}

/** Reject changed bytes before a batch and again immediately before each mutation. */
export async function syncConnectedDirectoryCompanions(
  handle: FileSystemDirectoryHandle,
  nextFiles: Record<string, VaultFile>,
  expectedFiles: Record<string, VaultFile>,
): Promise<Record<string, VaultFile>> {
  const next = companionFiles(nextFiles);
  const expected = companionFiles(expectedFiles);
  const paths = [...new Set([...Object.keys(next), ...Object.keys(expected)])];
  const expectedBytes = new Map(paths.map((path) => [path, expected[path] ? companionBytes(expected[path]) : null]));
  const nextBytes = new Map(paths.map((path) => [path, next[path] ? companionBytes(next[path]) : null]));
  const conflicts: string[] = [];
  for (const path of paths) {
    const current = await readDirectoryBytesOrNull(handle, path);
    if (!sameBytes(current, expectedBytes.get(path)!)) conflicts.push(path);
  }
  if (conflicts.length) throw new LocalDirectoryConflictError(conflicts);
  for (const path of paths) {
    const bytes = nextBytes.get(path)!;
    const previous = expectedBytes.get(path)!;
    if (sameBytes(bytes, previous)) continue;
    if (!sameBytes(await readDirectoryBytesOrNull(handle, path), previous)) throw new LocalDirectoryConflictError([path]);
    if (bytes === null) await removeDirectoryFile(handle, path);
    else await writeDirectoryBytes(handle, path, bytes);
  }
  return structuredClone(next);
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

async function readDirectoryBytesOrNull(handle: FileSystemDirectoryHandle, path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await (await (await getNestedFileHandle(handle, path)).getFile()).arrayBuffer());
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
    return await (await (await getNestedFileHandle(handle, path)).getFile()).text();
  } catch (error) {
    if (isDomExceptionNamed(error, "NotFoundError")) return null;
    throw error;
  }
}

async function scanMarkdownDirectory(handle: FileSystemDirectoryHandle, prefix = "") {
  const files: Record<string, string> = {};
  let latestModified = 0;
  const entries = handle as FileSystemDirectoryHandle & { entries(): AsyncIterableIterator<[string, FileSystemHandle]> };
  for await (const [name, entry] of entries.entries()) {
    if (name.startsWith(".")) continue;
    const path = prefix ? `${prefix}/${name}` : name;
    if (/^(?:attachments|_conflicts)(?:\/|$)/i.test(path)) continue;
    if (entry.kind === "directory") {
      const child = await scanMarkdownDirectory(entry as FileSystemDirectoryHandle, path);
      Object.assign(files, child.files);
      latestModified = Math.max(latestModified, child.latestModified);
    } else if (isSafeMarkdownPath(path)) {
      const file = await (entry as FileSystemFileHandle).getFile();
      files[path] = await file.text();
      latestModified = Math.max(latestModified, file.lastModified);
    }
  }
  return { files, latestModified };
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
  } finally {
    await writable.close();
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
