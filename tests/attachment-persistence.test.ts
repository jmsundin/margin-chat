import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { createCaptureTestDatabase } from "./helpers/captureDatabase.mjs";
import { createEmptyState } from "../client/src/initialState";
import { normalizeAppState } from "../server/db/validation.mjs";
import { readState, readVaultProjectionCheckpoint, readWorkspace, writeState } from "../server/db/repository.mjs";
import { loadMigrations, migrateDatabase } from "../server/db/migrations.mjs";
import { createVaultService } from "../server/vault/index.mjs";
import { digest } from "../server/vault/storage.mjs";
import {
  completeDocument, createDocument, deleteDocument, failDocument,
  findRelevantDocumentChunks, getVaultAttachment, listVaultAttachments, restoreVaultAttachment,
} from "../server/db/documentRepository.mjs";

const createdAt = "2026-09-19T12:00:00.000Z";
const embedding = [1, ...Array(1535).fill(0)];
const attachment = (id: string) => ({ id, filename: "shared.txt", mimeType: "text/plain", createdAt, sizeBytes: 5, status: "ready" });
const revisions = (version: string) => ({
  "Attachments/shared/metadata.json": { metadataRevision: `metadata-${version}`, bodyPath: "Attachments/shared/shared.txt", bodyRevision: `body-${version}` },
});

function workspace(documentId?: string) {
  const state = createEmptyState();
  if (documentId) state.conversations[state.rootId].documents = [attachment(documentId)];
  return normalizeAppState(state);
}

