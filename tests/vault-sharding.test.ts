import { describe, expect, test } from "bun:test";
import { createVaultService } from "../server/vault/index.mjs";
import { digest } from "../server/vault/storage.mjs";

function memoryStorage() {
  const objects = new Map<string, Buffer>();
  const reads: string[] = [];
  const writes: string[] = [];
  return {
    kind: "memory", objects, reads, writes,
    async read(key: string) { reads.push(key); const bytes = objects.get(key); return bytes ? { bytes: Buffer.from(bytes), etag: digest(bytes) } : null; },
    async putImmutable(key: string, bytes: Buffer) {
      writes.push(key);
      if (objects.has(key) && !objects.get(key)!.equals(bytes)) throw new Error("Immutable object changed");
      objects.set(key, Buffer.from(bytes));
    },
    async compareAndSwap(key: string, bytes: Buffer, expected: string | null) {
      writes.push(key);
      if ((objects.has(key) ? digest(objects.get(key)!) : null) !== expected) return false;
      objects.set(key, Buffer.from(bytes)); return true;
    },
  };
}

const rootKey = (user: string) => `vaults/v1/${digest(user)}/manifest.json`;
const kinds = (keys: string[]) => keys.map((key) => key.split("/")[3]);

async function fill(vault: ReturnType<typeof createVaultService>, user: string, count: number) {
  for (let start = 0; start < count; start += 1000) {
    await vault.commit(user, Array.from({ length: Math.min(1000, count - start) }, (_, i) => ({
      path: `Notes/${start + i}.md`, content: `# Note ${start + i}\n`, baseRevision: null })), { acknowledge: true });
  }
}

