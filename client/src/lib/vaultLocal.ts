import { zipSync, unzipSync, strToU8 } from "fflate";
import { emptyVault, validVaultPath, type VaultFile, type VaultSnapshot, type VaultStore } from "./vaultTypes";

export function bytesToBase64(bytes: Uint8Array): string {
  let result = "";
  for (let i = 0; i < bytes.length; i += 8192) result += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(result);
}

export function vaultFileBytes(file: VaultFile): Uint8Array {
  if (file.encoding !== "base64") return new TextEncoder().encode(file.content);
  return Uint8Array.from(atob(file.content), (character) => character.charCodeAt(0));
}

type FileRef = Omit<VaultFile, "content"> & { object: string };
type StoredSnapshot = Omit<VaultSnapshot, "files" | "base" | "conflicts" | "directoryBaselines"> & {
  files: Record<string, FileRef>;
  base: Record<string, { revision: string; file: FileRef | null }>;
  conflicts: Array<Omit<VaultSnapshot["conflicts"][number], "local" | "remote" | "base" | "result"> & {
    local: FileRef | null; remote: FileRef | null; base?: FileRef | null; result?: FileRef | null;
  }>;
  directoryBaselines?: Record<string, { manifest: NonNullable<VaultSnapshot["directoryBaselines"]>[string]["manifest"]; files: Record<string, FileRef> }>;
};

async function readText(directory: FileSystemDirectoryHandle, name: string): Promise<string | null> {
  try { return await (await (await directory.getFileHandle(name)).getFile()).text(); }
  catch (error) { if (error instanceof DOMException && error.name === "NotFoundError") return null; throw error; }
}

async function writeFile(directory: FileSystemDirectoryHandle, name: string, contents: string | Uint8Array) {
  let created = false;
  let handle: FileSystemFileHandle;
  try { handle = await directory.getFileHandle(name); }
  catch (error) {
    if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
    handle = await directory.getFileHandle(name, { create: true });
    created = true;
  }
  let writer: FileSystemWritableFileStream | undefined;
  try {
    writer = await handle.createWritable();
    await writer.write(typeof contents === "string" ? contents : new Uint8Array(contents).buffer);
    await writer.close();
  } catch (error) {
    await writer?.abort().catch(() => undefined);
    // create:true may leave an empty directory entry even after abort. Do not
    // leave a failed first index behind, and never delete a committed old index.
    if (created) await directory.removeEntry(name).catch(() => undefined);
    throw error;
  }
}

async function hashBytes(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer))]
    .map((value) => value.toString(16).padStart(2, "0")).join("");
}

