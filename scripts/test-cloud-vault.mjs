/**
 * Opt-in integration test against the configured PRIVATE Vercel Blob store.
 * Run with Bun and BLOB_STORE_ID + VERCEL_OIDC_TOKEN, or BLOB_READ_WRITE_TOKEN.
 * Uses a unique disposable prefix, never accesses application users or Postgres,
 * and removes only this run's objects in finally. Not part of `bun test`.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import * as blob from "@vercel/blob";
import { createBlobVaultStorage } from "../server/vault/storage.mjs";
import { createVaultService } from "../server/vault/index.mjs";
import { VaultSync, pendingVaultChanges } from "../client/src/lib/vaultSync.ts";

export async function runCloudVaultTest(log = console.log) {
  if (!process.env.BLOB_STORE_ID && !process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error("Configure a private Blob store before running this opt-in cloud test.");
  }
  const options = process.env.BLOB_STORE_ID ? { storeId: process.env.BLOB_STORE_ID } : { token: process.env.BLOB_READ_WRITE_TOKEN };
  const prefix = `activation-tests/${randomUUID()}/`;
  const written = new Set();
  const storage = createBlobVaultStorage(process.env);
  const scoped = {
    kind: "blob",
    read: (key) => storage.read(prefix + key),
    putImmutable: (key, bytes, type) => {
      written.add(prefix + key);
      return storage.putImmutable(prefix + key, bytes, type);
    },
    compareAndSwap: (key, bytes, etag) => {
      written.add(prefix + key);
      return storage.compareAndSwap(prefix + key, bytes, etag);
    },
  };
  const server = createVaultService({ storage: scoped, env: {} });
  const userId = "disposable-cloud-test";
  const normalize = (manifest) => ({ ...manifest, files: Object.fromEntries(Object.entries(manifest.files).map(([path, entry]) => [path, {
    ...entry, encoding: entry.encoding === "base64" ? "base64" : undefined,
  }])) });
  const transport = {
    manifest: async () => normalize((await server.status(userId)).manifest),
    read: async (path, entry) => {
      const { bytes } = await server.readFile({ userId, path, revision: entry.revision });
      return { content: bytes.toString(entry.encoding === "base64" ? "base64" : "utf8"), encoding: entry.encoding, contentType: entry.contentType };
    },
    commit: async (changes) => normalize((await server.commit(userId, changes)).manifest),
  };
  function device() {
    let snapshot = null;
    let tail = Promise.resolve();
    return new VaultSync({
      read: async () => structuredClone(snapshot),
      write: async (next) => { snapshot = structuredClone(next); },
      lock(operation) { const pending = tail.then(operation); tail = pending.catch(() => {}); return pending; },
    }, transport);
  }
  async function edit(client, path, content) {
    const expected = (await client.read()).files;
    const next = { ...expected };
    if (content === null) delete next[path]; else next[path] = { content };
    return client.edit(next, expected);
  }
  const checks = [];
  function passed(name) { checks.push(name); log(`PASS: ${name}`); }
  log(`Disposable test prefix: ${prefix}`);
  try {
    const computer = device();
    const phone = device();
    await edit(computer, "Notes/shared.md", "# Shared\n\nOriginal Markdown — café.");
    await edit(computer, "Notes/other.md", "# Other\n\nIndependent note.");
    await computer.sync();
    const originalRevision = (await transport.manifest()).files["Notes/shared.md"].revision;
    await phone.sync();
    assert.equal((await phone.read()).files["Notes/shared.md"].content, "# Shared\n\nOriginal Markdown — café.");
    passed("private Blob upload and exact Markdown download on a second device");
  
    await edit(computer, "Notes/shared.md", "Computer offline edit");
    await edit(phone, "Notes/other.md", "Phone offline edit");
    await computer.sync(); await phone.sync(); await computer.sync();
    assert.equal((await computer.read()).files["Notes/other.md"].content, "Phone offline edit");
    assert.equal((await phone.read()).files["Notes/shared.md"].content, "Computer offline edit");
    passed("independent offline edits converge through real cloud storage");
  
    await edit(computer, "Notes/shared.md", "New computer version");
    await edit(phone, "Notes/shared.md", "New phone version");
    await computer.sync();
    const conflicted = await phone.sync();
    assert.equal(conflicted.conflicts.length, 1);
    assert.equal(conflicted.conflicts[0].local.content, "New phone version");
    assert.equal(conflicted.files["Notes/shared.md"].content, "New computer version");
    await phone.resolve(conflicted.conflicts[0].id, "local");
    await phone.sync(); await computer.sync();
    assert.equal((await computer.read()).files["Notes/shared.md"].content, "New phone version");
    assert.equal(pendingVaultChanges(await phone.read()).length, 0);
    passed("same-file conflicts preserve both versions and resolve across devices");
  
    await assert.rejects(server.commit(userId, [{ path: "Notes/shared.md", baseRevision: originalRevision, content: "Stale overwrite" }]), (error) => error.statusCode === 409);
    assert.equal((await server.readFile({ userId, path: "Notes/shared.md", revision: originalRevision })).bytes.toString(), "# Shared\n\nOriginal Markdown — café.");
    passed("stale writes are rejected and immutable history remains readable");
  
    await Promise.all([
      server.commit(userId, [{ path: "Notes/race-a.md", baseRevision: null, content: "Concurrent A" }]),
      server.commit(userId, [{ path: "Notes/race-b.md", baseRevision: null, content: "Concurrent B" }]),
    ]);
    const raced = await transport.manifest();
    assert.ok(raced.files["Notes/race-a.md"] && raced.files["Notes/race-b.md"]);
    passed("conditional cloud manifest writes preserve concurrent commits");
  
    await edit(computer, "Notes/other.md", null); await computer.sync(); await phone.sync();
    assert.equal((await phone.read()).files["Notes/other.md"], undefined);
    assert.equal((await transport.manifest()).files["Notes/other.md"].deleted, true);
    passed("deletions propagate with tombstones");
  
    const binary = Buffer.from([0, 255, 1, 128, 13, 10]);
    await server.commitBinary(userId, { path: "Attachments/test/original.bin", baseRevision: null, bytes: binary, contentType: "application/octet-stream" });
    assert.deepEqual((await server.readFile({ userId, path: "Attachments/test/original.bin" })).bytes, binary);
    passed("binary originals round-trip without corruption");
  
    const objects = await blob.list({ ...options, prefix, limit: 1000 });
    assert.ok(objects.blobs.length > 0);
    const anonymous = await fetch(objects.blobs[0].url, { signal: AbortSignal.timeout(15000) });
    assert.ok(!anonymous.ok, "Private content was readable without authentication");
    passed("unauthenticated access to private files is denied");
  } finally {
    if (written.size) await blob.del([...written], options);
    const remaining = await blob.list({ ...options, prefix, limit: 1 });
    assert.equal(remaining.blobs.length, 0, `Test cleanup incomplete: ${prefix}`);
    log("CLEANUP: all disposable test objects removed");
  }
  return { success: true, checks: checks.length, prefix };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await runCloudVaultTest()));
}
