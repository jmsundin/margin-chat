import type { AppState, AuthenticatedUser } from "../types";
import {
  createMarkdownWorkspace,
  parseMarkdownWorkspace,
  parseMarkdownWorkspaceManifest,
  type MarkdownWorkspaceManifest,
} from "./workspaceMarkdown";
import { createWorkspaceDocument } from "./workspaceModel";

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

  const handle = await getStoredDirectoryHandle(userId);

  if (!handle) {
    return {
      directoryName: null,
      fileName,
      permission: "unselected",
      supported: true,
    };
  }

  return buildDirectoryStatus(handle, fileName);
}

export async function chooseLocalDirectory(
  userId: string,
): Promise<LocalDirectoryStatus> {
  if (!supportsDirectoryPicker()) {
    return getLocalDirectoryStatus(userId);
  }

  const handle = await (
    window as unknown as DirectoryPickerWindow
  ).showDirectoryPicker({
    id: "margin-chat-workspaces",
    mode: "readwrite",
  });

  await setStoredDirectoryHandle(userId, handle);
  return buildDirectoryStatus(handle, getLocalWorkspaceFileName(userId));
}

export async function clearLocalDirectory(userId: string) {
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

export async function readLocalDirectoryState(
  userId: string,
): Promise<LocalWorkspaceRecord | null> {
  const handle = await getStoredDirectoryHandle(userId);

  if (!handle || (await queryDirectoryPermission(handle)) !== "granted") {
    return null;
  }

  try {
    const fileHandle = await handle.getFileHandle(
      getLocalWorkspaceFileName(userId),
    );
    const file = await fileHandle.getFile();
    const parsed = JSON.parse(await file.text()) as unknown;
    const legacyRecord = parseLocalWorkspaceRecord(parsed);

    if (legacyRecord) {
      return legacyRecord;
    }

    const manifest = parseMarkdownWorkspaceManifest(parsed);
    if (!manifest) {
      return null;
    }

    const markdownFiles = await readMarkdownFiles(handle, manifest);
    const state = parseMarkdownWorkspace(manifest, markdownFiles.contents);
    const savedAt =
      markdownFiles.latestModifiedAt &&
      Date.parse(markdownFiles.latestModifiedAt) > Date.parse(manifest.savedAt)
        ? markdownFiles.latestModifiedAt
        : manifest.savedAt;

    return state
      ? {
          formatVersion: manifest.formatVersion,
          savedAt,
          state,
        }
      : null;
  } catch (error) {
    if (isDomExceptionNamed(error, "NotFoundError")) {
      return null;
    }

    throw error;
  }
}

export function writeLocalDirectoryState(
  userId: string,
  record: LocalWorkspaceRecord,
): Promise<LocalDirectoryStatus> {
  const write = directoryWriteQueue.then(async () => {
    const status = await getLocalDirectoryStatus(userId);

    if (status.permission !== "granted") {
      return status;
    }

    const handle = await getStoredDirectoryHandle(userId);

    if (!handle) {
      return getLocalDirectoryStatus(userId);
    }

    const previousManifest = await readMarkdownManifest(handle, status.fileName);
    const workspace = createMarkdownWorkspace(record.state, record.savedAt);

    await Promise.all(
      Object.entries(workspace.files).map(([path, contents]) =>
        writeDirectoryFile(handle, path, contents),
      ),
    );
    await writeDirectoryFile(
      handle,
      status.fileName,
      `${JSON.stringify(workspace.manifest, null, 2)}\n`,
    );
    await removeStaleMarkdownFiles(
      handle,
      previousManifest,
      new Set(workspace.manifest.files.map((file) => file.path)),
    );

    return status;
  });

  directoryWriteQueue = write.then(
    () => undefined,
    () => undefined,
  );

  return write;
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
): Promise<LocalDirectoryStatus> {
  return {
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
): Promise<FileSystemDirectoryHandle | null> {
  if (!supportsDirectoryPicker()) {
    return null;
  }

  const database = await openDirectoryDatabase();
  const handle = await new Promise<FileSystemDirectoryHandle | null>(
    (resolve, reject) => {
      const transaction = database.transaction(DIRECTORY_HANDLE_STORE, "readonly");
      const request = transaction.objectStore(DIRECTORY_HANDLE_STORE).get(userId);
      request.onsuccess = () =>
        resolve((request.result as FileSystemDirectoryHandle | undefined) ?? null);
      request.onerror = () => reject(request.error);
    },
  );

  database.close();
  return handle;
}

async function setStoredDirectoryHandle(
  userId: string,
  handle: FileSystemDirectoryHandle,
) {
  const database = await openDirectoryDatabase();

  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(DIRECTORY_HANDLE_STORE, "readwrite");
    transaction.objectStore(DIRECTORY_HANDLE_STORE).put(handle, userId);
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

async function readMarkdownManifest(
  handle: FileSystemDirectoryHandle,
  fileName: string,
) {
  try {
    const fileHandle = await handle.getFileHandle(fileName);
    const file = await fileHandle.getFile();
    return parseMarkdownWorkspaceManifest(JSON.parse(await file.text()));
  } catch (error) {
    if (isDomExceptionNamed(error, "NotFoundError") || error instanceof SyntaxError) {
      return null;
    }

    throw error;
  }
}

async function readMarkdownFiles(
  handle: FileSystemDirectoryHandle,
  manifest: MarkdownWorkspaceManifest,
) {
  const entries = await Promise.all(
    manifest.files.map(async ({ path }) => {
      const fileHandle = await getNestedFileHandle(handle, path);
      const file = await fileHandle.getFile();
      return {
        contents: await file.text(),
        lastModified: file.lastModified,
        path,
      };
    }),
  );

  const latestModified = Math.max(
    ...entries.map((entry) => entry.lastModified).filter(Number.isFinite),
    0,
  );

  return {
    contents: Object.fromEntries(
      entries.map((entry) => [entry.path, entry.contents]),
    ),
    latestModifiedAt:
      latestModified > 0 ? new Date(latestModified).toISOString() : null,
  };
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

async function removeStaleMarkdownFiles(
  handle: FileSystemDirectoryHandle,
  previousManifest: MarkdownWorkspaceManifest | null,
  currentPaths: Set<string>,
) {
  if (!previousManifest) return;

  for (const { path } of previousManifest.files) {
    if (currentPaths.has(path)) continue;

    const segments = path.split("/");
    const fileName = segments.pop();
    if (!fileName) continue;

    try {
      let directory = handle;
      for (const segment of segments) {
        directory = await directory.getDirectoryHandle(segment);
      }
      await directory.removeEntry(fileName);
    } catch (error) {
      if (!isDomExceptionNamed(error, "NotFoundError")) throw error;
    }
  }
}

function isDomExceptionNamed(error: unknown, name: string) {
  return (
    (typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      error.name === name) ||
    (error instanceof Error && error.name === name)
  );
}
