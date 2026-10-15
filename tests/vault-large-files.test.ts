import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { presignUrl } from "@vercel/blob";
import { createApiHandler } from "../server/routes/api.mjs";
import { createVaultService, MAX_VAULT_FILE_BYTES } from "../server/vault/index.mjs";
import { createBlobVaultStorage, presignedPayload } from "../server/vault/storage.mjs";
import { setApiTransport } from "../client/src/lib/apiTransport";
import { createVaultTransport } from "../client/src/lib/vaultApi";
import { bytesToBase64, vaultFileRevision } from "../client/src/lib/vaultLocal";
import { MAX_VAULT_MEDIA_BYTES } from "../client/src/lib/documentMedia";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; setApiTransport(null); });

const STORE = "store_test1234";
const base64Url = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** A private Blob store in memory. Signing uses the real SDK; only the network calls are faked. */
function fakeBlob() {
  const objects = new Map<string, Buffer>();
  const issued: any[] = [];
  class BlobNotFoundError extends Error { constructor() { super("not found"); this.name = "BlobNotFoundError"; } }
  const sdk = {
    BlobNotFoundError,
    presignUrl,
    async issueSignedToken(options: any) {
      issued.push(options);
      const payload = { storeId: STORE, pathname: options.pathname, operations: options.operations, validUntil: options.validUntil,
        ...(options.maximumSizeInBytes ? { maximumSizeInBytes: options.maximumSizeInBytes } : {}) };
      return { delegationToken: `${base64Url(payload)}.signature`, clientSigningToken: "client-signing-token", validUntil: options.validUntil };
    },
    async get(key: string) {
      const bytes = objects.get(key);
      return bytes ? { statusCode: 200, stream: new Blob([new Uint8Array(bytes)]).stream(), blob: { etag: `"${bytes.length}-${key}"` } } : null;
    },
    async put(key: string, bytes: Buffer, options: any) {
      if (objects.has(key) && !options.allowOverwrite) throw new Error("already exists");
      objects.set(key, Buffer.from(bytes));
    },
    async head(key: string) {
      const bytes = objects.get(key);
      if (!bytes) throw new BlobNotFoundError();
      return { size: bytes.length };
    },
    async del(key: string) { objects.delete(key); },
  };
  /** What the browser reaches: the Blob API it uploads to (a local server, since the SDK
   * uploads with its own fetch outside a browser) and the store it downloads from. */
  async function startApi() {
    const api = createServer(async (request, response) => {
      const url = new URL(request.url!, "http://blob.test");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const pathname = url.searchParams.get("pathname");
      if (request.method !== "PUT" || !pathname || !url.searchParams.get("vercel-blob-delegation") || !url.searchParams.get("vercel-blob-signature")) {
        response.writeHead(400).end(JSON.stringify({ error: { code: "bad_request", message: "unsigned" } }));
        return;
      }
      objects.set(pathname, Buffer.concat(chunks));
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        url: `https://${STORE}.private.blob.vercel-storage.com/${pathname}`, downloadUrl: "", pathname, contentType: "application/pdf", contentDisposition: "", etag: "e",
      }));
    });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    return api;
  }
  async function handle(url: URL) {
    if (url.hostname.endsWith(".private.blob.vercel-storage.com") && url.searchParams.get("vercel-blob-signature")) {
      const bytes = objects.get(decodeURIComponent(url.pathname.slice(1)));
      return bytes ? new Response(new Uint8Array(bytes)) : new Response("missing", { status: 404 });
    }
    return null;
  }
  return { objects, issued, sdk, handle, startApi };
}

function pdf(size: number, seed = 1) {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) bytes[index] = (index * 31 + seed) % 251;
  return bytes;
}

