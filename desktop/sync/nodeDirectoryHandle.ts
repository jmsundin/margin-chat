// The few parts of the browser's FileSystemDirectoryHandle that the vault's device copy
// (client/src/lib/vaultLocal.ts, createJournalVaultStore) uses, over node:fs, so the desktop app
// keeps that copy in its own data folder with the same journal format the browser uses.
// Writes go to a temporary file, are flushed, then renamed into place.
import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";

function notFound(name: string) {
  return new DOMException(`${name} was not found.`, "NotFoundError");
}

function checkName(name: string) {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new TypeError(`Not a file name: ${JSON.stringify(name)}`);
  }
}

async function kindOf(absolute: string) {
  try {
    const info = await stat(absolute);
    return info.isDirectory() ? "directory" : info.isFile() ? "file" : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

function fileHandle(absolute: string, name: string): FileSystemFileHandle {
  return {
    kind: "file",
    name,
    async getFile() {
      let bytes: Buffer;
      let modified: number;
      try {
        const handle = await open(absolute, "r");
        try {
          const info = await handle.stat();
          bytes = await handle.readFile();
          modified = Math.floor(info.mtimeMs);
        } finally {
          await handle.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") throw notFound(name);
        throw error;
      }
      return new File([new Uint8Array(bytes)], name, { lastModified: modified });
    },
    async createWritable() {
      const chunks: Uint8Array[] = [];
      let finished = false;
      return {
        async write(data: string | ArrayBuffer | ArrayBufferView) {
          if (finished) throw new TypeError("This file was already closed.");
          chunks.push(typeof data === "string" ? new TextEncoder().encode(data)
            : data instanceof ArrayBuffer ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        },
        async close() {
          if (finished) return;
          finished = true;
          const temporary = path.join(path.dirname(absolute), `.${name}.${randomBytes(6).toString("hex")}.tmp`);
          const handle = await open(temporary, "wx", 0o600);
          try {
            for (const chunk of chunks) await handle.write(chunk);
            await handle.sync();
          } catch (error) {
            await handle.close().catch(() => undefined);
            await unlink(temporary).catch(() => undefined);
            throw error;
          }
          await handle.close();
          try {
            await rename(temporary, absolute);
          } catch (error) {
            await unlink(temporary).catch(() => undefined);
            throw error;
          }
        },
        async abort() { finished = true; chunks.length = 0; },
      } as unknown as FileSystemWritableFileStream;
    },
    async isSameEntry() { return false; },
  } as unknown as FileSystemFileHandle;
}

/** A folder on disk as a FileSystemDirectoryHandle, enough for the vault's device copy. */
export function nodeDirectoryHandle(absolute: string, name = path.basename(absolute)): FileSystemDirectoryHandle {
  return {
    kind: "directory",
    name,
    async getDirectoryHandle(child: string, options?: { create?: boolean }) {
      checkName(child);
      const target = path.join(absolute, child);
      const kind = await kindOf(target);
      if (kind === "file") throw new DOMException(`${child} is a file.`, "TypeMismatchError");
      if (!kind) {
        if (!options?.create) throw notFound(child);
        await mkdir(target, { recursive: true });
      }
      return nodeDirectoryHandle(target, child);
    },
    async getFileHandle(child: string, options?: { create?: boolean }) {
      checkName(child);
      const target = path.join(absolute, child);
      const kind = await kindOf(target);
      if (kind === "directory") throw new DOMException(`${child} is a folder.`, "TypeMismatchError");
      if (!kind) {
        if (!options?.create) throw notFound(child);
        // The browser creates an empty file here; an empty file is what a later read finds.
        const handle = await open(target, "a", 0o600);
        await handle.close();
      }
      return fileHandle(target, child);
    },
    async removeEntry(child: string, options?: { recursive?: boolean }) {
      checkName(child);
      const target = path.join(absolute, child);
      const kind = await kindOf(target);
      if (!kind) throw notFound(child);
      await rm(target, { recursive: options?.recursive ?? false });
    },
    async isSameEntry() { return false; },
    async resolve() { return null; },
  } as unknown as FileSystemDirectoryHandle;
}

