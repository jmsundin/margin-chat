import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createCaptureTestDatabase } from "./helpers/captureDatabase.mjs";
import { readState, writeState } from "../server/db/repository.mjs";
import { normalizeAppState } from "../server/db/validation.mjs";
import { completeDocument, getVaultAttachment, listVaultAttachments, restoreVaultAttachment } from "../server/db/documentRepository.mjs";
import { createEmptyState } from "../client/src/initialState";

describe("vault-derived Postgres projections", () => {
  let fixture: Awaited<ReturnType<typeof createCaptureTestDatabase>>;
  beforeAll(async () => { fixture = await createCaptureTestDatabase(); }, 30000);
  afterAll(async () => { await fixture?.pg.close(); });

  async function user() {
    const id = crypto.randomUUID();
    await fixture.client.query(
      "insert into marginchat_users (id, email, password_hash, display_name) values ($1, $2, 'unused', 'Vault test')",
      [id, `${id}@example.test`],
    );
    return id;
  }

  function state(title: string) {
    const result = createEmptyState();
    result.conversations[result.rootId].title = title;
    return normalizeAppState(result);
  }

  test("older or duplicate indexing cannot overwrite a newer Markdown revision", async () => {
    const userId = await user();
    const latest = state("Latest Markdown");
    expect(await writeState(fixture.client, userId, latest, { vaultRevision: 12 }))
      .toEqual({ projected: true, vaultRevision: 12 });
    expect(await writeState(fixture.client, userId, state("Stale copy"), { vaultRevision: 10 }))
      .toEqual({ projected: false, vaultRevision: 12 });
    expect(await writeState(fixture.client, userId, state("Duplicate request"), { vaultRevision: 12 }))
      .toEqual({ projected: false, vaultRevision: 12 });
    const restored = await readState(fixture.client, userId);
    expect(Object.values(restored.conversations)[0].title).toBe("Latest Markdown");
  });

  test("a failed projection rolls back its rows and checkpoint together", async () => {
    const userId = await user();
    await writeState(fixture.client, userId, state("Committed source"), { vaultRevision: 3 });
    const invalid = state("Partial rebuild");
    invalid.conversations[0].documents = [{
      id: "missing-original",
      createdAt: new Date().toISOString(),
    }];
    await expect(writeState(fixture.client, userId, invalid, { vaultRevision: 4 })).rejects.toThrow("unavailable");
    const checkpoint = await fixture.client.query(
      "select vault_revision from marginchat_vault_projections where user_id = $1", [userId],
    );
    expect(Number(checkpoint.rows[0].vault_revision)).toBe(3);
    const restored = await readState(fixture.client, userId);
    expect(Object.values(restored.conversations)[0].title).toBe("Committed source");
  });

  test("an explicit rebuild can restore the same revision but cannot force an older one", async () => {
    const userId = await user();
    await writeState(fixture.client, userId, state("Source"), { vaultRevision: 6 });
    await fixture.client.query(
      "delete from marginchat_conversations where session_id in (select id from marginchat_app_sessions where user_id = $1)",
      [userId],
    );
    expect(await writeState(fixture.client, userId, state("Source"), { vaultRevision: 6, forceVaultProjection: true }))
      .toEqual({ projected: true, vaultRevision: 6 });
    expect(await writeState(fixture.client, userId, state("Old source"), { vaultRevision: 5, forceVaultProjection: true }))
      .toEqual({ projected: false, vaultRevision: 6 });
  });

  test("original attachments restore losslessly and remain scoped to their owner", async () => {
    const owner = await user();
    const other = await user();
    const attachment = {
      id: crypto.randomUUID(), filename: "original.pdf", mimeType: "application/pdf",
      createdAt: "2026-09-12T12:00:00.000Z", status: "ready", sizeBytes: 999,
    };
    const bytes = Buffer.from([0, 255, 1, 2, 3, 0]);
    const restored = await restoreVaultAttachment(fixture.client, { userId: owner, attachment, bytes });
    expect(restored.status).toBe("processing");
    expect(restored.sizeBytes).toBe(bytes.length);
    expect((await listVaultAttachments(fixture.client, owner))[0].bytes).toEqual(bytes);
    expect(await listVaultAttachments(fixture.client, other)).toEqual([]);
    expect(await getVaultAttachment(fixture.client, { userId: other, documentId: attachment.id })).toBeNull();
    await expect(restoreVaultAttachment(fixture.client, { userId: other, attachment, bytes })).rejects.toThrow("unavailable");
    expect((await getVaultAttachment(fixture.client, { userId: owner, documentId: attachment.id })).bytes).toEqual(bytes);
  });

  test("the revision guard covers attachment bytes as well as conversation rows", async () => {
    const userId = await user();
    const attachment = {
      id: crypto.randomUUID(), filename: "reference.txt", mimeType: "text/plain",
      createdAt: "2026-09-12T12:00:00.000Z",
    };
    await writeState(fixture.client, userId, state("New source"), {
      vaultRevision: 8,
      vaultAttachments: [{ attachment, bytes: Buffer.from("new original") }],
    });
    await writeState(fixture.client, userId, state("Old source"), {
      vaultRevision: 7,
      vaultAttachments: [{ attachment, bytes: Buffer.from("old original") }],
    });
    const stored = await getVaultAttachment(fixture.client, { userId, documentId: attachment.id });
    expect(stored.bytes.toString()).toBe("new original");
  });

  test("an empty authoritative vault clears content without resurrecting a default note", async () => {
    const userId = await user();
    await writeState(fixture.client, userId, state("Deleted Markdown"), { vaultRevision: 1 });
    expect(await writeState(fixture.client, userId, null, { vaultRevision: 2 }))
      .toEqual({ projected: true, vaultRevision: 2 });
    expect(await readState(fixture.client, userId)).toBeNull();
    expect(await writeState(fixture.client, userId, state("Late offline source"), { vaultRevision: 1 }))
      .toEqual({ projected: false, vaultRevision: 2 });
    expect(await readState(fixture.client, userId)).toBeNull();
  });

  test("deleted originals stay deleted when an older projection arrives", async () => {
    const userId = await user();
    const attachment = {
      id: crypto.randomUUID(), filename: "removed.txt", mimeType: "text/plain",
      createdAt: "2026-09-12T12:00:00.000Z",
    };
    const original = { attachment, bytes: Buffer.from("removed original") };
    await writeState(fixture.client, userId, state("Before deletion"), { vaultRevision: 1, vaultAttachments: [original] });
    await writeState(fixture.client, userId, state("After deletion"), { vaultRevision: 2, deletedVaultAttachmentIds: [attachment.id] });
    await writeState(fixture.client, userId, state("Stale"), { vaultRevision: 1, vaultAttachments: [original] });
    expect(await getVaultAttachment(fixture.client, { userId, documentId: attachment.id })).toBeNull();
  });

  test("embedding an earlier original cannot mark replacement bytes ready", async () => {
    const userId = await user();
    const attachment = {
      id: crypto.randomUUID(), filename: "edited.txt", mimeType: "text/plain",
      createdAt: "2026-09-12T12:00:00.000Z",
    };
    await restoreVaultAttachment(fixture.client, { userId, attachment, bytes: Buffer.from("new bytes") });
    expect(await completeDocument(fixture.client, {
      userId, documentId: attachment.id, chunks: [], embeddingModel: "test", sourceBytes: Buffer.from("old bytes"),
    })).toBeNull();
    expect((await getVaultAttachment(fixture.client, { userId, documentId: attachment.id })).status).toBe("processing");
  });
});