describe("large vault files", () => {
  test("the app and the server agree on the largest file that syncs", () => {
    expect(MAX_VAULT_MEDIA_BYTES).toBe(MAX_VAULT_FILE_BYTES);
    expect(MAX_VAULT_FILE_BYTES).toBe(300 * 1024 * 1024);
  });

  test("a presigned URL splits into the parameters the browser SDK signs uploads with", () => {
    expect(presignedPayload("https://vercel.com/api/blob/?pathname=a%2Fb.pdf&vercel-blob-max-size=9&vercel-blob-delegation=d.t&vercel-blob-signature=s"))
      .toEqual({ delegationToken: "d.t", signature: "s", params: { "vercel-blob-max-size": "9" } });
    expect(() => presignedPayload("https://vercel.com/api/blob/?pathname=x")).toThrow();
  });

  test("an upload is signed only for the exact key, size and revision it describes, and checked before it is published", async () => {
    const blob = fakeBlob();
    const service = createVaultService({ storage: createBlobVaultStorage({ BLOB_READ_WRITE_TOKEN: "test-only" }, blob.sdk) });
    const bytes = pdf(5000);
    const contentType = "application/pdf";
    const upload = { path: "Books/Big.pdf", revision: await vaultFileRevision(bytes, "base64", contentType), size: bytes.length, contentType };

    const plan = await service.prepareUpload("alice", upload);
    expect(plan.mode).toBe("direct");
    expect(plan.pathname).toMatch(/^vaults\/v1\/[a-f0-9]{64}\/files\/[a-f0-9]{64}\/[a-f0-9]{64}$/u);
    // Another account, or another file, gets a different key.
    expect((await service.prepareUpload("bob", upload)).pathname).not.toBe(plan.pathname);
    await expect(service.uploadPayload("alice", { pathname: "vaults/v1/other", clientPayload: JSON.stringify(upload) })).rejects.toThrow("doesn't match");
    await expect(service.uploadPayload("alice", { pathname: plan.pathname, clientPayload: JSON.stringify({ ...upload, size: MAX_VAULT_FILE_BYTES + 1 }) })).rejects.toThrow("at most 300 MB");
    const payload = await service.uploadPayload("alice", { pathname: plan.pathname, clientPayload: JSON.stringify(upload) });
    expect(payload.delegationToken).toContain(".");
    expect(blob.issued.at(-1)).toMatchObject({ pathname: plan.pathname, operations: ["put"], maximumSizeInBytes: bytes.length });

    // Bytes that don't match the revision are thrown away, not published.
    blob.objects.set(plan.pathname, Buffer.from(pdf(5000, 2)));
    await expect(service.commitUploaded("alice", { ...upload, baseRevision: null })).rejects.toThrow("didn't arrive intact");
    expect(blob.objects.has(plan.pathname)).toBe(false);
    await expect(service.commitUploaded("alice", { ...upload, baseRevision: null })).rejects.toThrow("hasn't arrived");

    blob.objects.set(plan.pathname, Buffer.from(bytes));
    const saved = await service.commitUploaded("alice", { ...upload, baseRevision: null });
    expect(saved.manifest.files["Books/Big.pdf"]).toMatchObject({ revision: upload.revision, encoding: "base64", contentType, size: bytes.length });
    expect((await service.prepareUpload("alice", upload)).mode).toBe("stored");
    expect(Buffer.from((await service.readFile({ userId: "alice", path: "Books/Big.pdf" })).bytes)).toEqual(Buffer.from(bytes));
  });

  test("a small file still downloads through the server; a large one through a short-lived link", async () => {
    const blob = fakeBlob();
    const service = createVaultService({ storage: createBlobVaultStorage({ BLOB_READ_WRITE_TOKEN: "test-only" }, blob.sdk) });
    const small = await service.commit("alice", [{ path: "Pics/Cat.png", content: "AQI=", encoding: "base64", contentType: "image/png", baseRevision: null }]);
    expect(await service.readFileUrl({ userId: "alice", path: "Pics/Cat.png", revision: small.manifest.files["Pics/Cat.png"].revision })).toBeNull();
    const big = pdf(4 * 1024 * 1024);
    const large = await service.commitBinary("alice", { path: "Big.pdf", baseRevision: null, bytes: big, contentType: "application/pdf" });
    const url = await service.readFileUrl({ userId: "alice", path: "Big.pdf", revision: large.manifest.files["Big.pdf"].revision });
    expect(url).toStartWith(`https://${STORE.replace("store_", "")}.private.blob.vercel-storage.com/vaults/v1/`);
    expect(blob.issued.at(-1).operations).toEqual(["get"]);
  });

  describe("from the browser through the API", () => {
    let server: Server;
    let blobApi: Server;
    const apiUrl = process.env.VERCEL_BLOB_API_URL;
    async function start(blob: ReturnType<typeof fakeBlob>) {
      blobApi = await blob.startApi();
      process.env.VERCEL_BLOB_API_URL = `http://127.0.0.1:${(blobApi.address() as { port: number }).port}`;
      const service = createVaultService({ storage: createBlobVaultStorage({ BLOB_READ_WRITE_TOKEN: "test-only" }, blob.sdk) });
      const handler = createApiHandler({
        runtimeConfig: { host: "127.0.0.1", port: 8787 }, vaultService: service,
        authService: { async getAuthContext() { return { user: { id: "alice", role: "admin", billing: {} } }; } },
      } as any);
      server = createServer(handler);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      // Requests to the API go to the server; requests to Blob go to the fake store.
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input instanceof Request ? input.url : input), base);
        const faked = await blob.handle(url);
        if (!faked && url.hostname !== "127.0.0.1") throw new Error(`Unexpected request ${init?.method} ${url}`);
        return faked ?? originalFetch(url, init);
      }) as typeof fetch;
      setApiTransport({ serverUrl: base, fetch: ((input: string, init?: RequestInit) => globalThis.fetch(new URL(input, base), init)) as typeof fetch });
      return service;
    }
    afterEach(() => {
      server?.close();
      blobApi?.close();
      if (apiUrl === undefined) delete process.env.VERCEL_BLOB_API_URL;
      else process.env.VERCEL_BLOB_API_URL = apiUrl;
    });

    test("a 4 MB PDF uploads straight to storage, publishes, and downloads back intact", async () => {
      const blob = fakeBlob();
      const service = await start(blob);
      const bytes = pdf(4 * 1024 * 1024 + 7);
      const transport = createVaultTransport("alice");
      const receipt = await transport.commit([{ path: "Books/Big.pdf", content: bytesToBase64(bytes), encoding: "base64", contentType: "application/pdf", baseRevision: null }]);
      const entry = receipt.files["Books/Big.pdf"];
      expect(entry.revision).toBe(await vaultFileRevision(bytes, "base64", "application/pdf"));
      // The bytes reached the store under that revision, never through the API.
      expect([...blob.objects.keys()].some((key) => key.endsWith(`/${entry.revision}`))).toBe(true);
      expect((await service.status("alice")).manifest.files["Books/Big.pdf"].revision).toBe(entry.revision);

      const file = await transport.read("Books/Big.pdf", entry);
      expect(file.encoding).toBe("base64");
      expect(file.content).toBe(bytesToBase64(bytes));
    });
  });
});
