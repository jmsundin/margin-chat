/**
 * The renderer's view of a native vault folder: `VaultDirectory` handles whose
 * operations are bridge requests (bridgeProtocol.ts). The folder code built for
 * browser handles runs on these unchanged, while the bytes stay in the main
 * process.
 *
 * Snapshots work as in Chromium and the native adapter: `getFile()` asks for
 * the size and date, and a later `text()` or `arrayBuffer()` sends them back so
 * the main process can refuse (`InvalidStateError`) if the file changed.
 */
import { isBridgeFailure, type BridgeFolder, type BridgeRef, type BridgeRequestName, type BridgeRequests, type VaultBridgeApi } from "./bridgeProtocol";
import { domError, isValidEntryName, type VaultDirectory, type VaultFileHandle, type VaultFileSnapshot, type VaultHandle, type VaultWritable } from "./vaultFs";

/** A handle that knows where it points, so the main process can be told to connect or show it. */
export interface BridgeDirectory extends VaultDirectory {
  readonly ref: BridgeRef;
}
export interface BridgeFileHandle extends VaultFileHandle {
  readonly ref: BridgeRef;
}

export const isBridgeHandle = (handle: unknown): handle is BridgeDirectory | BridgeFileHandle =>
  !!handle && typeof handle === "object" && "ref" in handle && typeof (handle as BridgeDirectory).ref?.folderId === "string";

/** Turns a failed request back into the DOMException the main process threw. */
export async function bridgeRequest<T>(request: () => Promise<T>): Promise<T> {
  let result: T;
  try { result = await request(); }
  catch (error) {
    if (isBridgeFailure(error)) throw domError(error.error.name as Parameters<typeof domError>[0], error.error.message);
    // Electron turns a thrown error into `Error: <name>: <message>` on the way over.
    const match = error instanceof Error ? /^(?:Error invoking remote method '[^']+': )?([A-Za-z]+Error): (.*)$/su.exec(error.message) : null;
    if (match) throw domError(match[1] as Parameters<typeof domError>[0], match[2]);
    throw error;
  }
  if (isBridgeFailure(result)) throw domError(result.error.name as Parameters<typeof domError>[0], result.error.message);
  return result;
}

const childRef = (ref: BridgeRef, name: string): BridgeRef => ({ folderId: ref.folderId, path: ref.path ? `${ref.path}/${name}` : name });

export function bridgeDirectory(api: VaultBridgeApi, folder: Pick<BridgeFolder, "id" | "name">, path = ""): BridgeDirectory {
  const ref: BridgeRef = { folderId: folder.id, path };
  const name = path ? path.split("/").pop()! : folder.name;
  const request = <Name extends BridgeRequestName>(requestName: Name, ...args: BridgeRequests[Name]["args"]) =>
    bridgeRequest(() => api.request(requestName, ...args));
  const checkName = (entry: string) => {
    if (!isValidEntryName(entry)) throw domError("TypeMismatchError", `“${entry}” is not a valid file or folder name.`);
  };
  const directory: BridgeDirectory = {
    kind: "directory",
    name,
    ref,
    async *entries() {
      const listed = await request("list", ref);
      for (const entry of listed) {
        yield [entry.name, entry.kind === "directory" ? bridgeDirectory(api, folder, childRef(ref, entry.name).path) : bridgeFile(api, folder, childRef(ref, entry.name).path)] as [string, VaultHandle];
      }
    },
    async getDirectoryHandle(entry, { create = false } = {}) {
      checkName(entry);
      const target = childRef(ref, entry);
      const kind = await request("kind", target);
      if (kind === "directory") return bridgeDirectory(api, folder, target.path);
      if (kind === "file") throw domError("TypeMismatchError", `“${entry}” is a file, not a folder.`);
      if (!create) throw domError("NotFoundError", `There is no folder named “${entry}”.`);
      await request("createDirectory", target);
      return bridgeDirectory(api, folder, target.path);
    },
    async getFileHandle(entry, { create = false } = {}) {
      checkName(entry);
      const target = childRef(ref, entry);
      const kind = await request("kind", target);
      if (kind === "file") return bridgeFile(api, folder, target.path);
      if (kind === "directory") throw domError("TypeMismatchError", `“${entry}” is a folder, not a file.`);
      if (!create) throw domError("NotFoundError", `There is no file named “${entry}”.`);
      await request("createFile", target);
      return bridgeFile(api, folder, target.path);
    },
    async removeEntry(entry, { recursive = false } = {}) {
      checkName(entry);
      await request("remove", childRef(ref, entry), recursive);
    },
    async isSameEntry(other) {
      return isBridgeHandle(other) && other.ref.folderId === ref.folderId && other.ref.path === ref.path;
    },
  };
  return directory;
}

export function bridgeFile(api: VaultBridgeApi, folder: Pick<BridgeFolder, "id" | "name">, path: string): BridgeFileHandle {
  const ref: BridgeRef = { folderId: folder.id, path };
  const name = path.split("/").pop()!;
  const request = <Name extends BridgeRequestName>(requestName: Name, ...args: BridgeRequests[Name]["args"]) =>
    bridgeRequest(() => api.request(requestName, ...args));
  return {
    kind: "file",
    name,
    ref,
    async getFile() {
      const stat = await request("stat", ref);
      const read = () => request("read", ref, stat);
      const snapshot: VaultFileSnapshot = {
        name, size: stat.size, lastModified: stat.lastModified, type: "",
        async text() { return new TextDecoder("utf-8").decode(await read()); },
        async arrayBuffer() { const bytes = await read(); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer; },
      };
      return snapshot;
    },
    async createWritable(): Promise<VaultWritable> {
      const chunks: Uint8Array[] = [];
      let open = true;
      return {
        async write(contents) {
          if (!open) throw domError("InvalidStateError", "This write was already closed.");
          chunks.push(typeof contents === "string" ? new TextEncoder().encode(contents)
            : ArrayBuffer.isView(contents) ? new Uint8Array(contents.buffer, contents.byteOffset, contents.byteLength).slice() : new Uint8Array(contents).slice());
        },
        async close() {
          if (!open) throw domError("InvalidStateError", "This write was already closed.");
          open = false;
          const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
          const bytes = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
          await request("write", ref, bytes);
        },
        async abort() { open = false; chunks.length = 0; },
      };
    },
    async isSameEntry(other) {
      return isBridgeHandle(other) && other.ref.folderId === ref.folderId && other.ref.path === ref.path;
    },
  };
}