describe("sharded cloud file list", () => {
  test("a save rewrites one shard and a small root, not the whole list", async () => {
    const storage = memoryStorage();
    await fill(createVaultService({ storage }), "alice", 3000);
    const root = JSON.parse(storage.objects.get(rootKey("alice"))!.toString());
    expect(root).toMatchObject({ schemaVersion: 2, revision: 3, count: 3000 });
    expect(Object.keys(root.shards)).toHaveLength(256);

    // A cold server instance reads the root and only the shard holding the file.
    storage.reads.length = 0;
    storage.writes.length = 0;
    const vault = createVaultService({ storage });
    const current = (await vault.readFile({ userId: "alice", path: "Notes/7.md" })).revision;
    const saved = await vault.commit("alice", [{ path: "Notes/7.md", content: "# Edited\n", baseRevision: current }], { acknowledge: true });
    expect(Object.keys(saved.manifest.files)).toEqual(["Notes/7.md"]);
    expect(kinds(storage.reads).filter((kind) => kind === "shards")).toHaveLength(1);
    expect(kinds(storage.writes).sort()).toEqual(["files", "history", "manifest.json", "shards"]);
    expect(storage.objects.get(rootKey("alice"))!.length).toBeLessThan(32 * 1024);

    const next = JSON.parse(storage.objects.get(rootKey("alice"))!.toString());
    const changed = Object.keys(next.shards).filter((id) => next.shards[id].digest !== root.shards[id].digest);
    expect(changed).toEqual([digest("Notes/7.md").slice(0, 2)]);
    expect(next.shards[changed[0]].changedAt).toBe(4);
  });

  test("a vault grows past the old 10,000-file limit", async () => {
    const storage = memoryStorage();
    const vault = createVaultService({ storage });
    await fill(vault, "alice", 10_500);
    const status = await vault.status("alice");
    expect(status.manifest.revision).toBe(11);
    expect(Object.keys(status.manifest.files)).toHaveLength(10_500);
    expect(new TextDecoder().decode((await vault.readFile({ userId: "alice", path: "Notes/10499.md" })).bytes)).toBe("# Note 10499\n");
  }, 30_000);

  test("changes since a revision read only the shards that changed", async () => {
    const storage = memoryStorage();
    await fill(createVaultService({ storage }), "alice", 2000);
    const vault = createVaultService({ storage });
    await vault.commit("alice", [{ path: "Late.md", content: "Late", baseRevision: null }]);
    storage.reads.length = 0;
    const cold = createVaultService({ storage });
    const changes = await cold.changes("alice", 2);
    expect(Object.keys(changes.files)).toEqual(["Late.md"]);
    expect(kinds(storage.reads).filter((kind) => kind === "shards")).toHaveLength(1);
    storage.reads.length = 0;
    expect((await cold.changes("alice", 3)).files).toEqual({});
    expect(kinds(storage.reads)).toEqual(["manifest.json"]);
  });

  test("a single file list from before sharding is read, then split on the next save", async () => {
    const storage = memoryStorage();
    const vault = createVaultService({ storage });
    await vault.commit("alice", [{ path: "Old.md", content: "Old", baseRevision: null }, { path: "Kept.md", content: "Kept", baseRevision: null }]);
    const legacy = structuredClone((await vault.snapshot("alice")).manifest);
    legacy.revision = 9;
    for (const entry of Object.values<any>(legacy.files)) delete entry.changedAt;
    storage.objects.set(rootKey("alice"), Buffer.from(JSON.stringify(legacy)));

    const reader = createVaultService({ storage });
    expect((await reader.status("alice")).manifest).toEqual(legacy);
    expect(new TextDecoder().decode((await reader.readFile({ userId: "alice", path: "Old.md" })).bytes)).toBe("Old");
    expect(Object.keys((await reader.changes("alice", 8)).files).sort()).toEqual(["Kept.md", "Old.md"]);

    await reader.commit("alice", [{ path: "Old.md", content: "New", baseRevision: legacy.files["Old.md"].revision }]);
    const root = JSON.parse(storage.objects.get(rootKey("alice"))!.toString());
    expect(root).toMatchObject({ schemaVersion: 2, revision: 10, count: 2 });
    const manifest = (await createVaultService({ storage }).status("alice")).manifest;
    expect(manifest.files["Kept.md"]).toEqual({ ...legacy.files["Kept.md"], changedAt: 9 });
    expect(manifest.files["Old.md"].changedAt).toBe(10);
    expect(Object.keys((await reader.changes("alice", 9)).files)).toEqual(["Old.md"]);
  });

  test("a conflict reports only the conflicting files", async () => {
    const vault = createVaultService({ storage: memoryStorage() });
    await fill(vault, "alice", 1500);
    const error: any = await vault.commit("alice", [{ path: "Notes/3.md", content: "Stale", baseRevision: "b".repeat(64) }]).catch((caught) => caught);
    expect(error.statusCode).toBe(409);
    expect(error.conflicts).toEqual(["Notes/3.md"]);
    expect(Object.keys(error.manifest.files)).toEqual(["Notes/3.md"]);
    expect(error.manifest.revision).toBe(2);
  });

  test("a shard that does not match its digest is refused", async () => {
    const storage = memoryStorage();
    await fill(createVaultService({ storage }), "alice", 10);
    const root = JSON.parse(storage.objects.get(rootKey("alice"))!.toString());
    const id = digest("Notes/1.md").slice(0, 2);
    const key = `vaults/v1/${digest("alice")}/shards/${root.shards[id].digest}.json`;
    const shard = JSON.parse(storage.objects.get(key)!.toString());
    shard.files["Notes/1.md"].revision = "c".repeat(64);
    storage.objects.set(key, Buffer.from(JSON.stringify(shard)));
    await expect(createVaultService({ storage }).readFile({ userId: "alice", path: "Notes/1.md" })).rejects.toThrow("does not match its digest");
  });

  test("cached shards cannot be altered through a returned file list", async () => {
    const vault = createVaultService({ storage: memoryStorage() });
    await fill(vault, "alice", 5);
    const { manifest } = await vault.status("alice");
    expect(() => { manifest.files["Notes/1.md"].revision = "d".repeat(64); }).toThrow();
    expect((await vault.status("alice")).manifest.files["Notes/1.md"].revision).not.toBe("d".repeat(64));
  });
});
