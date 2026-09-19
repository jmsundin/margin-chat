import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createVaultService, validateVaultPath } from "../server/vault/index.mjs";
import { digest } from "../server/vault/storage.mjs";
import { createDocumentService } from "../server/documents/index.mjs";
import { createCaptureTestDatabase } from "./helpers/captureDatabase.mjs";
import { writeState } from "../server/db/repository.mjs";
import { normalizeAppState } from "../server/db/validation.mjs";
import { deleteDocument, getVaultAttachment } from "../server/db/documentRepository.mjs";
import { createEmptyState } from "../client/src/initialState";
import { createMarkdownWorkspace } from "@margin-chat/workspace-contracts/markdown";
import { validVaultPath } from "../client/src/lib/vaultTypes";

function memoryStorage() {
  const objects = new Map<string, Buffer>();
  const reads: string[] = [];
  const writes: string[] = [];
  return {
    kind: "memory", objects, reads, writes,
    async read(key: string) {
      reads.push(key);
      const bytes = objects.get(key);
      return bytes ? { bytes: Buffer.from(bytes), etag: digest(bytes) } : null;
    },
    async putImmutable(key: string, bytes: Buffer) {
      writes.push(key);
      const existing = objects.get(key);
      if (existing && !existing.equals(bytes)) throw new Error("Immutable body changed");
      objects.set(key, Buffer.from(bytes));
    },
    async compareAndSwap(key: string, bytes: Buffer, expected: string | null) {
      if ((objects.has(key) ? digest(objects.get(key)) : null) !== expected) return false;
      writes.push(key);
      objects.set(key, Buffer.from(bytes));
      return true;
    },
  };
}

