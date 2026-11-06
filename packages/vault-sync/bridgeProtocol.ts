/**
 * What the desktop renderer and main process say to each other about the vault.
 *
 * The renderer never touches the filesystem: it holds `VaultDirectory` handles
 * (vaultFs.ts) whose every operation is one request here, answered by the main
 * process from `node:fs` through the native adapter. Requests name a folder by
 * the id the main process gave it and a path inside it; the main process
 * validates both before anything is read or written.
 *
 * The protocol is versioned because the shell (Electron, `desktop/`) and the
 * client bundle update on different cadences: the client takes the native path
 * only when `protocolVersion` matches what it was built against, and falls back
 * to the browser's folder API otherwise.
 */

export const VAULT_BRIDGE_PROTOCOL_VERSION = 1;
/** The property the preload script defines on `window`. */
export const VAULT_BRIDGE_GLOBAL = "marginVault";
/** IPC channel prefix for requests, and the channel folder-change events arrive on. */
export const VAULT_BRIDGE_CHANNEL = "margin-vault";
export const VAULT_BRIDGE_CHANGED_CHANNEL = "margin-vault:changed";

/** A folder the main process knows: remembered (connected before) or only picked for a look. */
export interface BridgeFolder {
  id: string;
  name: string;
  path: string;
}

export interface BridgeStatus {
  protocolVersion: number;
  /** The connected folder, or null before one is chosen. */
  current: BridgeFolder | null;
  /** Folders connected before on this computer, the current one first. */
  folders: BridgeFolder[];
}

/** Where a handle points: a known folder and a `/`-separated path inside it ("" is the folder itself). */
export interface BridgeRef {
  folderId: string;
  path: string;
}

export type BridgeEntry = { name: string; kind: "file" | "directory" };
export type BridgeStat = { size: number; lastModified: number };

/** Requests, with their arguments and answers. */
export interface BridgeRequests {
  status: { args: []; result: BridgeStatus };
  /** Opens the system folder picker; the folder is known (not remembered) until connected. */
  pickFolder: { args: []; result: BridgeFolder | null };
  /** Makes `ref` the connected folder and remembers it. */
  connect: { args: [ref: BridgeRef]; result: BridgeStatus };
  /** Opens a remembered folder again. Null when it is not remembered. */
  reconnect: { args: [folderId: string]; result: BridgeFolder | null };
  /** Forgets the current connection (the folder stays remembered). */
  disconnect: { args: []; result: BridgeStatus };
  /** Whether the folder itself can be listed. Never read as empty when it can't. */
  availability: { args: [folderId: string]; result: "available" | "missing" | "refused" };
  /** Opens the folder in Finder / Explorer / the file manager. */
  showFolder: { args: [ref: BridgeRef]; result: void };
  list: { args: [ref: BridgeRef]; result: BridgeEntry[] };
  /** The entry's kind, or null when nothing is there. */
  kind: { args: [ref: BridgeRef]; result: "file" | "directory" | null };
  stat: { args: [ref: BridgeRef]; result: BridgeStat };
  /** The file's bytes, refused with InvalidStateError when they changed since `expected`. */
  read: { args: [ref: BridgeRef, expected: BridgeStat | null]; result: Uint8Array };
  /** Atomic replacement, creating folders on the way. */
  write: { args: [ref: BridgeRef, bytes: Uint8Array]; result: BridgeStat };
  /** An empty file (the directory handle API's create:true), only if nothing is there. */
  createFile: { args: [ref: BridgeRef]; result: void };
  createDirectory: { args: [ref: BridgeRef]; result: void };
  remove: { args: [ref: BridgeRef, recursive: boolean]; result: void };
}

export type BridgeRequestName = keyof BridgeRequests;

/** Errors cross the bridge by name so the renderer can throw the same DOMException. */
export interface BridgeFailure {
  error: { name: string; message: string };
}

export function isBridgeFailure(value: unknown): value is BridgeFailure {
  return !!value && typeof value === "object" && "error" in value && !!(value as BridgeFailure).error
    && typeof (value as BridgeFailure).error.name === "string" && typeof (value as BridgeFailure).error.message === "string";
}

/** A change the main-process watcher reports: `path` "" means the whole folder. */
export interface BridgeFolderChange {
  folderId: string;
  changes: Array<{ path: string; kind: "changed" | "removed" }>;
}

/** What the preload script exposes. */
export interface VaultBridgeApi {
  protocolVersion: number;
  request<Name extends BridgeRequestName>(name: Name, ...args: BridgeRequests[Name]["args"]): Promise<BridgeRequests[Name]["result"]>;
  /** Folder changes seen by the main process. Returns a function that stops listening. */
  onFolderChanged(listener: (change: BridgeFolderChange) => void): () => void;
}

/** Validates a `/`-separated path inside a folder as the main process must before using it. */
export function isValidBridgePath(path: string): boolean {
  if (path === "") return true;
  if (path.length > 4096 || path.startsWith("/") || path.endsWith("/")) return false;
  return path.split("/").every((segment) => segment.length > 0 && segment.length <= 255 && segment !== "." && segment !== ".."
    && !/[\\\u0000-\u001f\u007f]/u.test(segment));
}
