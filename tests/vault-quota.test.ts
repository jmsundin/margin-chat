import { expect, test } from "bun:test";
import { createVaultService, vaultQuotaFor } from "../server/vault/index.mjs";
import { digest } from "../server/vault/storage.mjs";

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

const text = (path: string, length: number, baseRevision: string | null = null) => ({ path, content: "x".repeat(length), baseRevision });

test("a full vault refuses growth but still accepts deletes and smaller edits", async () => {
  const vault = createVaultService({ storage: memoryStorage(), env: { VAULT_QUOTA_BYTES: "1000" } });
  const user = "quota-user";
  const first = await vault.commit(user, [text("a.md", 600)]);
  const a = first.manifest.files["a.md"].revision;

  const refused = vault.commit(user, [text("b.md", 500)]);
  await expect(refused).rejects.toMatchObject({ statusCode: 413, name: "VaultFullError" });
  await expect(vault.commit(user, [text("b.md", 500)])).rejects.toThrow("Your cloud vault is full");

  // Room left: 400 bytes.
  const second = await vault.commit(user, [text("b.md", 300)]);
  const b = second.manifest.files["b.md"].revision;
  expect((await vault.status(user)).usage).toEqual({ bytes: 900, quotaBytes: 1000 });

  // Shrinking a file works even near the limit; deleting frees space.
  const shrunk = await vault.commit(user, [text("a.md", 100, a)]);
  await vault.commit(user, [{ path: "b.md", content: null, baseRevision: b }]);
  expect((await vault.status(user)).usage.bytes).toBe(100);
  expect(shrunk.manifest.files["a.md"].size).toBe(100);
  await vault.commit(user, [text("c.md", 850)]);
});

test("admins have no limit, and an older root learns its size on the next save", async () => {
  const storage = memoryStorage();
  const vault = createVaultService({ storage, env: { VAULT_QUOTA_BYTES: "100" } });
  const unlimited = vaultQuotaFor({ role: "admin" });
  expect(unlimited).toBeNull();
  expect(vaultQuotaFor({ role: "member" })).toBeUndefined();
  await vault.commit("admin-user", [text("big.md", 5000)], { quotaBytes: unlimited });
  expect((await vault.status("admin-user", { quotaBytes: unlimited })).usage).toEqual({ bytes: 5000, quotaBytes: null });

  // Strip the per-shard sizes, as roots written before quotas have none.
  const key = `vaults/v1/${digest("admin-user")}/manifest.json`;
  const root = JSON.parse(storage.objects.get(key)!.toString("utf8"));
  for (const shard of Object.values(root.shards) as any[]) delete shard.bytes;
  delete root.bytes;
  storage.objects.set(key, Buffer.from(JSON.stringify(root)));

  await expect(vault.commit("admin-user", [text("more.md", 10)])).rejects.toMatchObject({ statusCode: 413 });
  const saved = await vault.commit("admin-user", [text("more.md", 10)], { quotaBytes: null });
  expect(saved.manifest.revision).toBe(2);
  const updated = JSON.parse(storage.objects.get(key)!.toString("utf8"));
  expect(updated.bytes).toBe(5010);
});
