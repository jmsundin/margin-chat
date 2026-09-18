import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { backupBlobStore, createNeonReleaseProvider, restoreBlobBackup, validateBlobStoreTokens } from "../scripts/release/providers.mjs";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const sourceToken = "vercel_blob_rw_sourceStore_fake";
const backupToken = "vercel_blob_rw_backupStore_fake";
const targetToken = "vercel_blob_rw_targetStore_fake";
const config = { projectId: "project-123", productionBranchId: "br-production", databaseName: "main", roleName: "owner" };

function blobFake({ pageSize = 1 } = {}) {
  const stores = new Map<string, Map<string, any>>([[sourceToken, new Map()], [backupToken, new Map()], [targetToken, new Map()]]);
  const events: any[] = [];
  let serial = 0;
  const save = (token: string, pathname: string, value: string | Buffer, contentType = "application/octet-stream") => {
    const bytes = Buffer.from(value);
    stores.get(token)!.set(pathname, { bytes, contentType, etag: `"${++serial}"` });
  };
  const sdk = {
    async list(options: any) {
      events.push({ method: "list", ...options });
      const all = [...stores.get(options.token)!].filter(([key]) => key.startsWith(options.prefix)).sort(([a], [b]) => a.localeCompare(b));
      const start = Number(options.cursor || 0);
      const rows = all.slice(start, start + pageSize);
      return { blobs: rows.map(([pathname, record]) => ({ pathname, etag: record.etag, size: record.bytes.length })), hasMore: start + pageSize < all.length, cursor: String(start + pageSize) };
    },
    async get(pathname: string, options: any) {
      events.push({ method: "get", pathname, ...options });
      const record = stores.get(options.token)!.get(pathname);
      if (!record) return null;
      return { statusCode: 200, stream: new Response(record.bytes).body, blob: { pathname, etag: record.etag, size: record.bytes.length, contentType: record.contentType } };
    },
    async put(pathname: string, bytes: Buffer, options: any) {
      events.push({ method: "put", pathname, ...options });
      if (stores.get(options.token)!.has(pathname)) throw new Error("exists");
      save(options.token, pathname, bytes, options.contentType);
      return { pathname, etag: stores.get(options.token)!.get(pathname).etag };
    },
  };
  return { sdk, stores, save, events };
}

function seedVault(fake: ReturnType<typeof blobFake>, { body = "# Important note\nSaved content", manifestRevision = 1 } = {}) {
  const contentType = "text/markdown; charset=utf-8";
  const revision = hash(`utf8\n${contentType}\n${body}`);
  const path = "Notes/important.md";
  const root = `vaults/v1/${hash("a-user")}`;
  const bodyKey = `${root}/files/${hash(path)}/${revision}`;
  const manifestKey = `${root}/manifest.json`;
  fake.save(sourceToken, bodyKey, body, contentType);
  fake.save(sourceToken, manifestKey, JSON.stringify({ schemaVersion: 1, revision: manifestRevision, files: { [path]: { revision, deleted: false, encoding: "utf8", contentType, size: Buffer.byteLength(body) } } }), "application/json");
  return { bodyKey, manifestKey, body, contentType, root };
}