/** Content is stored as immutable Markdown/binary files. The atomic index contains references only. */
export function createBrowserVaultStore(userId: string): VaultStore {
  let directoryPromise: Promise<FileSystemDirectoryHandle> | null = null;
  const createOperationCache = () => ({
    objects: new Map<string, Uint8Array>(),
    contents: new Map<string, { bytes: Uint8Array; hash: string }>(),
  });
  let operationCache: ReturnType<typeof createOperationCache> | undefined;
  const contentKey = (file: VaultFile) => `${file.encoding ?? "utf8"}\0${file.content}`;
  function directory() {
    directoryPromise ??= (async () => {
      if (!navigator.storage?.getDirectory) throw new Error("This browser cannot save a local Markdown vault. Use a current version of Safari, Chrome, Edge, or Firefox.");
      const root = await navigator.storage.getDirectory();
      const vaults = await root.getDirectoryHandle("margin-chat-vaults", { create: true });
      return vaults.getDirectoryHandle(encodeURIComponent(userId), { create: true });
    })();
    return directoryPromise;
  }
  return {
    async lock<T>(operation: () => Promise<T>) {
      if (!navigator.locks) throw new Error("This browser cannot safely coordinate local saves. Update your browser before editing this vault.");
      return navigator.locks.request(`margin-chat-vault:${userId}`, async () => {
        // A save reuses bytes verified by its read while holding the same lock.
        // Never trust this cache across operations or when reopening the vault.
        operationCache = createOperationCache();
        try { return await operation(); }
        finally { operationCache = undefined; }
      });
    },
    async read() {
      const root = await directory();
      const index = await readText(root, "vault-state.json");
      if (index === null) return null;
      const stored = JSON.parse(index) as StoredSnapshot;
      if (stored.schemaVersion !== 1 || !stored.files || !stored.base || !Array.isArray(stored.conflicts)) {
        throw new Error("The local vault index could not be read. Its Markdown history has been preserved.");
      }
      const history = await root.getDirectoryHandle("history", { create: true });
      const cache = operationCache ?? createOperationCache();
      async function readRef(ref: FileRef | null): Promise<VaultFile | null> {
        if (!ref) return null;
        if (!/^[a-f0-9]{64}\.(md|bin|json|txt)$/u.test(ref.object)) throw new Error("Invalid local vault history reference.");
        let bytes = cache.objects.get(ref.object);
        if (!bytes) {
          bytes = new Uint8Array(await (await (await history.getFileHandle(ref.object)).getFile()).arrayBuffer());
          if (await hashBytes(bytes) !== ref.object.slice(0, 64)) {
            throw new Error("A local vault history file is incomplete or damaged. Its index and other Markdown files have been preserved.");
          }
          cache.objects.set(ref.object, bytes);
        }
        // The same immutable bytes can carry different metadata in the working
        // file, its sync base, or a conflict copy. Cache bytes, not references.
        const file = { content: ref.encoding === "base64" ? bytesToBase64(bytes) : new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          ...(ref.encoding ? { encoding: ref.encoding } : {}), ...(ref.contentType ? { contentType: ref.contentType } : {}) };
        // TextDecoder consumes a UTF-8 BOM. Such decoded text does not roundtrip
        // to these bytes and must not share a content-cache entry with plain text.
        if (ref.encoding === "base64" || !(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) {
          cache.contents.set(contentKey(file), { bytes, hash: ref.object.slice(0, 64) });
        }
        return file;
      }
      const snapshot = emptyVault();
      snapshot.remoteRevision = stored.remoteRevision;
      if (stored.dismissedRecoveryIds) snapshot.dismissedRecoveryIds = stored.dismissedRecoveryIds;
      for (const [path, ref] of Object.entries(stored.files)) {
        if (!validVaultPath(path)) throw new Error("Invalid path in local vault.");
        snapshot.files[path] = (await readRef(ref))!;
      }
      for (const [path, base] of Object.entries(stored.base)) snapshot.base[path] = { revision: base.revision, file: await readRef(base.file) };
      for (const { local, remote, base, result, ...metadata } of stored.conflicts) snapshot.conflicts.push({ ...metadata,
        local: await readRef(local), remote: await readRef(remote),
        ...(base !== undefined ? { base: await readRef(base) } : {}),
        ...(result !== undefined ? { result: await readRef(result) } : {}),
      });
      if (stored.directoryBaselines) {
        snapshot.directoryBaselines = {};
        for (const [id, baseline] of Object.entries(stored.directoryBaselines)) {
          const files: Record<string, VaultFile> = {};
          for (const [path, ref] of Object.entries(baseline.files)) {
            if (!validVaultPath(path)) throw new Error("Invalid path in local folder history.");
            files[path] = (await readRef(ref))!;
          }
          snapshot.directoryBaselines[id] = { manifest: baseline.manifest, files };
        }
      }
      return snapshot;
    },
    async write(snapshot) {
      const root = await directory();
      const history = await root.getDirectoryHandle("history", { create: true });
      const stored: StoredSnapshot = { schemaVersion: 1, remoteRevision: snapshot.remoteRevision, files: {}, base: {}, conflicts: [] };
      if (snapshot.dismissedRecoveryIds) stored.dismissedRecoveryIds = snapshot.dismissedRecoveryIds;
      const cache = operationCache ?? createOperationCache();
      const known = new Set<string>();
      async function storeFile(file: VaultFile | null, path: string): Promise<FileRef | null> {
        if (!file) return null;
        const key = contentKey(file);
        const verified = cache.contents.get(key);
        const bytes = verified?.bytes ?? vaultFileBytes(file);
        const hash = verified?.hash ?? await hashBytes(bytes);
        cache.contents.set(key, { bytes, hash });
        const extension = file.encoding === "base64" ? "bin" : path.endsWith(".md") ? "md" : path.endsWith(".json") ? "json" : "txt";
        const object = `${hash}.${extension}`;
        if (!known.has(object)) {
          let existing: Uint8Array | null = cache.objects.get(object) ?? null;
          try { existing ??= new Uint8Array(await (await (await history.getFileHandle(object)).getFile()).arrayBuffer()); }
          catch (error) {
            if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
          }
          // An aborted write or interrupted process may have created this name
          // without its content. A filename alone is never a durable receipt.
          if (!existing || existing.length !== bytes.length || !existing.every((value, index) => value === bytes[index])) {
            await writeFile(history, object, bytes);
          }
          known.add(object);
          cache.objects.set(object, bytes);
        }
        return { object, ...(file.encoding ? { encoding: file.encoding } : {}), ...(file.contentType ? { contentType: file.contentType } : {}) };
      }
      for (const [path, file] of Object.entries(snapshot.files)) {
        if (!validVaultPath(path)) throw new Error("Invalid vault file path.");
        stored.files[path] = (await storeFile(file, path))!;
      }
      for (const [path, base] of Object.entries(snapshot.base)) stored.base[path] = { revision: base.revision, file: await storeFile(base.file, path) };
      for (const { local, remote, base, result, ...metadata } of snapshot.conflicts) stored.conflicts.push({ ...metadata,
        local: await storeFile(local, metadata.path), remote: await storeFile(remote, metadata.path),
        ...(base !== undefined ? { base: await storeFile(base, metadata.path) } : {}),
        ...(result !== undefined ? { result: await storeFile(result, metadata.path) } : {}),
      });
      if (snapshot.directoryBaselines) {
        stored.directoryBaselines = {};
        for (const [id, baseline] of Object.entries(snapshot.directoryBaselines)) {
          const files: Record<string, FileRef> = {};
          for (const [path, file] of Object.entries(baseline.files)) {
            if (!validVaultPath(path)) throw new Error("Invalid path in local folder history.");
            files[path] = (await storeFile(file, path))!;
          }
          stored.directoryBaselines[id] = { manifest: baseline.manifest, files };
        }
      }
      // Closing createWritable replaces the index only after all referenced content is durable.
      await writeFile(root, "vault-state.json", JSON.stringify(stored));
    },
  };
}

export function exportVault(snapshot: VaultSnapshot): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (const [path, file] of Object.entries(snapshot.files)) files[path] = vaultFileBytes(file);
  const info = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    files: Object.fromEntries(Object.entries(snapshot.files).map(([path, file]) => [path, { encoding: file.encoding, contentType: file.contentType }])),
  };
  files["vault-export.json"] = strToU8(JSON.stringify(info, null, 2));
  return zipSync(files, { level: 6 });
}

