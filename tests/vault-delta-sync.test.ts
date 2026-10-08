import { describe, expect, test } from "bun:test";
import { VaultSync, pendingVaultChanges } from "../client/src/lib/vaultSync";
import { type VaultManifest, type VaultSnapshot, type VaultStore, type VaultTransport } from "../client/src/lib/vaultTypes";
import { createVaultService } from "../server/vault/index.mjs";
import { digest } from "../server/vault/storage.mjs";
import { createApiHandler } from "../server/routes/api.mjs";
import { createServer } from "node:http";

function store(initial: VaultSnapshot | null = null): VaultStore {
  let snapshot = structuredClone(initial);
  let tail = Promise.resolve();
  return {
    async read() { return structuredClone(snapshot); },
    async write(value) { snapshot = structuredClone(value); },
    lock<T>(operation: () => Promise<T>): Promise<T> {
      const current = tail.then(operation);
      tail = current.then(() => undefined, () => undefined);
      return current;
    },
  };
}

function memoryStorage() {
  const objects = new Map<string, Buffer>();
  return {
    kind: "memory", objects,
    async read(key: string) { const bytes = objects.get(key); return bytes ? { bytes, etag: digest(bytes) } : null; },
    async putImmutable(key: string, bytes: Buffer) { objects.set(key, Buffer.from(bytes)); },
    async compareAndSwap(key: string, bytes: Buffer, expected: string | null) {
      if ((objects.has(key) ? digest(objects.get(key)!) : null) !== expected) return false;
      objects.set(key, Buffer.from(bytes)); return true;
    },
  };
}

const normalize = (manifest: any): VaultManifest => ({ schemaVersion: 1, revision: manifest.revision,
  files: Object.fromEntries(Object.entries(manifest.files).map(([path, entry]: [string, any]) => [path, {
    revision: entry.revision, deleted: entry.deleted,
    ...(entry.encoding === "base64" ? { encoding: "base64" as const } : {}),
    ...(entry.contentType ? { contentType: entry.contentType } : {}),
  }])) });

function cloud() {
  const storage = memoryStorage();
  const server = createVaultService({ storage });
  const requests: string[] = [];
  const downloaded: string[] = [];
  const transport: VaultTransport = {
    async manifest() { requests.push("manifest"); return normalize((await server.status("user")).manifest); },
    async changes(since) {
      requests.push(`changes:${since}`);
      const { revision, files } = await server.changes("user", since);
      return normalize({ revision, files });
    },
    async read(path, entry) {
      downloaded.push(path);
      const { bytes } = await server.readFile({ userId: "user", path, revision: entry.revision });
      return { content: bytes.toString(entry.encoding === "base64" ? "base64" : "utf8"),
        ...(entry.encoding ? { encoding: entry.encoding } : {}), ...(entry.contentType ? { contentType: entry.contentType } : {}) };
    },
    async commit(changes) {
      requests.push("commit");
      const { manifest, previousRevision } = await server.commit("user", changes);
      // Like the HTTP route, acknowledge only the saved entries.
      const committed = normalize(manifest);
      return { ...committed, files: Object.fromEntries(changes.map((change) => [change.path, committed.files[change.path]])), previousRevision };
    },
  };
  return { server, storage, transport, requests, downloaded, device: (snapshot: VaultSnapshot | null = null) => new VaultSync(store(snapshot), transport) };
}

const markdown = (content: string) => ({ content, contentType: "text/markdown; charset=utf-8" });

async function write(device: VaultSync, path: string, content: string | null) {
  const previous = (await device.read()).files;
  const next = { ...previous };
  if (content === null) delete next[path]; else next[path] = markdown(content);
  return device.edit(next, previous);
}

