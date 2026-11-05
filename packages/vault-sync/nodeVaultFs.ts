/**
 * The vault folder over `node:fs`, for the desktop app's main process.
 *
 * Implements `VaultDirectory` (vaultFs.ts) so the folder code written for the
 * browser's directory handles runs unchanged against a real folder, and adds
 * what the browser cannot offer: atomic replacement of files (temp file in the
 * same folder, fsync, rename over the target), a real path, and no symlink
 * escapes. Entries that are symbolic links are invisible: never listed, never
 * opened, never written, so nothing the vault does can reach outside its folder.
 *
 * Snapshots behave like Chromium's: `getFile()` records the size and date, and
 * a read that finds the file changed since then rejects with
 * `InvalidStateError`, so callers that already retry fresh snapshots
 * (`readFreshFile`) keep working, and a file still being copied in is never
 * read half way.
 */
import { constants as fsConstants } from "node:fs";
import { copyFile, lstat, mkdir, open, readdir, realpath, rename, rm, stat, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { domError, isValidEntryName, type NativeVaultDirectory, type VaultDirectory, type VaultFileHandle, type VaultFileSnapshot, type VaultHandle, type VaultWritable } from "./vaultFs";

export interface NodeVaultFsOptions {
  /** Called after each file this adapter publishes, with its vault path and bytes, so a watcher can tell the write apart from a drop-in. */
  onWritten?: (vaultPath: string, bytes: Uint8Array) => void;
  /** Called after each entry this adapter removes. */
  onRemoved?: (vaultPath: string) => void;
  /**
   * Whether renaming over a file another program holds open is retried (Windows
   * refuses with EPERM/EBUSY). Defaults to the platform.
   */
  retryBusyRename?: boolean;
  /**
   * Whether the previous file's attributes (Finder tags, comments) are carried
   * over to the new one. Defaults to macOS only, where `copyFile` clones them.
   */
  preserveAttributes?: boolean;
  platform?: NodeJS.Platform;
  wait?: (ms: number) => Promise<void>;
  /** The rename used to publish a write; tests stand in a failing one. */
  renameImpl?: typeof rename;
}

/** Temp files this adapter writes: hidden, so folder scans and the watcher skip them. */
export const TEMP_FILE_PREFIX = ".margin-chat-tmp-";
export const isTempFileName = (name: string) => name.startsWith(TEMP_FILE_PREFIX);

/** A rename that Windows refuses while another program has the target open. */
export class TargetBusyError extends Error {
  constructor(readonly targetPath: string, cause: unknown) {
    super(`“${path.basename(targetPath)}” is open in another program, so it couldn’t be replaced yet. Margin Chat will try again.`, { cause });
    this.name = "TargetBusyError";
  }
}

const BUSY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_ATTEMPTS = 6;
const RENAME_WAIT_MS = 50;

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;
const defaultWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function toBytes(contents: string | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (typeof contents === "string") return new TextEncoder().encode(contents);
  if (ArrayBuffer.isView(contents)) return new Uint8Array(contents.buffer, contents.byteOffset, contents.byteLength).slice();
  return new Uint8Array(contents).slice();
}

/** Creates the handle for a folder that must already exist. The path is resolved, so a folder reached through a link is used by its real location. */
export async function openNodeVaultDirectory(folderPath: string, options: NodeVaultFsOptions = {}): Promise<NativeVaultDirectory> {
  const real = await realpath(folderPath);
  if (!(await stat(real)).isDirectory()) throw domError("TypeMismatchError", `${folderPath} is not a folder.`);
  return nodeDirectory(real, real, options);
}

/** Whether the folder itself can be listed right now: a moved or unplugged folder is never read as empty. */
export async function nodeFolderAvailability(folderPath: string): Promise<"available" | "missing" | "refused"> {
  try {
    const handle = await open(folderPath, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
    await handle.close();
    await readdir(folderPath);
    return "available";
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return "missing";
    if (code === "EACCES" || code === "EPERM") return "refused";
    throw error;
  }
}

function nodeDirectory(root: string, directoryPath: string, options: NodeVaultFsOptions): NativeVaultDirectory {
  const vaultPath = (childPath: string) => path.relative(root, childPath).split(path.sep).join("/");
  const child = (name: string) => {
    if (!isValidEntryName(name)) throw domError("TypeMismatchError", `“${name}” is not a valid file or folder name.`);
    return path.join(directoryPath, name);
  };
  /** The entry itself, never following a link, so a link to somewhere else looks like nothing is there. */
  const entryStat = async (childPath: string) => {
    try {
      const info = await lstat(childPath);
      return info.isSymbolicLink() ? null : info;
    } catch (error) {
      if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return null;
      if (errorCode(error) === "EACCES" || errorCode(error) === "EPERM") throw domError("NotAllowedError", `Margin Chat isn’t allowed to open “${path.basename(childPath)}”.`);
      throw error;
    }
  };
  const directory: NativeVaultDirectory = {
    kind: "directory",
    name: path.basename(directoryPath) || directoryPath,
    path: directoryPath,
    async *entries() {
      let listed;
      try {
        listed = await readdir(directoryPath, { withFileTypes: true });
      } catch (error) {
        if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") throw domError("NotFoundError", `The folder “${directory.name}” can’t be found.`);
        if (errorCode(error) === "EACCES" || errorCode(error) === "EPERM") throw domError("NotAllowedError", `Margin Chat isn’t allowed to open “${directory.name}”.`);
        throw error;
      }
      for (const entry of listed.sort((a, b) => a.name.localeCompare(b.name))) {
        if (isTempFileName(entry.name)) continue;
        if (entry.isDirectory()) yield [entry.name, nodeDirectory(root, path.join(directoryPath, entry.name), options)] as [string, VaultHandle];
        else if (entry.isFile()) yield [entry.name, nodeFile(root, path.join(directoryPath, entry.name), options)] as [string, VaultHandle];
        // Links, sockets and devices are not part of the vault.
      }
    },
    async getDirectoryHandle(name, { create = false } = {}) {
      const childPath = child(name);
      const info = await entryStat(childPath);
      if (info?.isDirectory()) return nodeDirectory(root, childPath, options);
      if (info) throw domError("TypeMismatchError", `“${name}” is a file, not a folder.`);
      if (!create) throw domError("NotFoundError", `There is no folder named “${name}”.`);
      await mkdir(childPath);
      return nodeDirectory(root, childPath, options);
    },
    async getFileHandle(name, { create = false } = {}) {
      const childPath = child(name);
      const info = await entryStat(childPath);
      if (info?.isFile()) return nodeFile(root, childPath, options);
      if (info) throw domError("TypeMismatchError", `“${name}” is a folder, not a file.`);
      if (!create) throw domError("NotFoundError", `There is no file named “${name}”.`);
      // Like the browser, create:true leaves an empty file until something is written.
      const handle = await open(childPath, "wx");
      await handle.close();
      return nodeFile(root, childPath, options);
    },
    async removeEntry(name, { recursive = false } = {}) {
      const childPath = child(name);
      const info = await entryStat(childPath);
      if (!info) throw domError("NotFoundError", `There is nothing named “${name}” to remove.`);
      if (info.isDirectory()) {
        if (!recursive && (await readdir(childPath)).length) throw domError("InvalidModificationError", `The folder “${name}” is not empty.`);
        await rm(childPath, { recursive: true, force: false });
      } else {
        await unlink(childPath);
      }
      options.onRemoved?.(vaultPath(childPath));
    },
    async isSameEntry(other) {
      return !!other && (other as NativeVaultDirectory).path === directoryPath;
    },
  };
  return directory;
}

interface NativeVaultFile extends VaultFileHandle { readonly path: string }

function nodeFile(root: string, filePath: string, options: NodeVaultFsOptions): NativeVaultFile {
  const name = path.basename(filePath);
  const vaultPath = path.relative(root, filePath).split(path.sep).join("/");
  const fileStat = async () => {
    try {
      const info = await lstat(filePath);
      if (!info.isFile()) throw domError("NotFoundError", `“${name}” is no longer a file.`);
      return info;
    } catch (error) {
      if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") throw domError("NotFoundError", `The file “${name}” can’t be found.`);
      throw error;
    }
  };
  return {
    kind: "file",
    name,
    path: filePath,
    async getFile() {
      const taken = await fileStat();
      const snapshot = { size: taken.size, mtimeMs: taken.mtimeMs };
      /** Reads the bytes and makes sure the file is still the one the snapshot describes, before and after. */
      const read = async () => {
        let handle: FileHandle;
        try { handle = await open(filePath, "r"); }
        catch (error) {
          if (errorCode(error) === "ENOENT") throw domError("NotFoundError", `The file “${name}” can’t be found.`);
          throw error;
        }
        try {
          const before = await handle.stat();
          if (before.size !== snapshot.size || before.mtimeMs !== snapshot.mtimeMs) throw changed();
          const bytes = Buffer.allocUnsafe(before.size);
          let offset = 0;
          while (offset < bytes.length) {
            const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
            if (!bytesRead) break;
            offset += bytesRead;
          }
          const after = await handle.stat();
          if (offset !== snapshot.size || after.size !== snapshot.size || after.mtimeMs !== snapshot.mtimeMs) throw changed();
          return bytes;
        } finally {
          await handle.close();
        }
      };
      const changed = () => domError("InvalidStateError", `“${name}” changed while it was being read.`);
      const file: VaultFileSnapshot = {
        name,
        size: taken.size,
        lastModified: Math.floor(taken.mtimeMs),
        type: "",
        async text() { return new TextDecoder("utf-8").decode(await read()); },
        async arrayBuffer() { const bytes = await read(); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer; },
      };
      return file;
    },
    async createWritable(): Promise<VaultWritable> {
      const chunks: Uint8Array[] = [];
      let open = true;
      return {
        async write(contents) {
          if (!open) throw domError("InvalidStateError", "This write was already closed.");
          chunks.push(toBytes(contents));
        },
        async close() {
          if (!open) throw domError("InvalidStateError", "This write was already closed.");
          open = false;
          const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
          const bytes = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
          await replaceAtomically(filePath, bytes, options);
          options.onWritten?.(vaultPath, bytes);
        },
        async abort() { open = false; chunks.length = 0; },
      };
    },
    async isSameEntry(other) {
      return !!other && (other as NativeVaultFile).path === filePath;
    },
  };
}

/**
 * Writes `bytes` to a temp file beside `target`, flushes it to disk, and renames
 * it over the target, so a crash at any point leaves either the old file or the
 * new one, never a mix. On macOS the old file is cloned first so its Finder
 * tags and comments survive; on Windows the rename is retried while another
 * program holds the file.
 */
export async function replaceAtomically(target: string, bytes: Uint8Array, options: NodeVaultFsOptions = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
  const wait = options.wait ?? defaultWait;
  const preserveAttributes = options.preserveAttributes ?? platform === "darwin";
  const retryBusy = options.retryBusyRename ?? platform === "win32";
  const directory = path.dirname(target);
  const temp = path.join(directory, `${TEMP_FILE_PREFIX}${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    if (preserveAttributes) {
      // copyFile on macOS uses copyfile(3), which carries extended attributes along with the data.
      try { await copyFile(target, temp); }
      catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
    }
    const handle = await open(temp, "w");
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    for (let attempt = 1; ; attempt += 1) {
      try {
        await (options.renameImpl ?? rename)(temp, target);
        break;
      } catch (error) {
        if (!retryBusy || !BUSY_CODES.has(errorCode(error) ?? "") || attempt >= RENAME_ATTEMPTS) {
          throw BUSY_CODES.has(errorCode(error) ?? "") ? new TargetBusyError(target, error) : error;
        }
        await wait(RENAME_WAIT_MS * 2 ** (attempt - 1));
      }
    }
    // The rename is durable once the folder itself is flushed.
    await syncDirectory(directory);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

async function syncDirectory(directory: string) {
  // Windows can't open a folder for fsync; the rename is already durable enough there.
  if (process.platform === "win32") return;
  let handle: FileHandle | null = null;
  try {
    handle = await open(directory, "r");
    await handle.sync().catch(() => undefined);
  } catch { /* A folder that can't be opened for syncing was still renamed into. */ }
  finally { await handle?.close().catch(() => undefined); }
}

/** The vault directory as the folder code types it. */
export const asFileSystemDirectoryHandle = (directory: VaultDirectory) => directory as unknown as FileSystemDirectoryHandle;