describe("release Blob providers", () => {
  test("requires explicit credentials for three distinct stores, including rotated tokens", () => {
    expect(validateBlobStoreTokens({ sourceToken, backupToken, rehearsalToken: targetToken })).toEqual({ sourceStoreId: "sourcestore", backupStoreId: "backupstore", rehearsalStoreId: "targetstore" });
    expect(() => validateBlobStoreTokens({ sourceToken, backupToken: "vercel_blob_rw_SOURCEstore_rotated" })).toThrow("distinct");
    expect(() => validateBlobStoreTokens({ sourceToken: "opaque", backupToken })).toThrow("explicit");
    expect(() => validateBlobStoreTokens({ sourceToken, backupToken, rehearsalToken: sourceToken })).toThrow("distinct");
  });

  test("backs up every page, verifies bodies, and writes complete inventory last", async () => {
    const fake = blobFake();
    seedVault(fake);
    fake.save(sourceToken, "legacy/attachment.pdf", "PDF contents", "application/pdf");
    const result = await backupBlobStore({ releaseId: "release-1", sourceToken, backupToken, sdk: fake.sdk });
    expect(result.objectCount).toBe(3);
    expect(result.inventory.objects.every((item: any) => item.sha256.length === 64 && item.backupEtag)).toBe(true);
    expect(fake.events.filter((event) => event.method === "list" && event.token === sourceToken).length).toBe(3);
    const puts = fake.events.filter((event) => event.method === "put");
    expect(puts.at(-1).pathname).toBe(result.inventoryPathname);
    expect(puts.every((event) => event.token === backupToken && event.access === "private" && !event.allowOverwrite)).toBe(true);
    expect(fake.events.filter((event) => event.method === "get").every((event) => event.useCache === false && event.headers["accept-encoding"] === "identity")).toBe(true);
    expect(result.inventorySha256).toBe(hash(fake.stores.get(backupToken)!.get(result.inventoryPathname).bytes));
  });

  test("rejects a manifest referencing an uncopied revision, with no complete inventory", async () => {
    const fake = blobFake();
    const { bodyKey } = seedVault(fake);
    fake.stores.get(sourceToken)!.delete(bodyKey);
    await expect(backupBlobStore({ releaseId: "missing-body", sourceToken, backupToken, sdk: fake.sdk })).rejects.toThrow("missing an immutable revision");
    expect(fake.stores.get(backupToken)!.has("releases/missing-body/inventory.json")).toBe(false);
  });

  test("captures mutable objects from one uncached body/ETag response while writes continue", async () => {
    const fake = blobFake();
    fake.save(sourceToken, "mutable", "before");
    const originalGet = fake.sdk.get;
    fake.sdk.get = async (pathname, options) => {
      if (options.token === sourceToken) fake.save(sourceToken, pathname, "after");
      return originalGet(pathname, options);
    };
    const result = await backupBlobStore({ releaseId: "racing", sourceToken, backupToken, sdk: fake.sdk });
    expect(result.inventory.objects[0].sha256).toBe(hash("after"));
    expect(result.inventory.objects[0].sourceEtag).toBe(fake.stores.get(sourceToken)!.get("mutable").etag);
    expect(fake.stores.get(backupToken)!.size).toBe(2);
  });

  test("preserves a captured manifest and its old body while the live manifest advances", async () => {
    const fake = blobFake({ pageSize: 10 });
    const { manifestKey, bodyKey, body } = seedVault(fake);
    const originalGet = fake.sdk.get;
    fake.sdk.get = async (pathname, options) => {
      const response = await originalGet(pathname, options);
      if (options.token === sourceToken && pathname === manifestKey) seedVault(fake, { body: "New content from live writer", manifestRevision: 2 });
      return response;
    };
    const result = await backupBlobStore({ releaseId: "late-race", sourceToken, backupToken, sdk: fake.sdk });
    expect(result.objectCount).toBe(2);
    expect(result.inventory.consistency).toContain("Per-user");
    expect(fake.events.filter((event) => event.method === "get" && event.token === sourceToken && event.pathname === manifestKey)).toHaveLength(1);
    await restoreBlobBackup({ inventory: result.inventory, backupToken, targetToken, targetPrefix: "rehearsal/late-race", sdk: fake.sdk });
    expect(JSON.parse(fake.stores.get(targetToken)!.get(`rehearsal/late-race/${manifestKey}`).bytes.toString()).revision).toBe(1);
    expect(fake.stores.get(targetToken)!.get(`rehearsal/late-race/${bodyKey}`).bytes.toString()).toBe(body);
    expect(JSON.parse(fake.stores.get(sourceToken)!.get(manifestKey).bytes.toString()).revision).toBe(2);
  });

  test("copies newly referenced revisions absent from the initial listing and retains immutable history", async () => {
    const fake = blobFake({ pageSize: 10 });
    const previous = seedVault(fake);
    const originalList = fake.sdk.list;
    let current: ReturnType<typeof seedVault>;
    fake.sdk.list = async (options) => {
      const response = await originalList(options);
      current = seedVault(fake, { body: "Written between list and snapshot", manifestRevision: 2 });
      return response;
    };
    const result = await backupBlobStore({ releaseId: "new-revision", sourceToken, backupToken, sdk: fake.sdk });
    expect(result.objectCount).toBe(3);
    expect(result.inventory.objects.map((object: any) => object.pathname)).toContain(previous.bodyKey);
    expect(result.inventory.objects.map((object: any) => object.pathname)).toContain(current!.bodyKey);
    await restoreBlobBackup({ inventory: result.inventory, backupToken, targetToken, targetPrefix: "rehearsal/new-revision", sdk: fake.sdk });
    expect(JSON.parse(fake.stores.get(targetToken)!.get(`rehearsal/new-revision/${current!.manifestKey}`).bytes.toString()).revision).toBe(2);
    expect(fake.stores.get(targetToken)!.get(`rehearsal/new-revision/${previous.bodyKey}`).bytes.toString()).toBe(previous.body);
  });

  test("rejects corrupt immutable bodies even when they are unreferenced history", async () => {
    const fake = blobFake();
    const previous = seedVault(fake);
    seedVault(fake, { body: "A later valid revision", manifestRevision: 2 });
    fake.save(sourceToken, previous.bodyKey, "corrupted old revision", previous.contentType);
    await expect(backupBlobStore({ releaseId: "corrupt-history", sourceToken, backupToken, sdk: fake.sdk })).rejects.toThrow("content-addressed pathname");
    expect(fake.stores.get(backupToken)!.has("releases/corrupt-history/inventory.json")).toBe(false);
  });

  test("copies revisions referenced only by history even when absent from the initial listing", async () => {
    const fake = blobFake({ pageSize: 10 });
    const { manifestKey, bodyKey, body, root } = seedVault(fake);
    const historyBytes = fake.stores.get(sourceToken)!.get(manifestKey).bytes;
    const historyKey = `${root}/history/${hash(historyBytes)}.json`;
    fake.save(sourceToken, historyKey, historyBytes, "application/json");
    fake.save(sourceToken, manifestKey, JSON.stringify({ schemaVersion: 1, revision: 2, files: {} }), "application/json");
    const originalList = fake.sdk.list;
    fake.sdk.list = async (options) => {
      const response = await originalList(options);
      response.blobs = response.blobs.filter((blob) => blob.pathname !== bodyKey);
      return response;
    };
    const { inventory } = await backupBlobStore({ releaseId: "history-closure", sourceToken, backupToken, sdk: fake.sdk });
    expect(inventory.objects.map((object: any) => object.pathname)).toContain(bodyKey);
    await restoreBlobBackup({ inventory, backupToken, targetToken, targetPrefix: "rehearsal/history-closure", sdk: fake.sdk });
    expect(fake.stores.get(targetToken)!.get(`rehearsal/history-closure/${bodyKey}`).bytes.toString()).toBe(body);
    expect(fake.stores.get(targetToken)!.get(`rehearsal/history-closure/${historyKey}`).bytes).toEqual(historyBytes);
    const targetPuts = fake.events.filter((event) => event.method === "put" && event.token === targetToken);
    expect(targetPuts[0].pathname).toBe(`rehearsal/history-closure/${bodyKey}`);
    const incomplete = { ...inventory, objects: inventory.objects.filter((object: any) => object.pathname !== bodyKey) };
    await expect(restoreBlobBackup({ inventory: incomplete, backupToken, targetToken, targetPrefix: "rehearsal/incomplete-history", sdk: fake.sdk })).rejects.toThrow("missing an immutable revision");
  });

  test("rejects history manifests whose bytes disagree with their filename hash", async () => {
    const fake = blobFake();
    const { manifestKey, root } = seedVault(fake);
    const original = fake.stores.get(sourceToken)!.get(manifestKey).bytes;
    const historyKey = `${root}/history/${hash(original)}.json`;
    fake.save(sourceToken, historyKey, JSON.stringify({ schemaVersion: 1, revision: 99, files: {} }), "application/json");
    await expect(backupBlobStore({ releaseId: "corrupt-history-json", sourceToken, backupToken, sdk: fake.sdk })).rejects.toThrow("history manifest does not match");
    expect(fake.stores.get(backupToken)!.has("releases/corrupt-history-json/inventory.json")).toBe(false);
  });

  test("rejects a referenced body's encoding or size that disagrees with its manifest", async () => {
    const fake = blobFake();
    const { manifestKey } = seedVault(fake);
    const manifest = JSON.parse(fake.stores.get(sourceToken)!.get(manifestKey).bytes.toString());
    manifest.files["Notes/important.md"].encoding = "base64";
    fake.save(sourceToken, manifestKey, JSON.stringify(manifest), "application/json");
    await expect(backupBlobStore({ releaseId: "wrong-encoding", sourceToken, backupToken, sdk: fake.sdk })).rejects.toThrow("captured manifest metadata");
  });

  test("preserves binary originals and tombstones with their encoding-aware revisions", async () => {
    const fake = blobFake();
    const { manifestKey, root } = seedVault(fake);
    const bytes = Buffer.from([0, 255, 1, 128, 10]);
    const contentType = "application/octet-stream";
    const path = "Attachments/item/original.bin";
    const revision = hash(Buffer.concat([Buffer.from(`base64\n${contentType}\n`), bytes]));
    const bodyKey = `${root}/files/${hash(path)}/${revision}`;
    const manifest = JSON.parse(fake.stores.get(sourceToken)!.get(manifestKey).bytes.toString());
    manifest.files[path] = { revision, encoding: "base64", contentType, size: bytes.length, deleted: false };
    manifest.files["Notes/deleted.md"] = { revision: hash("a deletion"), deleted: true };
    fake.save(sourceToken, bodyKey, bytes, contentType);
    fake.save(sourceToken, manifestKey, JSON.stringify(manifest), "application/json");
    const { inventory } = await backupBlobStore({ releaseId: "binary", sourceToken, backupToken, sdk: fake.sdk });
    await restoreBlobBackup({ inventory, backupToken, targetToken, targetPrefix: "rehearsal/binary", sdk: fake.sdk });
    expect(fake.stores.get(targetToken)!.get(`rehearsal/binary/${bodyKey}`).bytes).toEqual(bytes);
    const restored = JSON.parse(fake.stores.get(targetToken)!.get(`rehearsal/binary/${manifestKey}`).bytes.toString());
    expect(restored.files["Notes/deleted.md"].deleted).toBe(true);
    expect(restored.files[path].revision).toBe(revision);
  });

  test("reconciles a successful upload with a lost response, but rejects corruption", async () => {
    const fake = blobFake();
    fake.save(sourceToken, "one", "one");
    const originalPut = fake.sdk.put;
    fake.sdk.put = async (pathname, bytes, options) => {
      await originalPut(pathname, bytes, options);
      throw new Error("response lost");
    };
    expect((await backupBlobStore({ releaseId: "lost-response", sourceToken, backupToken, sdk: fake.sdk })).objectCount).toBe(1);

    const broken = blobFake();
    broken.save(sourceToken, "one", "one");
    broken.sdk.put = async (pathname, _bytes, options) => {
      broken.save(options.token, pathname, "corrupt", options.contentType);
      return { pathname, etag: "broken" };
    };
    await expect(backupBlobStore({ releaseId: "corrupt", sourceToken, backupToken, sdk: broken.sdk })).rejects.toThrow("verification failed");
    expect(broken.stores.get(backupToken)!.has("releases/corrupt/inventory.json")).toBe(false);
  });

  test("rejects weak etags and repeated cursors before committing an inventory", async () => {
    const weak = blobFake();
    weak.save(sourceToken, "one", "one");
    weak.stores.get(sourceToken)!.get("one").etag = 'W/"weak"';
    await expect(backupBlobStore({ releaseId: "weak", sourceToken, backupToken, sdk: weak.sdk })).rejects.toThrow("strong ETag");
    const repeated = blobFake();
    repeated.sdk.list = async () => ({ blobs: [], hasMore: true, cursor: "same" });
    await expect(backupBlobStore({ releaseId: "loop", sourceToken, backupToken, sdk: repeated.sdk })).rejects.toThrow("pagination cursor");
  });

  test("resumes a completed backup from its verified saved inventory", async () => {
    const fake = blobFake();
    fake.save(sourceToken, "one", "original");
    const first = await backupBlobStore({ releaseId: "resume", sourceToken, backupToken, sdk: fake.sdk });
    fake.save(sourceToken, "one", "changed later");
    fake.events.length = 0;
    const second = await backupBlobStore({ releaseId: "resume", sourceToken, backupToken, sdk: fake.sdk });
    expect(second.inventorySha256).toBe(first.inventorySha256);
    expect(fake.events.every((event) => event.token !== sourceToken && event.method !== "put")).toBe(true);
    fake.save(backupToken, first.inventory.objects[0].backupPathname, "tampered");
    await expect(backupBlobStore({ releaseId: "resume", sourceToken, backupToken, sdk: fake.sdk })).rejects.toThrow("integrity");
  });

  test("restores bodies before manifests in an isolated third store and is replay-safe", async () => {
    const fake = blobFake();
    const { manifestKey, bodyKey } = seedVault(fake);
    const { inventory } = await backupBlobStore({ releaseId: "restore", sourceToken, backupToken, sdk: fake.sdk });
    fake.events.length = 0;
    const args = { inventory, backupToken, targetToken, targetPrefix: "rehearsals/restore", sdk: fake.sdk };
    expect((await restoreBlobBackup(args)).objectCount).toBe(2);
    const puts = fake.events.filter((event) => event.method === "put");
    expect(puts.map((event) => event.pathname)).toEqual([`rehearsals/restore/${bodyKey}`, `rehearsals/restore/${manifestKey}`]);
    expect(puts.every((event) => event.token === targetToken)).toBe(true);
    expect((await restoreBlobBackup(args)).objectCount).toBe(2);
    await expect(restoreBlobBackup({ ...args, targetToken: sourceToken })).rejects.toThrow("isolated store");
    await expect(restoreBlobBackup({ ...args, targetPrefix: "" })).rejects.toThrow("isolated target prefix");
    fake.save(targetToken, `rehearsals/restore/${bodyKey}`, "different");
    await expect(restoreBlobBackup(args)).rejects.toThrow("verification failed");
  });
});

