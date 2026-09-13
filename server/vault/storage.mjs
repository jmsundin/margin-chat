import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { HttpError } from "../lib/errors.mjs";

export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Small object-store contract: immutable bodies and compare-and-swap metadata. */
export function createFileVaultStorage(directory) {
  const root = resolve(directory);
  function filename(key) {
    const path = resolve(root, key);
    if (!path.startsWith(`${root}${sep}`)) throw new Error("Invalid storage key.");
    return path;
  }
  async function read(key) {
    try {
      const bytes = await readFile(filename(key));
      return { bytes, etag: digest(bytes) };
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  async function locked(key, operation) {
    const lock = `${filename(key)}.lock`;
    await mkdir(dirname(lock), { recursive: true });
    let acquired = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        await mkdir(lock);
        acquired = true;
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        await new Promise((done) => setTimeout(done, 25));
      }
    }
    // Never expire a live writer's lock. A crashed development process leaves a
    // lock that must be removed explicitly with the development server stopped.
    if (!acquired) throw new HttpError(503, "The local vault is busy. Retry, or remove its abandoned .lock directory after stopping development servers.");
    try { return await operation(); }
    finally { await rm(lock, { recursive: true, force: true }); }
  }
  async function atomicWrite(key, bytes) {
    const target = filename(key);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
  }
  return {
    kind: "filesystem",
    read,
    async putImmutable(key, bytes) {
      return locked(key, async () => {
        const existing = await read(key);
        if (existing) {
          if (!existing.bytes.equals(bytes)) throw new Error("Immutable vault revision changed.");
          return;
        }
        await atomicWrite(key, bytes);
      });
    },
    async compareAndSwap(key, bytes, expectedEtag) {
      return locked(key, async () => {
        const existing = await read(key);
        if ((existing?.etag ?? null) !== expectedEtag) return false;
        await atomicWrite(key, bytes);
        return true;
      });
    },
  };
}

export function createBlobVaultStorage(env = process.env, sdkOverride) {
  const options = env.BLOB_STORE_ID
    ? { storeId: env.BLOB_STORE_ID }
    : { token: env.BLOB_READ_WRITE_TOKEN };
  let sdkPromise;
  const sdk = () => sdkOverride ?? (sdkPromise ??= import("@vercel/blob"));
  async function read(key) {
    const api = await sdk();
    const result = await api.get(key, { ...options, access: "private", useCache: false });
    if (!result) return null;
    if (result.statusCode !== 200 || !result.stream || !result.blob.etag) {
      throw new Error("The vault store returned an invalid response.");
    }
    return { bytes: Buffer.from(await new Response(result.stream).arrayBuffer()), etag: result.blob.etag };
  }
  return {
    kind: "blob",
    read,
    async putImmutable(key, bytes, contentType) {
      const api = await sdk();
      try {
        await api.put(key, bytes, {
          ...options, access: "private", addRandomSuffix: false,
          allowOverwrite: false, contentType,
        });
      } catch (error) {
        const existing = await read(key);
        if (!existing?.bytes.equals(bytes)) throw error;
      }
    },
    async compareAndSwap(key, bytes, expectedEtag) {
      const api = await sdk();
      try {
        await api.put(key, bytes, {
          ...options, access: "private", addRandomSuffix: false,
          allowOverwrite: expectedEtag !== null,
          ...(expectedEtag === null ? {} : { ifMatch: expectedEtag }),
          contentType: "application/json", cacheControlMaxAge: 60,
        });
        return true;
      } catch (error) {
        if (error.name === "BlobPreconditionFailedError" ||
            (api.BlobPreconditionFailedError && error instanceof api.BlobPreconditionFailedError)) return false;
        // Creation uses allowOverwrite:false, which has no dedicated SDK error.
        if (expectedEtag === null && await read(key)) return false;
        throw error;
      }
    },
  };
}

export function createVaultStorage(env = process.env) {
  if (env.VAULT_STORAGE_DIR) {
    if (env.VERCEL) throw new Error("VAULT_STORAGE_DIR is for durable local development disks, not Vercel functions. Configure a private Blob store.");
    return createFileVaultStorage(env.VAULT_STORAGE_DIR);
  }
  if (env.BLOB_READ_WRITE_TOKEN || env.BLOB_STORE_ID) return createBlobVaultStorage(env);
  return null;
}
