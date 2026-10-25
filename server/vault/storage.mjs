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
    /** Deletes every object whose key starts with `prefix`, a directory ending in /. */
    async removePrefix(prefix) {
      if (!prefix.endsWith("/")) throw new Error("Invalid storage prefix.");
      await rm(filename(prefix.slice(0, -1)), { recursive: true, force: true });
    },
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

/** The SDK's presigned upload takes the signature and parameters of a presigned
 * URL rather than the URL itself; split one back into those parts. */
export function presignedPayload(presignedUrl) {
  const params = {};
  let delegationToken = "";
  let signature = "";
  for (const [key, value] of new URL(presignedUrl).searchParams) {
    if (key === "vercel-blob-delegation") delegationToken = value;
    else if (key === "vercel-blob-signature") signature = value;
    else if (key !== "pathname") params[key] = value;
  }
  if (!delegationToken || !signature) throw new Error("The vault store returned an invalid upload URL.");
  return { delegationToken, signature, params };
}

export function createBlobVaultStorage(env = process.env, sdkOverride) {
  const options = env.BLOB_STORE_ID
    ? { storeId: env.BLOB_STORE_ID }
    : { token: env.BLOB_READ_WRITE_TOKEN };
  let sdkPromise;
  const sdk = () => sdkOverride ?? (sdkPromise ??= import("@vercel/blob"));
  async function read(key) {
    const api = await sdk();
    // Compressed HTTP responses carry weak ETags, which cannot satisfy If-Match.
    // Read the uncompressed representation so bytes and its strong validator
    // come from the same response (a separate head() would introduce a race).
    const result = await api.get(key, {
      ...options, access: "private", useCache: false,
      headers: { "accept-encoding": "identity" },
    });
    if (!result) return null;
    if (result.statusCode !== 200 || !result.stream || !result.blob.etag || result.blob.etag.startsWith("W/")) {
      throw new Error("The vault store returned an invalid response.");
    }
    return { bytes: Buffer.from(await new Response(result.stream).arrayBuffer()), etag: result.blob.etag };
  }
  /** Short-lived URL material scoped to one key, so a browser moves the bytes
   * itself: a function can't carry a request or response over 4.5 MB on Vercel. */
  async function signed(key, operations, extra = {}) {
    const api = await sdk();
    return api.issueSignedToken({ ...options, pathname: key, operations, validUntil: Date.now() + 60 * 60 * 1000, ...extra });
  }
  return {
    kind: "blob",
    read,
    /** Deletes every object whose key starts with `prefix`, a page of keys at a time. */
    async removePrefix(prefix) {
      if (!prefix.endsWith("/")) throw new Error("Invalid storage prefix.");
      const api = await sdk();
      let cursor;
      do {
        const page = await api.list({ ...options, prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
        if (page.blobs.length) await api.del(page.blobs.map((blob) => blob.url), options);
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
    },
    direct: {
      /** The store's own name for a key, which the browser uploads to. */
      pathname: (key) => key,
      /** The query the SDK's presigned upload expects: a PUT (or multipart) to exactly this key, at most `size` bytes. */
      async uploadPayload(key, size) {
        const api = await sdk();
        const token = await signed(key, ["put"], { maximumSizeInBytes: size });
        const { presignedUrl } = await api.presignUrl(token, {
          operation: "put", pathname: key, access: "private", maximumSizeInBytes: size, allowOverwrite: false,
        });
        return presignedPayload(presignedUrl);
      },
      /** The stored size in bytes, or null when nothing is stored under the key. */
      async size(key) {
        const api = await sdk();
        try {
          return (await api.head(key, options))?.size ?? null;
        } catch (error) {
          if (error.name === "BlobNotFoundError" || (api.BlobNotFoundError && error instanceof api.BlobNotFoundError)) return null;
          throw error;
        }
      },
      async downloadUrl(key) {
        const api = await sdk();
        const token = await signed(key, ["get"]);
        return (await api.presignUrl(token, { operation: "get", pathname: key, access: "private", validUntil: Date.now() + 15 * 60 * 1000 })).presignedUrl;
      },
      /** The SHA-256 of `lead` followed by the stored bytes, read as a stream; null when the key is missing. */
      async digest(key, lead) {
        const api = await sdk();
        const result = await api.get(key, { ...options, access: "private", useCache: false, headers: { "accept-encoding": "identity" } });
        if (!result) return null;
        if (result.statusCode !== 200 || !result.stream) throw new Error("The vault store returned an invalid response.");
        const hash = createHash("sha256").update(lead);
        let size = 0;
        for await (const chunk of result.stream) {
          size += chunk.length;
          hash.update(chunk);
        }
        return { digest: hash.digest("hex"), size };
      },
      async remove(key) {
        const api = await sdk();
        await api.del(key, options);
      },
    },
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
  if (env.BLOB_READ_WRITE_TOKEN || env.BLOB_STORE_ID) {
    const storage = createBlobVaultStorage(env);
    const prefix = env.VAULT_STORAGE_PREFIX ?? "";
    if (!prefix) return storage;
    if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\/$/u.test(prefix)) {
      throw new Error("VAULT_STORAGE_PREFIX must be a relative directory prefix ending in /.");
    }
    return {
      kind: storage.kind,
      read: (key) => storage.read(prefix + key),
      removePrefix: (key) => storage.removePrefix(prefix + key),
      putImmutable: (key, bytes, type) => storage.putImmutable(prefix + key, bytes, type),
      compareAndSwap: (key, bytes, etag) => storage.compareAndSwap(prefix + key, bytes, etag),
      direct: {
        uploadPayload: (key, size) => storage.direct.uploadPayload(prefix + key, size),
        size: (key) => storage.direct.size(prefix + key),
        downloadUrl: (key) => storage.direct.downloadUrl(prefix + key),
        digest: (key, lead) => storage.direct.digest(prefix + key, lead),
        remove: (key) => storage.direct.remove(prefix + key),
        pathname: (key) => prefix + key,
      },
    };
  }
  return null;
}