function neonFake() {
  const production = { id: config.productionBranchId, name: "production", project_id: config.projectId, current_state: "ready", protected: true };
  const branches: any[] = [production];
  const requests: any[] = [];
  const operations = new Map();
  let loseCreateResponse = false;
  const fetchImpl = async (input: string, options: any) => {
    const url = new URL(input);
    const pathname = url.pathname.replace(`/api/v2/projects/${config.projectId}`, "");
    requests.push({ pathname, url, ...options });
    if (pathname === "") return Response.json({ project: { id: config.projectId, name: "app", history_retention_seconds: 86400 } });
    if (pathname === "/branches" && options.method === "POST") {
      const body = JSON.parse(options.body);
      const branch = { ...body.branch, id: `br-release-${branches.length}`, project_id: config.projectId, current_state: "ready", parent_lsn: body.branch.parent_lsn || "0/123ABC" };
      branches.push(branch);
      if (loseCreateResponse) { loseCreateResponse = false; throw new Error("connection secret should not escape"); }
      const operation = { id: `op-${branches.length}`, project_id: config.projectId, status: "finished" };
      operations.set(operation.id, operation);
      return Response.json({ branch, operations: [operation] });
    }
    if (pathname === "/branches") return Response.json({ branches: branches.filter((branch) => branch.name.includes(url.searchParams.get("search")!)) });
    if (pathname.startsWith("/branches/")) return Response.json({ branch: branches.find((branch) => branch.id === pathname.slice(10)) });
    if (pathname.startsWith("/operations/")) return Response.json({ operation: operations.get(pathname.slice(12)) });
    if (pathname === "/connection_uri") return Response.json({ uri: `postgresql://owner:secret@ep-example${url.searchParams.get("pooled") === "true" ? "-pooler" : ""}.us-east-2.aws.neon.tech/main?sslmode=require` });
    return new Response("failure containing secret", { status: 500 });
  };
  return { branches, requests, operations, fetchImpl, loseNextCreateResponse() { loseCreateResponse = true; } };
}