describe("cloud changes since a revision", () => {
  test("lists only entries changed after the revision a device already has", async () => {
    const { server } = cloud();
    const first = await server.commit("user", [{ path: "a.md", content: "A", baseRevision: null }, { path: "b.md", content: "B", baseRevision: null }]);
    expect(first.previousRevision).toBe(0);
    expect(first.manifest.files["a.md"].changedAt).toBe(1);
    const second = await server.commit("user", [{ path: "b.md", content: "B2", baseRevision: first.manifest.files["b.md"].revision }]);
    expect(second.previousRevision).toBe(1);
    expect(second.manifest.files["a.md"].changedAt).toBe(1);

    const changes = await server.changes("user", 1);
    expect(changes.revision).toBe(2);
    expect(Object.keys(changes.files)).toEqual(["b.md"]);
    expect(Object.keys((await server.changes("user", 0)).files).sort()).toEqual(["a.md", "b.md"]);
    expect((await server.changes("user", 2)).files).toEqual({});
    // A commit whose content is already in the cloud creates no revision.
    const repeated = await server.commit("user", [{ path: "b.md", content: "B2", baseRevision: second.manifest.files["b.md"].revision }]);
    expect(repeated.manifest.revision).toBe(2);
    expect(repeated.previousRevision).toBe(2);
    await expect(server.changes("user", -1)).rejects.toMatchObject({ statusCode: 400 });
  });

  test("entries saved before changes were tracked count as changed until the next commit stamps them", async () => {
    const { server, storage } = cloud();
    await server.commit("user", [{ path: "old.md", content: "Old", baseRevision: null }]);
    await server.commit("user", [{ path: "other.md", content: "Other", baseRevision: null }]);
    const key = [...storage.objects.keys()].find((name) => name.endsWith("/manifest.json"))!;
    const legacy = JSON.parse(storage.objects.get(key)!.toString());
    for (const entry of Object.values<any>(legacy.files)) delete entry.changedAt;
    storage.objects.set(key, Buffer.from(JSON.stringify(legacy)));

    expect(Object.keys((await server.changes("user", 1)).files).sort()).toEqual(["old.md", "other.md"]);
    expect((await server.changes("user", 2)).files).toEqual({});
    const next = await server.commit("user", [{ path: "new.md", content: "New", baseRevision: null }]);
    expect(next.manifest.files["old.md"].changedAt).toBe(2);
    expect(Object.keys((await server.changes("user", 2)).files)).toEqual(["new.md"]);
  });

  test("the HTTP routes return changes and acknowledge only the saved entries", async () => {
    const { server } = cloud();
    await server.commit("alice", [{ path: "kept.md", content: "Kept", baseRevision: null }]);
    const handler = createApiHandler({
      runtimeConfig: { host: "127.0.0.1", port: 8787 }, vaultService: server,
      authService: { async getAuthContext() { return { user: { id: "alice", role: "admin", billing: {} } }; } },
    } as any);
    const http = createServer(handler);
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    try {
      const saved = await fetch(`${base}/api/vault/commit?acknowledge=changes`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ changes: [{ path: "added.md", content: "Added", baseRevision: null }] }),
      });
      expect(saved.status).toBe(200);
      const receipt = await saved.json();
      expect(Object.keys(receipt.manifest.files)).toEqual(["added.md"]);
      expect(receipt.manifest.revision).toBe(2);
      expect(receipt.previousRevision).toBe(1);
      const changes = await (await fetch(`${base}/api/vault/changes?since=1`)).json();
      expect(changes.revision).toBe(2);
      expect(Object.keys(changes.files)).toEqual(["added.md"]);
      expect((await fetch(`${base}/api/vault/changes?since=nope`)).status).toBe(400);
      // Without the acknowledgement option, the complete manifest is returned as before.
      const full = await (await fetch(`${base}/api/vault/commit`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ changes: [{ path: "third.md", content: "Third", baseRevision: null }] }),
      })).json();
      expect(Object.keys(full.manifest.files).sort()).toEqual(["added.md", "kept.md", "third.md"]);
    } finally {
      await new Promise((resolve) => http.close(resolve));
    }
  });
});

