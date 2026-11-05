import { assertVaultFsPath, isVaultFsError, joinVaultFsPath, vaultFsError, type VaultFs, type VaultFsChangeListener, type VaultFsEntry } from "@margin-chat/vault-sync";
import { readFreshFile } from "./fileSnapshot";

type DirectoryEntries = FileSystemDirectoryHandle & { entries(): AsyncIterableIterator<[string, FileSystemHandle]> };
type MovableFileHandle = FileSystemFileHandle & { move?(parent: FileSystemDirectoryHandle, name: string): Promise<void> };
type FileSystemObserverConstructor = new (callback: () => void) => {
  observe(handle: FileSystemHandle, options?: { recursive?: boolean }): Promise<void>;
  disconnect(): void;
};

/** Whether `folder` is already a VaultFs rather than a browser folder handle. */
export function isVaultFs(folder: FileSystemDirectoryHandle | VaultFs): folder is VaultFs {
  return typeof (folder as Partial<VaultFs>).writeAtomic === "function";
}

/** A browser folder handle as a VaultFs; a VaultFs is returned as it is. */
export function toVaultFs(folder: FileSystemDirectoryHandle | VaultFs): VaultFs {
  return isVaultFs(folder) ? folder : fsAccessVaultFs(folder);
}

/**
 * A folder chosen with the browser's directory picker (File System Access API), as a VaultFs.
 * Handles found while listing are kept, so reading the files a scan just listed costs no
 * extra lookups; a kept handle that has gone stale is looked up again once. Reads take fresh
 * file snapshots (see fileSnapshot.ts). `createWritable` writes to a temporary file that
 * replaces the original only when closed, so an aborted write leaves the previous contents.
 */
export function fsAccessVaultFs(root: FileSystemDirectoryHandle): VaultFs {
  const directories = new Map<string, FileSystemDirectoryHandle>([["", root]]);
  const fileHandles = new Map<string, FileSystemFileHandle>();

  function forget(path: string) {
    fileHandles.delete(path);
    for (const key of directories.keys()) if (key && (key === path || key.startsWith(`${path}/`))) directories.delete(key);
  }

  async function directory(path: string, create = false): Promise<FileSystemDirectoryHandle> {
    const known = directories.get(path);
    if (known) return known;
    const slash = path.lastIndexOf("/");
    const parent = await directory(slash < 0 ? "" : path.slice(0, slash), create);
    const handle = await parent.getDirectoryHandle(slash < 0 ? path : path.slice(slash + 1), create ? { create: true } : undefined);
    directories.set(path, handle);
    return handle;
  }

  function split(path: string) {
    assertVaultFsPath(path);
    const slash = path.lastIndexOf("/");
    return { parent: slash < 0 ? "" : path.slice(0, slash), name: slash < 0 ? path : path.slice(slash + 1) };
  }

  async function lookUpFile(path: string, create = false): Promise<FileSystemFileHandle> {
    const { parent, name } = split(path);
    const handle = await (await directory(parent, create)).getFileHandle(name, create ? { create: true } : undefined);
    fileHandles.set(path, handle);
    return handle;
  }

  /** Runs `use` with a kept handle, looking it up again once when the kept one no longer finds the file. */
  async function withFile<T>(path: string, use: (handle: () => Promise<FileSystemFileHandle>) => Promise<T>): Promise<T> {
    const kept = fileHandles.get(path);
    if (kept) {
      try {
        return await use(async () => kept);
      } catch (error) {
        if (!isVaultFsError(error, "NotFoundError")) throw error;
        forget(path);
      }
    }
    return use(() => lookUpFile(path));
  }

  async function orNull<T>(read: () => Promise<T>): Promise<T | null> {
    try {
      return await read();
    } catch (error) {
      if (isVaultFsError(error, "NotFoundError")) return null;
      throw error;
    }
  }

  return {
    name: root.name,
    async *list(path: string): AsyncIterable<VaultFsEntry> {
      assertVaultFsPath(path, true);
      const handle = await directory(path) as DirectoryEntries;
      for await (const [name, entry] of handle.entries()) {
        const child = joinVaultFsPath(path, name);
        if (entry.kind === "directory") directories.set(child, entry as FileSystemDirectoryHandle);
        else fileHandles.set(child, entry as FileSystemFileHandle);
        yield { name, kind: entry.kind };
      }
    },
    stat: (path) => orNull(() => withFile(path, async (handle) => {
      const file = await (await handle()).getFile();
      return { size: file.size, modifiedMs: file.lastModified > 0 ? file.lastModified : 0 };
    })),
    read: (path) => orNull(() => withFile(path, (handle) => readFreshFile(handle, async (file) => ({
      bytes: new Uint8Array(await file.arrayBuffer()),
      stat: { size: file.size, modifiedMs: file.lastModified > 0 ? file.lastModified : 0 },
    })))),
    async writeAtomic(path, contents) {
      const handle = await withFile(path, async (find) => find()).catch((error) => {
        if (isVaultFsError(error, "NotFoundError")) return lookUpFile(path, true);
        throw error;
      });
      const writable = await handle.createWritable();
      try {
        await writable.write(typeof contents === "string" ? contents : new Uint8Array(contents).buffer);
        await writable.close();
      } catch (error) {
        // Aborting leaves the file as it was; closing would replace it with whatever was written before the failure.
        await writable.abort?.().catch(() => undefined);
        throw error;
      }
    },
    async move(from, to) {
      if (await orNull(() => withFile(to, async (handle) => handle()))) throw vaultFsError("InvalidModificationError", `${to} already exists.`);
      const source = await withFile(from, async (handle) => handle()) as MovableFileHandle;
      const target = split(to);
      if (typeof source.move === "function") {
        await source.move(await directory(target.parent, true), target.name);
      } else {
        // Without a native move, the copy lands in full before the original goes.
        const read = await this.read(from);
        if (!read) throw vaultFsError("NotFoundError", from);
        await this.writeAtomic(to, read.bytes);
        await this.delete(from);
      }
      forget(from);
      forget(to);
    },
    async delete(path) {
      const { parent, name } = split(path);
      await (await directory(parent)).removeEntry(name);
      forget(path);
    },
    async availability() {
      const entries = (root as DirectoryEntries).entries();
      try {
        await entries.next();
        return "available";
      } catch (error) {
        if (isVaultFsError(error, "NotFoundError")) return "missing";
        if (isVaultFsError(error, "NotAllowedError") || isVaultFsError(error, "SecurityError")) return "refused";
        throw error;
      } finally {
        await entries.return?.(undefined).catch(() => undefined);
      }
    },
    watch(onChange: VaultFsChangeListener) {
      const Observer = (globalThis as { FileSystemObserver?: FileSystemObserverConstructor }).FileSystemObserver;
      if (!Observer) return null;
      let observer: InstanceType<FileSystemObserverConstructor> | null = new Observer(() => onChange(null));
      void observer.observe(root, { recursive: true }).catch(() => { observer?.disconnect(); observer = null; });
      return () => { observer?.disconnect(); observer = null; };
    },
  };
}
