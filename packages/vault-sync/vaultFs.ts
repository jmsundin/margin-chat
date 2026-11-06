/**
 * The filesystem a vault lives in, as the vault engine sees it.
 *
 * The shape is the subset of the browser's File System Access API that the
 * folder code already uses (`client/src/lib/workspaceStorage.ts`,
 * `client/src/lib/desktopVault.ts`, `client/src/lib/vaultLocal.ts`): a
 * directory handle that lists entries and opens child files and folders, a file
 * handle that gives a snapshot of its size, date and bytes, and a writable that
 * replaces the file's contents in one step on `close()`. A real
 * `FileSystemDirectoryHandle` satisfies it as it is (`asVaultDirectory`), so the
 * web and mobile clients keep their adapter for free, and the desktop app's
 * main process provides one over `node:fs` (`nodeVaultFs.ts`), with the same
 * scan, merge and write code running against both.
 *
 * Error names follow the DOM so one caller handles both adapters:
 * `NotFoundError` when an entry does not exist, `TypeMismatchError` when a file
 * is asked for as a folder or the reverse, `InvalidStateError` when a file
 * changed between taking its snapshot and reading it, `NotAllowedError` when
 * the system refuses. Every adapter throws `DOMException`s with these names.
 */

export interface VaultFileSnapshot {
  readonly name: string;
  /** Size in bytes when the snapshot was taken. */
  readonly size: number;
  /** Modification time in milliseconds since the epoch; 0 when unknown. */
  readonly lastModified: number;
  readonly type: string;
  /** The bytes as UTF-8 text. Rejects with `InvalidStateError` if the file changed since the snapshot. */
  text(): Promise<string>;
  /** The bytes. Rejects with `InvalidStateError` if the file changed since the snapshot. */
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface VaultWritable {
  write(contents: string | ArrayBuffer | ArrayBufferView): Promise<void>;
  /** Publishes what was written, replacing the file atomically. */
  close(): Promise<void>;
  /** Leaves the file as it was. */
  abort(): Promise<void>;
}

export interface VaultFileHandle {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<VaultFileSnapshot>;
  createWritable(): Promise<VaultWritable>;
  isSameEntry?(other: VaultHandle): Promise<boolean>;
}

export interface VaultDirectory {
  readonly kind: "directory";
  readonly name: string;
  entries(): AsyncIterableIterator<[string, VaultHandle]>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<VaultDirectory>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<VaultFileHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  isSameEntry?(other: VaultHandle): Promise<boolean>;
}

export type VaultHandle = VaultDirectory | VaultFileHandle;

/** What the native adapter adds: a real path and events. Web handles have neither. */
export interface NativeVaultDirectory extends VaultDirectory {
  /** The folder's absolute path on disk. */
  readonly path: string;
}

/**
 * A browser handle is already a vault directory; the cast only tells TypeScript
 * about `entries()`, which the client's DOM typings leave out.
 */
export function asVaultDirectory(handle: FileSystemDirectoryHandle): VaultDirectory {
  return handle as unknown as VaultDirectory;
}

/** One path segment, as the directory handle API takes it. */
export function isValidEntryName(name: string): boolean {
  return name.length > 0 && name.length <= 255 && name !== "." && name !== ".."
    && !/[\\/\u0000-\u001f\u007f]/u.test(name);
}

export function domError(name: "NotFoundError" | "TypeMismatchError" | "InvalidStateError" | "NotAllowedError" | "InvalidModificationError" | "NoModificationAllowedError", message: string) {
  const exception = new DOMException(message, name);
  // A DOMException carries no stack of its own; one helps find which caller met the error.
  (Error as unknown as { captureStackTrace?: (target: object) => void }).captureStackTrace?.(exception);
  return exception;
}

export function isDomErrorNamed(error: unknown, name: string): boolean {
  return (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === name)
    || (error instanceof Error && error.name === name);
}

/** Opens `path` ("a/b/c.md") from `root` without creating anything; `NotFoundError` when a segment is missing. */
export async function resolveVaultFile(root: VaultDirectory, path: string): Promise<VaultFileHandle> {
  const segments = path.split("/");
  const name = segments.pop();
  if (!name || !segments.every(isValidEntryName) || !isValidEntryName(name)) throw domError("TypeMismatchError", `Invalid vault path: ${path}`);
  let directory = root;
  for (const segment of segments) directory = await directory.getDirectoryHandle(segment);
  return directory.getFileHandle(name);
}

/** Reads a whole file as text, or null when it does not exist. */
export async function readVaultText(root: VaultDirectory, path: string): Promise<string | null> {
  try {
    return await (await (await resolveVaultFile(root, path)).getFile()).text();
  } catch (error) {
    if (isDomErrorNamed(error, "NotFoundError")) return null;
    throw error;
  }
}

/** Writes a whole file, creating folders on the way; the replacement is atomic. */
export async function writeVaultFile(root: VaultDirectory, path: string, contents: string | Uint8Array): Promise<void> {
  const segments = path.split("/");
  const name = segments.pop();
  if (!name || !segments.every(isValidEntryName) || !isValidEntryName(name)) throw domError("TypeMismatchError", `Invalid vault path: ${path}`);
  let directory = root;
  for (const segment of segments) directory = await directory.getDirectoryHandle(segment, { create: true });
  const writer = await (await directory.getFileHandle(name, { create: true })).createWritable();
  try {
    await writer.write(typeof contents === "string" ? contents : new Uint8Array(contents).buffer as ArrayBuffer);
    await writer.close();
  } catch (error) {
    await writer.abort().catch(() => undefined);
    throw error;
  }
}