describe("delta sync", () => {
  test("after one complete sync, a device asks only for later changes", async () => {
    const remote = cloud();
    const laptop = remote.device();
    await write(laptop, "a.md", "A");
    await write(laptop, "b.md", "B");
    await laptop.sync();
    const phone = remote.device();
    await phone.sync();
    expect(remote.requests.filter((request) => request === "manifest")).toHaveLength(2);
    expect((await phone.read()).pulledRevision).toBe(1);

    remote.requests.length = 0; remote.downloaded.length = 0;
    await write(laptop, "b.md", "B from the laptop");
    await write(laptop, "a.md", null);
    await laptop.sync();
    const synced = await phone.sync();
    expect(remote.requests).toEqual(["changes:1", "commit", "changes:1"]);
    expect(remote.downloaded).toEqual(["b.md"]);
    expect(synced.files["b.md"].content).toBe("B from the laptop");
    expect(synced.files["a.md"]).toBeUndefined();
    expect(synced.pulledRevision).toBe(2);

    // An idle sync downloads nothing.
    remote.requests.length = 0; remote.downloaded.length = 0;
    expect(await phone.sync()).toEqual(synced);
    expect(remote.requests).toEqual(["changes:2"]);
    expect(remote.downloaded).toEqual([]);
  });

  test("a device's own commit keeps it current when nothing else changed", async () => {
    const remote = cloud();
    const phone = remote.device();
    await write(phone, "a.md", "A");
    await phone.sync();
    expect((await phone.read()).pulledRevision).toBe(1);
    await write(phone, "a.md", "A edited");
    const saved = await phone.sync();
    expect(saved.pulledRevision).toBe(2);
    remote.requests.length = 0;
    await phone.sync();
    expect(remote.requests).toEqual(["changes:2"]);
  });

  test("a commit that landed after another device's change still picks that change up", async () => {
    const remote = cloud();
    const laptop = remote.device();
    const phone = remote.device();
    await write(laptop, "shared.md", "Shared");
    await laptop.sync();
    await phone.sync();
    // The laptop commits between the phone's read of the cloud and its own commit.
    const racing = new VaultSync(store(await phone.read()), { ...remote.transport, async commit(changes) {
      await write(laptop, "laptop.md", "From the laptop");
      await laptop.sync();
      return remote.transport.commit(changes);
    } });
    await write(racing, "phone.md", "From the phone");
    const saved = await racing.sync();
    expect(saved.pulledRevision).toBe(1);
    const caught = await racing.sync();
    expect(caught.files["laptop.md"].content).toBe("From the laptop");
    expect(caught.pulledRevision).toBe(3);
    expect(pendingVaultChanges(caught)).toEqual([]);
  });

  test("conflicting edits still merge, and a rejected commit rereads the whole cloud", async () => {
    const remote = cloud();
    const laptop = remote.device();
    const phone = remote.device();
    await write(laptop, "plan.md", "Owner: Alice\n\nDate: Monday\n");
    await laptop.sync();
    await phone.sync();
    await write(laptop, "plan.md", "Owner: Bob\n\nDate: Monday\n");
    await laptop.sync();
    let rejected = false;
    const racing = new VaultSync(store(await phone.read()), { ...remote.transport, async commit(changes) {
      if (!rejected) { rejected = true; throw Object.assign(new Error("Conflict"), { statusCode: 409 }); }
      return remote.transport.commit(changes);
    } });
    await write(racing, "plan.md", "Owner: Alice\n\nDate: Tuesday\n");
    remote.requests.length = 0;
    const merged = await racing.sync();
    expect(merged.files["plan.md"].content).toBe("Owner: Bob\n\nDate: Tuesday\n");
    expect(remote.requests[0]).toBe("changes:1");
    expect(remote.requests).toContain("manifest");
  });

  test("an older server without change tracking gets the complete manifest", async () => {
    const remote = cloud();
    const device = new VaultSync(store(), { ...remote.transport, async changes() {
      throw Object.assign(new Error("Not found"), { statusCode: 404 });
    } });
    await write(device, "a.md", "A");
    await device.sync();
    remote.requests.length = 0;
    await device.sync();
    expect(remote.requests).toEqual(["manifest"]);
  });

  test("documents opened from the cloud download through a delta sync", async () => {
    const remote = cloud();
    const laptop = remote.device();
    await write(laptop, "one.md", "One");
    await write(laptop, "two.md", "Two");
    await laptop.sync();
    const phone = remote.device();
    expect(await phone.deferFresh(await remote.transport.manifest(), new Set())).toBe(true);
    await phone.sync();
    expect(Object.keys((await phone.read()).deferred ?? {}).sort()).toEqual(["one.md", "two.md"]);

    await write(laptop, "two.md", "Two, edited");
    await laptop.sync();
    remote.requests.length = 0; remote.downloaded.length = 0;
    const requested = await phone.hydrate(["two.md"]);
    expect(requested.deferred?.["two.md"].requested).toBe(true);
    const opened = await phone.sync();
    expect(remote.requests).toEqual(["changes:1"]);
    expect(remote.downloaded).toEqual(["two.md"]);
    expect(opened.files["two.md"].content).toBe("Two, edited");
    expect(Object.keys(opened.deferred ?? {})).toEqual(["one.md"]);
  });
});