export function importVault(bytes: Uint8Array): Record<string, VaultFile> {
  if (bytes.length > 100_000_000) throw new Error("Please import a vault smaller than 100 MB.");
  let total = 0;
  const archive = unzipSync(bytes, { filter: (entry) => {
    total += entry.originalSize;
    if (total > 200_000_000 || entry.originalSize > 20_000_000) throw new Error("The expanded vault is too large to import.");
    if (!entry.name.endsWith("/") && !validVaultPath(entry.name)) throw new Error("The archive contains an invalid file path.");
    return !entry.name.endsWith("/");
  } });
  const info = archive["vault-export.json"] ? JSON.parse(new TextDecoder().decode(archive["vault-export.json"])) : { files: {} };
  const files: Record<string, VaultFile> = {};
  for (const [path, data] of Object.entries(archive)) {
    if (path === "vault-export.json") continue;
    const metadata = info.files?.[path] ?? {};
    const binary = metadata.encoding === "base64" || !/\.(md|markdown|json|txt)$/iu.test(path);
    files[path] = { content: binary ? bytesToBase64(data) : new TextDecoder("utf-8", { fatal: true }).decode(data),
      ...(binary ? { encoding: "base64" as const } : {}),
      ...(typeof metadata.contentType === "string" ? { contentType: metadata.contentType } : {}) };
  }
  return files;
}