describe("release Neon provider", () => {
  test("explicitly supports retained recovery snapshots on plans without branch protection", async () => {
    const fake = neonFake();
    const provider = createNeonReleaseProvider({ config: { ...config, recoveryBranchProtected: false }, env: { NEON_API_KEY: "fake" }, fetchImpl: fake.fetchImpl });
    const result = await provider.ensureReleaseBranches("free-plan");
    expect(result.recovery.protected).toBe(false);
    expect(result.rehearsal.parent_lsn).toBe(result.recovery.parent_lsn);
    const creations = fake.requests.filter((request) => request.method === "POST").map((request) => JSON.parse(request.body));
    expect(creations[0].endpoints).toBeUndefined();
    expect(creations[1].endpoints).toEqual([{ type: "read_write" }]);
    expect(() => createNeonReleaseProvider({ config: { ...config, recoveryBranchProtected: "false" }, env: { NEON_API_KEY: "fake" } })).toThrow("boolean");
  });

  test("creates protected recovery and isolated rehearsal from the exact same production LSN", async () => {
    const fake = neonFake();
    const provider = createNeonReleaseProvider({ config, env: { NEON_API_KEY: "fake" }, fetchImpl: fake.fetchImpl });
    const result = await provider.ensureReleaseBranches("release-123");
    expect(result.recovery.protected).toBe(true);
    expect(result.rehearsal.protected).toBe(false);
    expect(result.recovery.parent_id).toBe(config.productionBranchId);
    expect(result.rehearsal.parent_id).toBe(config.productionBranchId);
    expect(result.rehearsal.parent_lsn).toBe(result.recovery.parent_lsn);
    const creations = fake.requests.filter((request) => request.method === "POST").map((request) => JSON.parse(request.body));
    expect(creations[0].endpoints).toBeUndefined();
    expect(creations[1].endpoints).toEqual([{ type: "read_write" }]);
    expect(fake.requests.some((request) => request.method === "DELETE" || request.method === "PATCH")).toBe(false);
    await provider.ensureReleaseBranches("release-123");
    expect(fake.requests.filter((request) => request.method === "POST").length).toBe(2);
  });

  test("reconciles a lost POST response by exact branch name without duplicate creation", async () => {
    const fake = neonFake();
    fake.loseNextCreateResponse();
    const provider = createNeonReleaseProvider({ config, env: { NEON_API_KEY: "fake" }, fetchImpl: fake.fetchImpl });
    const result = await provider.ensureReleaseBranches("retry");
    expect(result.recovery.id).toBe("br-release-1");
    expect(fake.branches.length).toBe(3);
    expect(fake.requests.filter((request) => request.method === "POST").length).toBe(2);
  });

  test("fails replay if a named branch has the wrong parent", async () => {
    const fake = neonFake();
    const provider = createNeonReleaseProvider({ config, env: { NEON_API_KEY: "fake" }, fetchImpl: fake.fetchImpl });
    await provider.ensureReleaseBranches("retry-parent");
    fake.branches[1].parent_id = "br-unrelated";
    await expect(provider.ensureReleaseBranches("retry-parent")).rejects.toThrow("parent_id mismatch");
    expect(fake.branches.length).toBe(3);
  });

  test("validates explicit project and branch identities before any mutation", async () => {
    const fake = neonFake();
    const provider = createNeonReleaseProvider({ config: { ...config, projectName: "wrong" }, env: { NEON_API_KEY: "fake" }, fetchImpl: fake.fetchImpl });
    await expect(provider.ensureReleaseBranches("wrong-project")).rejects.toThrow("project identity");
    fake.branches[0].project_id = "unrelated";
    const other = createNeonReleaseProvider({ config, env: { NEON_API_KEY: "fake" }, fetchImpl: fake.fetchImpl });
    await expect(other.validateProduction()).rejects.toThrow("project identity");
    expect(fake.requests.every((request) => request.method === "GET")).toBe(true);
  });

  test("requests direct and pooled URIs from the API with explicit branch, database, and role", async () => {
    const fake = neonFake();
    const provider = createNeonReleaseProvider({ config, env: { NEON_API_KEY: "fake" }, fetchImpl: fake.fetchImpl });
    expect(await provider.connectionUri(config.productionBranchId)).not.toContain("-pooler");
    expect(await provider.connectionUri(config.productionBranchId, { pooled: true })).toContain("-pooler");
    const query = fake.requests.filter((request) => request.pathname === "/connection_uri")[0].url.searchParams;
    expect(query.get("branch_id")).toBe(config.productionBranchId);
    expect(query.get("database_name")).toBe(config.databaseName);
    expect(query.get("role_name")).toBe(config.roleName);
    expect(query.get("pooled")).toBe("false");
  });

  test("times out bounded readiness polling and retains branches", async () => {
    const fake = neonFake();
    let elapsed = 0;
    const resources: any[] = [];
    const provider = createNeonReleaseProvider({ config, env: { NEON_API_KEY: "fake" }, onBranch: async (kind: string, branch: any) => { resources.push({ kind, ...branch }); }, timeoutMs: 25, pollMs: 10, now: () => elapsed, sleep: async (ms: number) => { elapsed += ms; }, fetchImpl: async (input: string, options: any) => {
      const response = await fake.fetchImpl(input, options);
      const value = await response.json();
      if (value.branch && value.branch.id !== config.productionBranchId) value.branch.current_state = "init";
      return Response.json(value);
    } });
    await expect(provider.ensureReleaseBranches("timeout")).rejects.toThrow("Timed out");
    expect(elapsed).toBe(25);
    expect(fake.branches.length).toBe(2);
    expect(resources).toHaveLength(1);
    expect(resources[0].kind).toBe("recovery");
    expect(resources[0].id).toBe("br-release-1");
    expect(fake.requests.every((request) => request.method !== "DELETE")).toBe(true);
  });

  test("does not expose provider error bodies or connection secrets", async () => {
    const provider = createNeonReleaseProvider({ config, env: { NEON_API_KEY: "secret-token" }, fetchImpl: async () => new Response("postgresql://password-secret", { status: 403 }) });
    await expect(provider.validateProduction()).rejects.toThrow("HTTP 403");
    const broken = createNeonReleaseProvider({ config, env: { NEON_API_KEY: "secret-token" }, fetchImpl: async () => { throw new Error("secret-token"); } });
    await expect(broken.validateProduction()).rejects.toThrow("failed or timed out");
  });
});