describe("vault persistence regression coverage", () => {
  test("paths reject unpaired surrogate escapes while preserving ordinary Unicode and emoji", () => {
    for (const path of ["Notes/\ud800.md", "Notes/\udc00.md"]) {
      expect(() => validateVaultPath(path)).toThrow();
      expect(validVaultPath(path)).toBe(false);
    }
    for (const path of ["Notes/界.md", "Notes/🌎.md"]) {
      expect(validateVaultPath(path)).toBe(path);
      expect(validVaultPath(path)).toBe(true);
    }
  });
  test("both upload paths preserve the full permitted 4 MiB original in Node", () => {
    const serviceUrl = new URL("../server/vault/index.mjs", import.meta.url).href;
    const storageUrl = new URL("../server/vault/storage.mjs", import.meta.url).href;
    const output = execFileSync("node", ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import { createVaultService } from ${JSON.stringify(serviceUrl)};
      import { digest } from ${JSON.stringify(storageUrl)};
      const objects = new Map();
      const storage = {
        kind: 'memory',
        async read(key) { const bytes = objects.get(key); return bytes ? {bytes, etag:digest(bytes)} : null; },
        async putImmutable(key,bytes) { objects.set(key,bytes); },
        async compareAndSwap(key,bytes,expected) {
          if ((objects.has(key) ? digest(objects.get(key)) : null) !== expected) return false;
          objects.set(key,bytes); return true;
        }
      };
      const vault = createVaultService({storage});
      const bytes = Buffer.alloc(4 * 1024 * 1024, 0xab);
      await vault.persistAttachment({userId:'owner',attachment:{id:'large',filename:'large.bin'},bytes});
      assert.deepEqual((await vault.readAttachment({userId:'owner',documentId:'large'})).bytes,bytes);
      await vault.commitBinary('owner',{path:'another.bin',baseRevision:null,bytes,contentType:'application/octet-stream'});
      assert.deepEqual((await vault.readFile({userId:'owner',path:'another.bin'})).bytes,bytes);
      console.log('exact original bytes preserved');
    `], { encoding: "utf8", timeout: 15_000 });
    expect(output.trim()).toBe("exact original bytes preserved");
  });

  test("base64 validation still rejects invalid padding and characters", async () => {
    const vault = createVaultService({ storage: memoryStorage() });
    for (const content of ["A", "AAAA=", "A===", "=AAA", "AA=A", "AA A", "AA\nA", "!!!!"]) {
      await expect(vault.commit("owner", [{ path: "invalid.bin", baseRevision: null, content, encoding: "base64" }]))
        .rejects.toMatchObject({ statusCode: 400 });
    }
    for (const content of ["", "AA==", "AAA=", "AAAA"]) {
      await vault.commit("owner", [{ path: `valid-${content.length}-${content.indexOf("=")}.bin`, baseRevision: null, content, encoding: "base64" }]);
    }
  });

  test("oversized manifests are rejected before writing bodies or publishing a revision", async () => {
    const storage = memoryStorage();
    const key = `vaults/v1/${digest("owner")}/manifest.json`;
    const entry = { revision: "a".repeat(64), deleted: false, encoding: "utf8", contentType: "application/octet-stream", size: 1 };
    const files = Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`${"p".repeat(480)}/${i}.bin`, entry]));
    const before = Buffer.from(JSON.stringify({ schemaVersion: 1, revision: 1, files }));
    expect(before.length).toBeLessThan(2 * 1024 * 1024);
    storage.objects.set(key, before);
    const vault = createVaultService({ storage });
    const changes = Array.from({ length: 1000 }, (_, i) => ({ path: `${"q".repeat(480)}/${i}.bin`, baseRevision: null, content: "x" }));
    await expect(vault.commit("owner", changes)).rejects.toMatchObject({ statusCode: 413 });
    expect(storage.writes).toEqual([]);
    expect(storage.objects.get(key)).toEqual(before);
    expect((await vault.status("owner")).manifest.revision).toBe(1);
    try {
      await vault.commit("owner", changes.map((change) => ({ ...change, path: change.path.replaceAll("q", "界"), baseRevision: "b".repeat(64) })));
      throw new Error("Expected conflict");
    } catch (error: any) {
      expect(error.statusCode).toBe(409);
      expect(error.conflicts).toHaveLength(1000);
      const response = JSON.stringify({ error: error.message, conflicts: error.conflicts, manifest: error.manifest });
      expect(Buffer.byteLength(response)).toBeLessThan(4_500_000);
    }
  });

  test("note edits skip unchanged originals while replacements and forced rebuilds reload them", async () => {
    const storage = memoryStorage();
    let checkpoint: any = null;
    let projected: any[] = [];
    const database = {
      getVaultProjectionCheckpoint: async () => checkpoint,
      async projectVaultState(_user: string, _state: unknown, revision: number, options: any) {
        projected = options.attachments;
        checkpoint = { revision, attachments: options.attachmentRevisions };
      },
    };
    const vault = createVaultService({ storage, database });
    for (let i = 0; i < 3; i++) {
      await vault.persistAttachment({ userId: "owner", attachment: { id: `doc-${i}`, filename: "source.bin" }, bytes: Buffer.alloc(1024 * 1024, i) });
    }
    await vault.status("owner");
    expect(projected).toHaveLength(3);
    const originalBodyKeys = new Set([...storage.objects].filter(([, bytes]) => bytes.length === 1024 * 1024).map(([key]) => key));
    storage.reads.length = 0;
    await vault.commit("owner", [{ path: "note.md", baseRevision: null, content: "# Tiny note" }]);
    expect(projected).toEqual([]);
    expect(storage.reads.filter((key) => originalBodyKeys.has(key))).toEqual([]);
    const { manifest } = await vault.snapshot("owner");
    const path = "Attachments/doc-0/source.bin";
    await vault.commitBinary("owner", { path, baseRevision: manifest.files[path].revision, bytes: Buffer.from("replacement"), contentType: "application/octet-stream" });
    expect(projected).toHaveLength(1);
    expect(projected[0].bytes.toString()).toBe("replacement");
    await vault.rebuild("owner");
    expect(projected).toHaveLength(3);
  });

  test("a completed cloud deletion cannot erase a newer restoration from the database", async () => {
    const fixture = await createCaptureTestDatabase();
    try {
      const userId = crypto.randomUUID();
      await fixture.client.query("insert into marginchat_users (id,email,password_hash,display_name) values ($1,$2,'unused','Test')", [userId, `${userId}@example.test`]);
      const database = {
        projectVaultState: (id: string, state: any, revision: number, options: any) => writeState(fixture.client, id, state === null ? null : normalizeAppState(state), {
          vaultRevision: revision, vaultAttachments: options.attachments, deletedVaultAttachmentIds: options.deletedAttachmentIds,
          attachmentRevisions: options.attachmentRevisions, forceVaultProjection: options.force,
        }),
        getVaultProjectionRevision: async (id: string) => Number((await fixture.client.query("select vault_revision from marginchat_vault_projections where user_id=$1", [id])).rows[0]?.vault_revision ?? -1),
        deleteDocument: (args: any) => deleteDocument(fixture.client, args),
      };
      const vault = createVaultService({ storage: memoryStorage(), database });
      const attachment = { id: "restored", filename: "source.txt", mimeType: "text/plain" };
      await vault.persistAttachment({ userId, attachment, bytes: Buffer.from("original") });
      const state = createEmptyState();
      state.conversations[state.rootId].documents = [{ ...attachment, sizeBytes: 8, createdAt: new Date().toISOString(), status: "processing", error: null }];
      const workspace = createMarkdownWorkspace(state);
      await vault.commit(userId, Object.entries(workspace.files).map(([path, content]) => ({ path, content, baseRevision: null })));
      const before = (await vault.snapshot(userId)).manifest;
      const service = createDocumentService({ database, env: {}, vaultService: { ...vault,
        async deleteAttachment(args: any) {
          const removed = await vault.deleteAttachment(args);
          expect(await getVaultAttachment(fixture.client, { userId, documentId: attachment.id })).toBeNull();
          const deleted = (await vault.snapshot(userId)).manifest;
          const changes = await Promise.all(Object.entries(before.files).map(async ([path, entry]: [string, any]) => ({
            path, baseRevision: deleted.files[path].revision, encoding: entry.encoding, contentType: entry.contentType,
            content: (await vault.readFile({ userId, path, revision: entry.revision })).bytes.toString(entry.encoding),
          })));
          await vault.commit(userId, changes);
          return removed;
        },
      } });
      expect(await service.delete(attachment.id, userId)).toBe(true);
      expect((await vault.status(userId)).projection.status).toBe("ready");
      expect((await getVaultAttachment(fixture.client, { userId, documentId: attachment.id })).bytes.toString()).toBe("original");
    } finally { await fixture.pg.close(); }
  }, 30_000);

  test("failed deletion projections report a retryable error and retry the same tombstone", async () => {
    const fixture = await createCaptureTestDatabase();
    const originalError = console.error;
    try {
      const userId = crypto.randomUUID();
      await fixture.client.query("insert into marginchat_users (id,email,password_hash,display_name) values ($1,$2,'unused','Test')", [userId, `${userId}@example.test`]);
      let unavailable = false;
      const database = {
        async projectVaultState(id: string, state: any, revision: number, options: any) {
          if (unavailable) throw new Error("Simulated temporary database outage");
          return writeState(fixture.client, id, state === null ? null : normalizeAppState(state), {
            vaultRevision: revision, vaultAttachments: options.attachments, deletedVaultAttachmentIds: options.deletedAttachmentIds,
            attachmentRevisions: options.attachmentRevisions,
          });
        },
        getVaultProjectionRevision: async (id: string) => Number((await fixture.client.query("select vault_revision from marginchat_vault_projections where user_id=$1", [id])).rows[0]?.vault_revision ?? -1),
      };
      const vault = createVaultService({ storage: memoryStorage(), database });
      await vault.persistAttachment({ userId, attachment: { id: "retry-delete", filename: "source.txt" }, bytes: Buffer.from("original") });
      await vault.status(userId);
      unavailable = true;
      console.error = () => undefined;
      await expect(vault.deleteAttachment({ userId, documentId: "retry-delete" })).rejects.toMatchObject({ statusCode: 503 });
      expect((await getVaultAttachment(fixture.client, { userId, documentId: "retry-delete" })).bytes.toString()).toBe("original");
      await expect(vault.readAttachment({ userId, documentId: "retry-delete" })).rejects.toMatchObject({ statusCode: 404 });
      unavailable = false;
      expect(await vault.deleteAttachment({ userId, documentId: "retry-delete" })).toBe(true);
      expect(await getVaultAttachment(fixture.client, { userId, documentId: "retry-delete" })).toBeNull();
      expect((await vault.status(userId)).projection.status).toBe("ready");
    } finally { console.error = originalError; await fixture.pg.close(); }
  }, 30_000);
});