describe("portable attachment database identities", () => {
  let fixture: Awaited<ReturnType<typeof createCaptureTestDatabase>>;
  beforeAll(async () => { fixture = await createCaptureTestDatabase(); }, 30_000);
  afterAll(async () => { await fixture?.pg.close(); });

  async function user() {
    const id = crypto.randomUUID();
    await fixture.client.query("insert into marginchat_users (id,email,password_hash,display_name) values ($1,$2,'unused','Attachment test')", [id, `${id}@example.test`]);
    return id;
  }

  async function index(userId: string, documentId: string, content: string) {
    return completeDocument(fixture.client, {
      userId, documentId, embeddingModel: "fixture-model", sourceBytes: Buffer.from(content),
      chunks: [{ index: 0, pageNumber: null, content, tokenCount: 1, embedding }],
    });
  }

  test("importing another account's unchanged vault files projects successfully", async () => {
    const source = await user();
    const target = await user();
    const objects = new Map<string, Buffer>();
    const storage = {
      kind: "memory",
      async read(key: string) { const bytes = objects.get(key); return bytes ? { bytes, etag: digest(bytes) } : null; },
      async putImmutable(key: string, bytes: Buffer) { objects.set(key, Buffer.from(bytes)); },
      async compareAndSwap(key: string, bytes: Buffer, expected: string | null) {
        if ((objects.has(key) ? digest(objects.get(key)) : null) !== expected) return false;
        objects.set(key, Buffer.from(bytes)); return true;
      },
    };
    const database = {
      loadWorkspace: (owner: string) => readWorkspace(fixture.client, owner),
      listVaultAttachments: (owner: string) => listVaultAttachments(fixture.client, owner),
      getVaultProjectionCheckpoint: (owner: string) => readVaultProjectionCheckpoint(fixture.client, owner),
      projectVaultState: (owner: string, state: any, revision: number, options: any) => writeState(fixture.client, owner, state === null ? null : normalizeAppState(state), {
        vaultRevision: revision, forceVaultProjection: options.force, vaultAttachments: options.attachments,
        deletedVaultAttachmentIds: options.deletedAttachmentIds, attachmentRevisions: options.attachmentRevisions,
        expectedVaultProjectionRevision: options.expectedProjectionRevision,
      }),
    };
    const service = createVaultService({ storage, database });
    await service.persistAttachment({ userId: source, attachment: attachment("imported"), bytes: Buffer.from("copy me") });
    const saved = await service.status(source);
    expect(saved.projection.status).toBe("ready");
    const changes = await Promise.all(Object.entries(saved.manifest.files).map(async ([path, entry]: [string, any]) => ({
      path, content: (await service.readFile({ userId: source, path })).bytes.toString(entry.encoding === "base64" ? "base64" : "utf8"),
      encoding: entry.encoding, contentType: entry.contentType, baseRevision: null,
    })));
    expect((await service.commit(target, changes)).projection.status).toBe("ready");
    expect((await service.rebuild(target)).projection.status).toBe("ready");
    for (const owner of [source, target]) {
      expect((await getVaultAttachment(fixture.client, { userId: owner, documentId: "imported" })).bytes.toString()).toBe("copy me");
    }
  });

  test("copies the same portable ID across owners without mixing originals, links, or search chunks", async () => {
    const first = await user();
    const second = await user();
    const outsider = await user();
    const id = "shared";
    const left = Buffer.from("first");
    const right = Buffer.from("other");
    await restoreVaultAttachment(fixture.client, { userId: first, attachment: attachment(id), bytes: left });
    await createDocument(fixture.client, { userId: second, ...attachment(id), bytes: right });
    expect((await index(first, id, "first"))?.id).toBe(id);
    expect((await index(second, id, "other"))?.id).toBe(id);
    for (const owner of [first, second]) {
      await writeState(fixture.client, owner, workspace(id), { vaultRevision: 1 });
      const saved = await readState(fixture.client, owner);
      expect(saved.conversations[saved.rootId].documents.map((item: any) => item.id)).toEqual([id]);
      expect((await listVaultAttachments(fixture.client, owner))[0].id).toBe(id);
      const chunks = await findRelevantDocumentChunks(fixture.client, { userId: owner, documentIds: [id], embedding, limit: 8 });
      expect(chunks.map((item: any) => ({ id: item.documentId, content: item.content })))
        .toEqual([{ id, content: owner === first ? "first" : "other" }]);
    }
    expect(await getVaultAttachment(fixture.client, { userId: outsider, documentId: id })).toBeNull();
    expect(await completeDocument(fixture.client, { userId: outsider, documentId: id, chunks: [] })).toBeNull();
    expect(await deleteDocument(fixture.client, { userId: outsider, documentId: id })).toBe(false);
    await failDocument(fixture.client, { userId: first, documentId: id, error: "retry", sourceBytes: left });
    expect((await getVaultAttachment(fixture.client, { userId: second, documentId: id })).status).toBe("ready");
    // Removing a link must resolve the public ID without discarding another owner's link.
    await writeState(fixture.client, first, workspace(), { vaultRevision: 2 });
    const otherState = await readState(fixture.client, second);
    expect(otherState.conversations[otherState.rootId].documents[0].id).toBe(id);
    expect(await deleteDocument(fixture.client, { userId: first, documentId: id })).toBe(true);
    expect((await getVaultAttachment(fixture.client, { userId: second, documentId: id })).bytes).toEqual(right);
    expect((await findRelevantDocumentChunks(fixture.client, { userId: second, documentIds: [id], embedding, limit: 8 }))[0].content).toBe("other");
  });

  test("commits attachment checkpoints with the matching projection and rejects a stale incremental baseline", async () => {
    const owner = await user();
    const state = workspace("shared");
    const firstMap = revisions("first");
    const laterMap = revisions("later");
    const checkpoint = async () => (await fixture.client.query("select vault_revision, attachment_revisions from marginchat_vault_projections where user_id=$1", [owner])).rows[0];
    await writeState(fixture.client, owner, state, {
      vaultRevision: 1, expectedVaultProjectionRevision: -1, attachmentRevisions: firstMap,
      vaultAttachments: [{ attachment: attachment("shared"), bytes: Buffer.from("first") }],
    });
    await writeState(fixture.client, owner, state, {
      vaultRevision: 2, expectedVaultProjectionRevision: 1, attachmentRevisions: laterMap,
      vaultAttachments: [{ attachment: attachment("shared"), bytes: Buffer.from("later") }],
    });
    // Revision 3 was prepared from revision 1, whose bytes happened to match it.
    // Skipping that body would otherwise publish revision 3 with revision 2 bytes.
    await expect(writeState(fixture.client, owner, state, {
      vaultRevision: 3, expectedVaultProjectionRevision: 1, attachmentRevisions: firstMap,
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(Number((await checkpoint()).vault_revision)).toBe(2);
    expect((await checkpoint()).attachment_revisions).toEqual(laterMap);
    expect((await getVaultAttachment(fixture.client, { userId: owner, documentId: "shared" })).bytes.toString()).toBe("later");
    // A stale request already superseded by the stored revision is harmless.
    expect(await writeState(fixture.client, owner, state, { vaultRevision: 1, expectedVaultProjectionRevision: -1 })).toEqual({ projected: false, vaultRevision: 2 });
    await writeState(fixture.client, owner, state, {
      vaultRevision: 3, expectedVaultProjectionRevision: 2, attachmentRevisions: firstMap,
      vaultAttachments: [{ attachment: attachment("shared"), bytes: Buffer.from("first") }],
    });
    expect((await checkpoint()).attachment_revisions).toEqual(firstMap);
    expect((await getVaultAttachment(fixture.client, { userId: owner, documentId: "shared" })).bytes.toString()).toBe("first");
    await expect(writeState(fixture.client, owner, workspace("missing"), {
      vaultRevision: 4, expectedVaultProjectionRevision: 3, attachmentRevisions: laterMap,
    })).rejects.toThrow("unavailable");
    expect(Number((await checkpoint()).vault_revision)).toBe(3);
    expect((await checkpoint()).attachment_revisions).toEqual(firstMap);
    await writeState(fixture.client, owner, null, {
      vaultRevision: 4, expectedVaultProjectionRevision: 3, attachmentRevisions: {}, deletedVaultAttachmentIds: ["shared"],
    });
    expect((await checkpoint()).attachment_revisions).toEqual({});
    expect(await readState(fixture.client, owner)).toBeNull();
    expect(await getVaultAttachment(fixture.client, { userId: owner, documentId: "shared" })).toBeNull();
  });

  test("a projection from the older serving release invalidates attachment checkpoints", async () => {
    const owner = await user();
    expect(await readVaultProjectionCheckpoint(fixture.client, owner)).toBeNull();
    const attachments = revisions("one");
    await writeState(fixture.client, owner, null, { vaultRevision: 1, attachmentRevisions: attachments });
    expect(await readVaultProjectionCheckpoint(fixture.client, owner)).toEqual({ revision: 1, attachments });
    // An older application only knows these original checkpoint columns.
    await fixture.client.query("update marginchat_vault_projections set vault_revision=2, projected_at=now() where user_id=$1", [owner]);
    expect(await readVaultProjectionCheckpoint(fixture.client, owner)).toEqual({ revision: 2, attachments: {} });
  });
});

test("the additive identity migration preserves legacy indexes and accepts writes from the serving release", async () => {
  const pg = new PGlite({ extensions: { vector } });
  const client = { async query(sql: string, params?: unknown[]) {
    const result = params === undefined && sql.includes(";") ? (await pg.exec(sql)).at(-1) ?? { rows: [] } : await pg.query(sql, params);
    return { ...result, rowCount: result.rows.length || result.affectedRows || 0 };
  } };
  try {
    const migrations = await loadMigrations();
    const index = migrations.findIndex(({ id }: any) => id === "0005_attachment_projection_identity");
    await migrateDatabase(client, { migrations: migrations.slice(0, index) });
    await client.query("insert into marginchat_users (id,email,password_hash,display_name) values ('legacy-owner','legacy@example.test','unused','Legacy')");
    const insertLegacy = (id: string) => client.query(`insert into marginchat_documents (id,user_id,filename,mime_type,size_bytes,original_bytes,status)
      values ($1,'legacy-owner','legacy.txt','text/plain',6,$2,'ready') on conflict (id) do update set filename=excluded.filename`, [id, Buffer.from("legacy")]);
    await insertLegacy("legacy");
    await client.query("insert into marginchat_document_chunks (id,document_id,chunk_index,content,token_count,embedding_model,embedding) values ('legacy-chunk','legacy',0,'legacy',1,'fixture-model',$1::vector)", [JSON.stringify(embedding)]);
    // Reproduce the already-applied identity migration before its checkpoint
    // follow-up. Its checksum is immutable even though the runner is retryable.
    const appliedIdentity = migrations[index];
    expect(appliedIdentity.checksum).toBe("e125fcacee3953c9c05ea1910cb66d4c69179a75881b6c2b4582924df0504105");
    await migrateDatabase(client, { migrations: migrations.slice(0, index + 1) });
    await insertLegacy("legacy");
    await insertLegacy("old-release-write");
    for (const id of ["legacy", "old-release-write"]) {
      expect((await getVaultAttachment(client, { userId: "legacy-owner", documentId: id })).bytes.toString()).toBe("legacy");
      await restoreVaultAttachment(client, { userId: "legacy-owner", attachment: attachment(id), bytes: Buffer.from("legacy") });
      const rows = await client.query("select id from marginchat_documents where user_id=$1 and coalesce(public_id,id)=$2", ["legacy-owner", id]);
      expect(rows.rows).toEqual([{ id }]);
    }
    expect((await findRelevantDocumentChunks(client, { userId: "legacy-owner", documentIds: ["legacy"], embedding, limit: 8 }))[0])
      .toMatchObject({ documentId: "legacy", content: "legacy" });
    await restoreVaultAttachment(client, { userId: "legacy-owner", attachment: attachment("new-public-id"), bytes: Buffer.from("scoped") });
    const before = (await client.query("select id, public_id from marginchat_documents where public_id='new-public-id'")).rows[0];
    expect(before.id).not.toBe(before.public_id);
    const attachments = revisions("applied-0005");
    await client.query("insert into marginchat_vault_projections (user_id,vault_revision,attachment_revisions) values ('legacy-owner',7,$1::jsonb)", [JSON.stringify(attachments)]);
    const upgrade = await migrateDatabase(client, { migrations });
    expect(upgrade.executed).toEqual(["0006_attachment_checkpoint_revision"]);
    expect((await client.query("select vault_revision, attachment_revisions, attachment_checkpoint_revision from marginchat_vault_projections where user_id='legacy-owner'")).rows[0])
      .toMatchObject({ attachment_revisions: attachments, attachment_checkpoint_revision: null });
    expect(await readVaultProjectionCheckpoint(client, "legacy-owner")).toEqual({ revision: 7, attachments: {} });
    // Repeated setup uses the ledger rather than replaying immutable raw SQL.
    expect((await migrateDatabase(client, { migrations })).executed).toEqual([]);
    expect((await client.query("select id, public_id from marginchat_documents where public_id='new-public-id'")).rows[0]).toEqual(before);
    expect((await getVaultAttachment(client, { userId: "legacy-owner", documentId: "new-public-id" })).bytes.toString()).toBe("scoped");
  } finally { await pg.close(); }
}, 30_000);
