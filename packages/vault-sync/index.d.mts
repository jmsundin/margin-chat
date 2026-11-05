/**
 * The filesystem a vault folder lives on, as the vault engine sees it. Paths are
 * vault-relative, "/"-separated, and never start with "/" or contain "." or ".."
 * segments; "" is the folder itself. Adapters: the browser's File System Access
 * folder (client/src/lib/vaultFsAccess.ts), an in-memory folder for tests, and,
 * from phase 1, node:fs in the desktop app's main process.
 *
 * Errors carry DOMException-style names so callers can tell them apart the same
 * way on every adapter: "NotFoundError" (no such file or folder),
 * "NotAllowedError" (access refused), "TypeMismatchError" (a file where a folder
 * was expected, or the reverse), "InvalidStateError" (the folder changed while
 * being read; reading again is safe).
 */
export type VaultFsErrorName = "NotFoundError" | "NotAllowedError" | "SecurityError" | "TypeMismatchError" | "InvalidStateError" | "InvalidModificationError";

/** Size in bytes and modification time in milliseconds; 0 when the time isn't known. */
export interface VaultFsStat {
  size: number;
  modifiedMs: number;
}

export interface VaultFsEntry {
  name: string;
  kind: "file" | "directory";
}

/** A file's bytes with the size and time of the same snapshot they were read from. */
export interface VaultFsRead {
  bytes: Uint8Array;
  stat: VaultFsStat;
}

/** Whether the folder itself can be listed. A missing folder is never read as an empty one. */
export type VaultFsAvailability = "available" | "missing" | "refused";

/**
 * Called after something in the folder changed. `paths` lists what changed when
 * the adapter knows, or is null for "something, somewhere". Events are hints:
 * a caller always reads the folder again rather than trusting them.
 */
export type VaultFsChangeListener = (paths: string[] | null) => void;

export interface VaultFs {
  /** The folder's display name, used in messages such as “folder can't be found”. */
  readonly name: string;
  /** One level of `directory`'s entries, in no particular order. Throws NotFoundError when it doesn't exist. */
  list(directory: string): AsyncIterable<VaultFsEntry>;
  /** A file's size and time, or null when there is no file there. */
  stat(path: string): Promise<VaultFsStat | null>;
  /** A file's bytes, or null when there is no file there. */
  read(path: string): Promise<VaultFsRead | null>;
  /**
   * Replaces (or creates) a file, creating its parent folders. Either the whole new
   * contents land or the previous contents stay: a write that fails partway never
   * leaves a half-written file. Strings are written as UTF-8.
   */
  writeAtomic(path: string, contents: Uint8Array | string): Promise<void>;
  /** Renames a file, creating the target's parent folders. Fails if `to` exists. */
  move(from: string, to: string): Promise<void>;
  /** Removes a file. Throws NotFoundError when there is no file there. */
  delete(path: string): Promise<void>;
  availability(): Promise<VaultFsAvailability>;
  /**
   * Starts watching the whole folder, recursively. Returns a function that stops,
   * or null when this adapter can't watch (the caller polls instead).
   */
  watch?(onChange: VaultFsChangeListener): (() => void) | null;
}

export function vaultFsError(name: VaultFsErrorName, message?: string): Error;
export function isVaultFsError(error: unknown, name: VaultFsErrorName): boolean;
/** Whether `path` is a vault-relative path an adapter may touch (see VaultFs). */
export function isVaultFsPath(path: string): boolean;
/** Throws TypeError for a path that could leave the vault folder. */
export function assertVaultFsPath(path: string, allowRoot?: boolean): string;
export function joinVaultFsPath(directory: string, name: string): string;
export function decodeVaultFsText(bytes: Uint8Array): string;

export interface MemoryVaultFs extends VaultFs {
  /** The folder's files by path. Edit it to simulate another app. */
  readonly files: Map<string, { bytes: Uint8Array; modifiedMs: number }>;
  /** Sets a file as another app would, firing watchers. */
  put(path: string, contents: Uint8Array | string, modifiedMs?: number): void;
  /** Removes a file as another app would, firing watchers. */
  remove(path: string): void;
  /** Makes the folder missing or refused (or available again). */
  setAvailability(availability: VaultFsAvailability): void;
}

/** A folder held in memory, for tests and as the reference behaviour every adapter matches. */
export function createMemoryVaultFs(initial?: Record<string, Uint8Array | string>, options?: { name?: string; now?: () => number }): MemoryVaultFs;
