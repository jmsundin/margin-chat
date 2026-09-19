import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createCaptureTestDatabase } from "./helpers/captureDatabase.mjs";
import { readState, readWorkspace, writeState } from "../server/db/repository.mjs";
import { normalizeAppState } from "../server/db/validation.mjs";
import { completeDocument, failDocument, getVaultAttachment, listVaultAttachments, restoreVaultAttachment } from "../server/db/documentRepository.mjs";
import { createVaultService } from "../server/vault/index.mjs";
import { digest } from "../server/vault/storage.mjs";
import { createDocumentService } from "../server/documents/index.mjs";
import { normalizeAISettings, normalizeAIExecution } from "@margin-chat/workspace-contracts";
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
    await restoreVaultAttachment(fixture.client, { userId: other, attachment, bytes: Buffer.from("independent import") });
    expect((await getVaultAttachment(fixture.client, { userId: other, documentId: attachment.id })).bytes.toString()).toBe("independent import");
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

  test("a late ingestion failure cannot mark a replacement original failed", async () => {
    const userId = await user();
    const attachment = { id: crypto.randomUUID(), filename: "edited.txt", mimeType: "text/plain" };
    await restoreVaultAttachment(fixture.client, { userId, attachment, bytes: Buffer.from("new bytes") });
    expect(await failDocument(fixture.client, {
      userId, documentId: attachment.id, error: "Old extraction failed", sourceBytes: Buffer.from("old bytes"),
    })).toBeNull();
    expect((await getVaultAttachment(fixture.client, { userId, documentId: attachment.id })).status).toBe("processing");
  });

  test("AI settings and execution receipts round-trip without inventing absent metadata", async () => {
    const userId = await user();
    const normalized = state("AI metadata");
    const conversation = normalized.conversations[0];
    const ai = normalizeAISettings({ mode: "thorough", contextScope: "selected", selectedConversationIds: ["source-note"], allowedProviders: ["gemini"] });
    const execution = normalizeAIExecution({ schemaVersion: 1, provider: "gemini", model: "gemini-3.1-pro-preview", mode: "thorough", reason: "Selected for this task", sources: [{ kind: "note", id: "source-note", title: "Research" }] });
    conversation.ai = ai;
    conversation.messages = [{ id: "answer", role: "assistant", content: "Saved answer", createdAt: new Date().toISOString(), execution }];
    const revision = await writeState(fixture.client, userId, normalized);
    const restored = await readWorkspace(fixture.client, userId);
    expect(restored.revision).toBe(revision);
    expect(restored.state.conversations[conversation.id].ai).toEqual(ai);
    expect(restored.state.conversations[conversation.id].messages[0].execution).toEqual(execution);
    delete conversation.ai;
    delete conversation.messages[0].execution;
    await writeState(fixture.client, userId, normalized);
    const plain = (await readState(fixture.client, userId)).conversations[conversation.id];
    expect(Object.hasOwn(plain, "ai")).toBe(false);
    expect(Object.hasOwn(plain.messages[0], "execution")).toBe(false);
  });

  test("a delayed upload cannot undo a newer projected original", async () => {
    const userId = await user();
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
      async getVaultProjectionRevision(id: string) {
        const result = await fixture.client.query("select vault_revision from marginchat_vault_projections where user_id = $1", [id]);
        return result.rows[0]?.vault_revision ?? null;
      },
      async projectVaultState(id: string, source: any, revision: number, options: any) {
        return writeState(fixture.client, id, source === null ? null : normalizeAppState(source), {
          vaultRevision: revision, forceVaultProjection: options.force,
          vaultAttachments: options.attachments, deletedVaultAttachmentIds: options.deletedAttachmentIds,
        });
      },
      getVaultAttachment: (args: any) => getVaultAttachment(fixture.client, args),
      failDocument: (args: any) => failDocument(fixture.client, args),
    };
    const vault = createVaultService({ storage, database });
    let enter!: () => void;
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => { enter = resolve; });
    const release = new Promise<void>((resolve) => { resume = resolve; });
    const service = createDocumentService({ env: {}, database, vaultService: {
      ...vault,
      async status(id: string) { enter(); await release; return vault.status(id); },
    } });
    const upload = service.upload({ userId, context: { allowHosted: false, apiKeys: {} }, file: new File(["initial original"], "source.txt", { type: "text/plain" }) });
    await paused;
    try {
      const before = (await vault.snapshot(userId)).manifest;
      const path = Object.keys(before.files).find((path) => path.endsWith("/source.txt"))!;
      const documentId = path.split("/")[1];
      await vault.commitBinary(userId, { path, baseRevision: before.files[path].revision, bytes: Buffer.from("new original"), contentType: "text/plain" });
      resume();
      await upload;
      expect((await database.getVaultAttachment({ userId, documentId })).bytes.toString()).toBe("new original");
      expect((await vault.status(userId)).projection).toEqual({ status: "ready", revision: 2 });
      expect((await database.getVaultAttachment({ userId, documentId })).bytes.toString()).toBe("new original");
    } finally { resume(); await upload; }
  });
});

test("workspace reads keep one revision while another connection publishes changes", async () => {
  // Model MVCC at the connection boundary: a commit occurs immediately after
  // the session row is read, so later queries must retain the first snapshot.
  let current = 1;
  let snapshot: number | null = null;
  const date = new Date("2026-09-18T00:00:00Z");
  const client = { async query(sql: string) {
    const query = sql.trim().replace(/\s+/g, " ");
    if (query === "begin isolation level repeatable read read only") snapshot = current;
    const visible = snapshot ?? current;
    let rows: any[] = [];
    if (query.includes("from marginchat_app_sessions")) {
      rows = [{ id: "session", revision: visible, root_conversation_id: "root", active_conversation_id: "root", default_service_id: "openai-api", default_model_id: "gpt-5.6" }];
      current = 2;
    } else if (query.includes("from marginchat_conversations")) {
      rows = [{ id: "root", title: `Version ${visible}`, conversation_kind: "chat", parent_id: null, model_id: "gpt-5.6", service_id: "openai-api", created_at: date, updated_at: date }];
    } else if (query.includes("from marginchat_messages")) {
      rows = [{ id: "message", conversation_id: "root", role: "user", content: `Content ${visible}`, created_at: date }];
    }
    if (query === "commit" || query === "rollback") snapshot = null;
    return { rows, rowCount: rows.length };
  } };
  const workspace = await readWorkspace(client, "owner");
  expect(current).toBe(2);
  expect(workspace.revision).toBe(1);
  expect(workspace.state.conversations.root.title).toBe("Version 1");
  expect(workspace.state.conversations.root.messages[0].content).toBe("Content 1");
});
