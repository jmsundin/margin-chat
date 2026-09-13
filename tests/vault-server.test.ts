import { afterAll, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVaultService, validateVaultPath } from "../server/vault/index.mjs";
import { createBlobVaultStorage, createFileVaultStorage, createVaultStorage, digest } from "../server/vault/storage.mjs";
import { createApiHandler } from "../server/routes/api.mjs";
import { createEmptyState } from "../client/src/initialState";
import { normalizeAppState } from "../server/db/validation.mjs";

function memoryStorage() {
  const objects = new Map<string, Buffer>();
  let beforeSwap: (() => Promise<void>) | null = null;
  return {
    kind: "memory", objects,
    setBeforeSwap(operation: (() => Promise<void>) | null) { beforeSwap = operation; },
    async read(key: string) { const bytes = objects.get(key); return bytes ? { bytes: Buffer.from(bytes), etag: digest(bytes) } : null; },
    async putImmutable(key: string, bytes: Buffer) {
      const existing = objects.get(key);
      if (existing && !existing.equals(bytes)) throw new Error("Immutable body replaced");
      objects.set(key, Buffer.from(bytes));
    },
    async compareAndSwap(key: string, bytes: Buffer, expected: string | null) {
      const hook = beforeSwap;
      beforeSwap = null;
      await hook?.();
      if ((objects.has(key) ? digest(objects.get(key)) : null) !== expected) return false;
      objects.set(key, Buffer.from(bytes));
      return true;
    },
  };
}
const edit = (path: string, content: string | null, baseRevision: string | null = null) => ({ path, content, baseRevision });
const tempDirectories: string[] = [];
afterAll(async () => { await Promise.all(tempDirectories.map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("Markdown vault synchronization", () => {
  test("preserves both unrelated offline edits while rejecting a stale edit of the same file", async () => {
    const storage = memoryStorage();
    const server = createVaultService({ storage });
    const start = await server.commit("alice", [edit("Notes/a.md", "base A"), edit("Notes/b.md", "base B")]);
    const baseA = start.manifest.files["Notes/a.md"].revision;
    const baseB = start.manifest.files["Notes/b.md"].revision;
    await server.commit("alice", [edit("Notes/a.md", "from phone", baseA)]);
    const merged = await server.commit("alice", [edit("Notes/b.md", "from computer", baseB)]);
    expect(merged.manifest.revision).toBe(3);
    await expect(server.commit("alice", [edit("Notes/a.md", "old computer copy", baseA)])).rejects.toMatchObject({ statusCode: 409, conflicts: ["Notes/a.md"] });
    expect((await server.readFile({ userId: "alice", path: "Notes/a.md" })).bytes.toString()).toBe("from phone");
    expect((await server.readFile({ userId: "alice", path: "Notes/b.md" })).bytes.toString()).toBe("from computer");
  });

  test("CAS retries merge unrelated races and revalidate original bases after same-file races", async () => {
    const storage = memoryStorage();
    const server = createVaultService({ storage });
    const other = createVaultService({ storage });
    const start = await server.commit("alice", [edit("a.md", "one")]);
    storage.setBeforeSwap(async () => { await other.commit("alice", [edit("b.md", "concurrent")]); });
    const merged = await server.commit("alice", [edit("c.md", "parallel")]);
    expect(Object.keys(merged.manifest.files).sort()).toEqual(["a.md", "b.md", "c.md"]);
    const original = start.manifest.files["a.md"].revision;
    storage.setBeforeSwap(async () => { await other.commit("alice", [edit("a.md", "phone", original)]); });
    await expect(server.commit("alice", [edit("a.md", "computer", original)])).rejects.toMatchObject({ statusCode: 409 });
    expect((await server.readFile({ userId: "alice", path: "a.md" })).bytes.toString()).toBe("phone");
  });

  test("a lost acknowledgement is idempotent and keeps historical content retrievable", async () => {
    const server = createVaultService({ storage: memoryStorage() });
    const initial = await server.commit("alice", [edit("note.md", "old")]);
    const base = initial.manifest.files["note.md"].revision;
    const changed = await server.commit("alice", [edit("note.md", "new", base)]);
    const retry = await server.commit("alice", [edit("note.md", "new", base)]);
    expect(retry.manifest.revision).toBe(changed.manifest.revision);
    expect((await server.readFile({ userId: "alice", path: "note.md", revision: base })).bytes.toString()).toBe("old");
    await expect(server.readFile({ userId: "bob", path: "note.md", revision: base })).rejects.toMatchObject({ statusCode: 404 });
  });

  test("tombstones prevent resurrection and commits never partially publish conflicting files", async () => {
    const server = createVaultService({ storage: memoryStorage() });
    const initial = await server.commit("alice", [edit("note.md", "old")]);
    const base = initial.manifest.files["note.md"].revision;
    const deleted = await server.commit("alice", [edit("note.md", null, base)]);
    expect(deleted.manifest.files["note.md"].deleted).toBe(true);
    await expect(server.commit("alice", [edit("note.md", "resurrect", base), edit("new.md", "also")])).rejects.toMatchObject({ statusCode: 409 });
    expect((await server.status("alice")).manifest.files["new.md"]).toBeUndefined();
    const retry = await server.commit("alice", [edit("note.md", null, base)]);
    expect(retry.manifest.revision).toBe(deleted.manifest.revision);
    await expect(server.readFile({ userId: "alice", path: "note.md" })).rejects.toMatchObject({ statusCode: 404 });
  });

  test("migration preserves legacy Markdown and original attachment bytes before accepting new clients", async () => {
    const state = createEmptyState();
    state.conversations[state.rootId].messages.push({ id: "message-a", createdAt: "2026-09-13T00:00:00.000Z", role: "user", content: "Legacy source" });
    let loads = 0;
    const database = {
      async loadWorkspace() { loads++; return { revision: 20, state }; },
      async listVaultAttachments() { return [{ id: "doc1", filename: "report.pdf", mimeType: "application/pdf", bytes: Buffer.from([1, 2, 3, 255]) }]; },
    };
    const server = createVaultService({ storage: memoryStorage(), database });
    const first = await server.status("alice");
    expect(first.manifest.revision).toBe(1);
    const sidecar = JSON.parse((await server.readFile({ userId: "alice", path: "workspace.json" })).bytes.toString());
    expect(sidecar.files).toEqual([]);
    expect((await server.readWorkspace("alice")).conversations[state.rootId].messages[0].content).toBe("Legacy source");
    expect((await server.readAttachment({ userId: "alice", documentId: "doc1" })).bytes).toEqual(Buffer.from([1, 2, 3, 255]));
    await server.status("alice");
    expect(loads).toBe(1);
  });

  test("a committed Markdown vault can rebuild an empty feature database", async () => {
    const projected: any[] = [];
    const database = { async projectVaultState(userId: string, state: any, revision: number) {
      if (state) normalizeAppState(state);
      projected.push({ userId, state, revision });
    } };
    const server = createVaultService({ storage: memoryStorage(), database });
    const result = await server.commit("alice", [edit("Notes/portable.md", "# Portable\n\nUser-authored **Markdown**")]);
    expect(result.projection.status).toBe("ready");
    expect(Object.values(projected[0].state.conversations).some((conversation: any) => conversation.notes.some((note: any) => note.content.includes("User-authored **Markdown**")))).toBe(true);
    projected.length = 0;
    const rebuilt = await server.rebuild("alice");
    expect(rebuilt.projection.status).toBe("ready");
    expect(projected[0].revision).toBe(1);
  });

  test("deleting the last note clears its feature projection while conflict and attachment Markdown remain files", async () => {
    const projected: any[] = [];
    const server = createVaultService({ storage: memoryStorage(), database: {
      async projectVaultState(_userId: string, state: any, revision: number) { projected.push({ state, revision }); },
    } });
    const initial = await server.commit("alice", [edit("note.md", "# Note"), edit("_conflicts/backup.md", "# Backup"), edit("Attachments/doc/source.md", "# Attachment")]);
    expect(Object.keys(projected[0].state.conversations)).toHaveLength(1);
    await server.commit("alice", [edit("note.md", null, initial.manifest.files["note.md"].revision)]);
    expect(projected.at(-1).state).toBeNull();
    expect((await server.readFile({ userId: "alice", path: "_conflicts/backup.md" })).bytes.toString()).toBe("# Backup");
  });

  test("indexes uppercase Markdown filenames and leaves encoded Markdown originals as binary files", async () => {
    const projected: any[] = [];
    const server = createVaultService({ storage: memoryStorage(), database: {
      async projectVaultState(_userId: string, state: any) { projected.push(state); },
    } });
    const originalBytes = Buffer.from([255, 254, 0, 1]);
    const initial = await server.commit("alice", [
      edit("Notes/Upper.MD", "# Uppercase note\n\nThe authoritative text."),
      { ...edit("Encoded.MD", originalBytes.toString("base64")), encoding: "base64" },
    ]);
    expect(initial.projection.status).toBe("ready");
    expect(initial.manifest.files["Notes/Upper.MD"].contentType).toBe("text/markdown; charset=utf-8");
    expect(Object.keys(projected[0].conversations)).toHaveLength(1);
    expect(Object.values(projected[0].conversations).some((conversation: any) => conversation.notes[0].content.includes("The authoritative text."))).toBe(true);
    expect((await server.readFile({ userId: "alice", path: "Encoded.MD" })).bytes).toEqual(originalBytes);
    await server.commit("alice", [edit("Notes/Upper.MD", null, initial.manifest.files["Notes/Upper.MD"].revision)]);
    expect(projected.at(-1)).toBeNull();
  });

  test("a feature database failure cannot discard a committed Markdown edit", async () => {
    let failing = true;
    const server = createVaultService({ storage: memoryStorage(), database: {
      async projectVaultState() { if (failing) throw new Error("Test index outage"); },
    } });
    const originalError = console.error;
    console.error = () => {};
    try {
      const saved = await server.commit("alice", [edit("note.md", "# Durable content")]);
      expect(saved.projection.status).toBe("pending");
      expect((await server.readFile({ userId: "alice", path: "note.md" })).bytes.toString()).toBe("# Durable content");
      failing = false;
      expect((await server.status("alice")).projection.status).toBe("ready");
    } finally { console.error = originalError; }
  });

  test("a legacy untouched starter chat does not establish a vault over actual device content", async () => {
    const server = createVaultService({ storage: memoryStorage(), database: { async loadWorkspace() { return { state: createEmptyState() }; } } });
    expect((await server.status("alice")).manifest.revision).toBe(0);
    const saved = await server.commit("alice", [edit("local.md", "# My real note")]);
    expect(Object.keys(saved.manifest.files)).toEqual(["local.md"]);
  });

  test("missing cloud configuration never writes authoritative content into Postgres", async () => {
    let writes = 0;
    const server = createVaultService({ env: {}, storage: null, database: { async saveState() { writes++; } } });
    expect((await server.status("alice")).configured).toBe(false);
    await expect(server.commit("alice", [edit("a.md", "a")])).rejects.toMatchObject({ statusCode: 503 });
    expect(writes).toBe(0);
    for (const path of ["../secrets", "/absolute", "a/../b", "a\\b", "a//b", "__proto__/file"]) expect(() => validateVaultPath(path)).toThrow();
    expect(validateVaultPath("Notes/Why Markdown? #1.md")).toBe("Notes/Why Markdown? #1.md");
  });

  test("local filesystem adapter serializes separate instances and only publishes complete manifests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "margin-vault-")); tempDirectories.push(directory);
    const a = createVaultService({ storage: createFileVaultStorage(directory) });
    const b = createVaultService({ storage: createFileVaultStorage(directory) });
    await Promise.all([a.commit("alice", [edit("a.md", "a")]), b.commit("alice", [edit("b.md", "b")])]);
    const result = await a.status("alice");
    expect(result.manifest.revision).toBe(2);
    expect(Object.keys(result.manifest.files).sort()).toEqual(["a.md", "b.md"]);
    expect(() => createVaultStorage({ VERCEL: "1", VAULT_STORAGE_DIR: directory })).toThrow();
  });

  test("Blob uses private uncached reads and conditional replacement; never overwrites immutable bodies", async () => {
    const objects = new Map<string, Buffer>();
    const calls: any[] = [];
    class BlobPreconditionFailedError extends Error { constructor() { super("changed"); this.name = "BlobPreconditionFailedError"; } }
    const sdk = {
      BlobPreconditionFailedError,
      async get(key: string, options: any) {
        calls.push({ kind: "get", key, options });
        const bytes = objects.get(key);
        // Blob weakens response ETags when HTTP compression is negotiated;
        // those validators cannot be used for an If-Match replacement.
        const etag = bytes && `"${digest(bytes)}"`;
        return bytes ? { statusCode: 200, stream: new Blob([bytes]).stream(), blob: {
          etag: options.headers?.["accept-encoding"] === "identity" ? etag : `W/${etag}`,
        } } : null;
      },
      async put(key: string, bytes: Buffer, options: any) {
        calls.push({ kind: "put", key, options });
        const old = objects.get(key);
        if (old && !options.allowOverwrite) throw new Error("already exists");
        if (options.ifMatch && (!old || `"${digest(old)}"` !== options.ifMatch)) throw new BlobPreconditionFailedError();
        objects.set(key, Buffer.from(bytes));
      },
    };
    const server = createVaultService({ storage: createBlobVaultStorage({ BLOB_READ_WRITE_TOKEN: "test-only" }, sdk) });
    const first = await server.commit("alice", [edit("a.md", "one")]);
    await server.commit("alice", [edit("a.md", "two", first.manifest.files["a.md"].revision)]);
    expect(calls.filter((call) => call.kind === "get").every((call) => call.options.access === "private" && call.options.useCache === false)).toBe(true);
    const manifestWrites = calls.filter((call) => call.kind === "put" && call.key.endsWith("/manifest.json"));
    expect(manifestWrites[0].options.allowOverwrite).toBe(false);
    expect(manifestWrites[1].options.ifMatch).toBeTruthy();
    expect(calls.filter((call) => call.kind === "put" && call.key.includes("/files/")).every((call) => call.options.allowOverwrite === false)).toBe(true);
  });
});

describe("authenticated vault API", () => {
  test("a request queued for one account cannot read or mutate another account after its session cookie changes", async () => {
    const source = createVaultService({ storage: memoryStorage() });
    let vaultAccesses = 0;
    const vaultService = { ...source };
    for (const name of ["status", "readFile", "commit", "commitBinary", "rebuild", "readAttachment"] as const) {
      (vaultService as any)[name] = async (...args: any[]) => { vaultAccesses++; return (source[name] as any)(...args); };
    }
    const handler = createApiHandler({
      runtimeConfig: { host: "127.0.0.1", port: 8787 }, vaultService,
      authService: { async getAuthContext(request: any) {
        return { user: { id: request.headers.cookie?.split("=")[1], role: "admin", billing: {} } };
      } },
    } as any);
    const http = createServer(handler);
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    const writeHeaders = { "content-type": "application/json", "x-margin-vault-write": "1", "x-margin-vault-user": "alice" };
    try {
      const first = await fetch(`${base}/api/vault/commit`, { method: "POST", headers: { ...writeHeaders, cookie: "account=alice" }, body: JSON.stringify({ changes: [edit("note.md", "Alice's private Markdown")] }) });
      expect(first.status).toBe(200);
      const beforeMismatch = vaultAccesses;
      for (const [method, path] of [
        ["GET", "/api/vault"],
        ["GET", "/api/vault/file?path=note.md"],
        ["POST", "/api/vault/commit"],
        ["PUT", "/api/vault/file?path=note.md"],
        ["POST", "/api/vault/rebuild"],
        ["GET", "/api/documents/document-1/original"],
        ["GET", "/api/documents/document-1/original?metadata=1"],
      ]) {
        const response = await fetch(`${base}${path}`, {
          method, headers: { ...writeHeaders, cookie: "account=bob" },
          ...(method === "GET" ? {} : { body: JSON.stringify({ changes: [edit("leaked.md", "Alice's queued edit")] }) }),
        });
        expect(response.status).toBe(409);
        expect((await response.json()).error).toContain("signed-in account changed");
      }
      expect(vaultAccesses).toBe(beforeMismatch);
      expect((await source.status("bob")).manifest.revision).toBe(0);
      expect((await source.readFile({ userId: "alice", path: "note.md" })).bytes.toString()).toBe("Alice's private Markdown");
      expect((await fetch(`${base}/api/vault`, { headers: { cookie: "account=bob", "x-margin-vault-user": "bob" } })).status).toBe(200);
      expect((await fetch(`${base}/api/vault`, { headers: { cookie: "account=bob" } })).status).toBe(200);
    } finally { await new Promise<void>((resolve) => http.close(() => resolve())); }
  });

  test("enforces account scope, revision conflicts, binary uploads, and disables legacy overwrite clients", async () => {
    const vaultService = createVaultService({ storage: memoryStorage() });
    const handler = createApiHandler({
      runtimeConfig: { host: "127.0.0.1", port: 8787 }, vaultService,
      authService: { async getAuthContext(request: any) { return { user: request.headers.authorization ? { id: request.headers.authorization, role: request.headers.authorization === "free" ? "user" : "admin", billing: {} } : null }; } },
    } as any);
    const http = createServer(handler);
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address() as { port: number };
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { authorization: "alice", "content-type": "application/json" };
    try {
      expect((await fetch(`${base}/api/vault`)).status).toBe(401);
      expect((await fetch(`${base}/api/vault`, { headers: { authorization: "free" } })).status).toBe(403);
      for (const unsafeHeaders of [
        { ...headers, "sec-fetch-site": "cross-site" },
        { ...headers, "content-type": "text/plain" },
      ]) {
        const unsafe = await fetch(`${base}/api/vault/commit`, { method: "POST", headers: unsafeHeaders, body: JSON.stringify({ changes: [edit("forged.md", "csrf")] }) });
        expect(unsafe.status).toBe(403);
      }
      expect((await vaultService.status("alice")).manifest.revision).toBe(0);
      const saved = await fetch(`${base}/api/vault/commit`, { method: "POST", headers, body: JSON.stringify({ changes: [edit("a.md", "text")] }) });
      expect(saved.status).toBe(200);
      const conflict = await fetch(`${base}/api/vault/commit`, { method: "POST", headers, body: JSON.stringify({ changes: [edit("a.md", "stale")] }) });
      expect(conflict.status).toBe(409);
      expect((await conflict.json()).conflicts).toEqual(["a.md"]);
      expect((await fetch(`${base}/api/vault/file?path=a.md`, { headers: { authorization: "bob" } })).status).toBe(404);
      expect((await fetch(`${base}/api/vault/file?${new URLSearchParams({ path: "../private.md" })}`, { headers })).status).toBe(400);
      expect((await fetch(`${base}/api/vault/file?path=a.md&revision=invalid`, { headers })).status).toBe(400);
      expect((await fetch(`${base}/api/state`, { method: "PUT", headers, body: "{}" })).status).toBe(409);
      expect((await fetch(`${base}/api/vault/file?path=forged.txt`, { method: "PUT", headers, body: "forged" })).status).toBe(403);
      const raw = await fetch(`${base}/api/vault/file?path=Attachments%2Fdoc%2Foriginal.bin`, { method: "PUT", headers: { authorization: "alice", "content-type": "application/octet-stream", "x-margin-vault-write": "1" }, body: new Uint8Array([0, 255, 1]) });
      expect(raw.status).toBe(200);
      const downloaded = await fetch(`${base}/api/vault/file?path=Attachments%2Fdoc%2Foriginal.bin`, { headers });
      expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(new Uint8Array([0, 255, 1]));
    } finally { await new Promise<void>((resolve) => http.close(() => resolve())); }
  });

  test("removing Blob configuration never re-enables legacy database writes for a migrated vault", async () => {
    let writes = 0;
    const handler = createApiHandler({
      runtimeConfig: { host: "127.0.0.1", port: 8787 },
      vaultService: createVaultService({ storage: null, env: {} }),
      database: { async getVaultProjectionRevision() { return 4; }, async saveState() { writes++; }, async loadWorkspace() { throw new Error("Must not use derived state as source"); } },
      authService: { async getAuthContext() { return { user: { id: "alice", role: "admin", billing: {} } }; } },
    } as any);
    const http = createServer(handler);
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    try {
      expect((await fetch(`${base}/api/state`)).status).toBe(503);
      expect((await fetch(`${base}/api/state`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(409);
      expect(writes).toBe(0);
    } finally { await new Promise<void>((resolve) => http.close(() => resolve())); }
  });
});
