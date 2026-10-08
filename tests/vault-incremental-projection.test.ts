import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createCaptureTestDatabase } from "./helpers/captureDatabase.mjs";
import { readState, readVaultProjectionCheckpoint, writeState } from "../server/db/repository.mjs";
import { normalizeAppState } from "../server/db/validation.mjs";
import { createVaultService } from "../server/vault/index.mjs";
import { digest } from "../server/vault/storage.mjs";

function memoryStorage() {
  const objects = new Map<string, Buffer>();
  const reads: string[] = [];
  return {
    kind: "memory", objects, reads,
    async read(key: string) { reads.push(key); const bytes = objects.get(key); return bytes ? { bytes, etag: digest(bytes) } : null; },
    async putImmutable(key: string, bytes: Buffer) { objects.set(key, Buffer.from(bytes)); },
    async compareAndSwap(key: string, bytes: Buffer, expected: string | null) {
      if ((objects.has(key) ? digest(objects.get(key)!) : null) !== expected) return false;
      objects.set(key, Buffer.from(bytes)); return true;
    },
  };
}

const note = (title: string, body = "Text.") => `# ${title}\n\n${body}\n`;
const requestContext = Symbol.for("@vercel/request-context");

describe("incremental vault projection", () => {
  let fixture: Awaited<ReturnType<typeof createCaptureTestDatabase>>;
  beforeAll(async () => { fixture = await createCaptureTestDatabase(); }, 30000);
  afterAll(async () => { await fixture?.pg.close(); });
  afterEach(() => { delete (globalThis as any)[requestContext]; });

  async function user() {
    const id = crypto.randomUUID();
    await fixture.client.query(
      "insert into marginchat_users (id, email, password_hash, display_name) values ($1, $2, 'unused', 'Projection test')",
      [id, `${id}@example.test`],
    );
    return id;
  }

  function database(calls: any[] = []) {
    return {
      getVaultProjectionCheckpoint: (id: string) => readVaultProjectionCheckpoint(fixture.client, id),
      async projectVaultState(id: string, source: any, revision: number, options: any) {
        calls.push(options);
        return writeState(fixture.client, id, source === null ? null : normalizeAppState(source), {
          vaultRevision: revision, forceVaultProjection: options.force,
          vaultAttachments: options.attachments, deletedVaultAttachmentIds: options.deletedAttachmentIds,
          attachmentRevisions: options.attachmentRevisions,
          expectedVaultProjectionRevision: options.expectedProjectionRevision,
          unchangedConversationIds: options.unchangedConversationIds,
        });
      },
    };
  }

  async function titles(userId: string) {
    return Object.fromEntries(Object.values((await readState(fixture.client, userId)).conversations)
      .map((conversation: any) => [conversation.title, conversation]));
  }

  async function setStoredTitle(userId: string, from: string, to: string) {
    await fixture.client.query(
      "update marginchat_conversations set title = $3 where title = $2 and session_id in (select id from marginchat_app_sessions where user_id = $1)",
      [userId, from, to],
    );
  }

  test("a save rewrites only the documents whose content changed", async () => {
    const userId = await user();
    const storage = memoryStorage();
    const calls: any[] = [];
    const vault = createVaultService({ storage, database: database(calls) });
    const first = await vault.commit(userId, [
      { path: "Alpha.md", content: note("Alpha"), baseRevision: null },
      { path: "Beta.md", content: note("Beta"), baseRevision: null },
      { path: "Gamma.md", content: note("Gamma"), baseRevision: null },
    ]);
    expect(first.projection.status).toBe("ready");
    expect(calls[0].unchangedConversationIds).toBeUndefined();

    // Rows the projection skips keep whatever they hold, which this marks.
    await setStoredTitle(userId, "Beta", "Beta (untouched row)");
    storage.reads.length = 0;
    const second = await vault.commit(userId, [{ path: "Alpha.md", content: note("Alpha", "Edited."), baseRevision: first.manifest.files["Alpha.md"].revision }]);
    expect(second.projection.status).toBe("ready");
    expect(calls[1].unchangedConversationIds).toHaveLength(2);
    // Unchanged file bodies are not downloaded again.
    expect(storage.reads.filter((key) => key.includes("/files/"))).toHaveLength(1);
    const projected = await titles(userId);
    expect(projected.Alpha.notes[0].content).toContain("Edited.");
    expect(projected["Beta (untouched row)"]).toBeDefined();
    expect(projected.Gamma).toBeDefined();

    // An explicit rebuild still rewrites everything.
    await vault.rebuild(userId);
    expect(calls[2].unchangedConversationIds).toBeUndefined();
    expect((await titles(userId)).Beta).toBeDefined();
  });

  test("fingerprints from another revision are never trusted", async () => {
    const userId = await user();
    const storage = memoryStorage();
    const calls: any[] = [];
    const vault = createVaultService({ storage, database: database(calls) });
    const first = await vault.commit(userId, [
      { path: "Alpha.md", content: note("Alpha"), baseRevision: null },
      { path: "Beta.md", content: note("Beta"), baseRevision: null },
    ]);
    const key = [...storage.objects.keys()].find((name) => name.endsWith("/projection.json"))!;
    const stored = JSON.parse(storage.objects.get(key)!.toString());
    storage.objects.set(key, Buffer.from(JSON.stringify({ ...stored, revision: stored.revision + 7 })));
    await setStoredTitle(userId, "Beta", "Beta (stale row)");
    await vault.commit(userId, [{ path: "Alpha.md", content: note("Alpha", "Edited."), baseRevision: first.manifest.files["Alpha.md"].revision }]);
    expect(calls[1].unchangedConversationIds).toBeUndefined();
    expect((await titles(userId)).Beta).toBeDefined();
  });

  test("saving returns before indexing where the server keeps running", async () => {
    const userId = await user();
    const vault = createVaultService({ storage: memoryStorage(), database: database(), env: {}, backgroundProjection: true });
    const saved = await vault.commit(userId, [{ path: "Alpha.md", content: note("Alpha"), baseRevision: null }]);
    expect(saved.projection).toEqual({ status: "queued", revision: 1 });
    // A status check waits for the indexing already under way.
    expect((await vault.status(userId)).projection).toEqual({ status: "ready", revision: 1 });
    expect((await titles(userId)).Alpha).toBeDefined();
  });

  test("a function host keeps indexing alive with waitUntil, or indexes before responding", async () => {
    const userId = await user();
    const vault = createVaultService({ storage: memoryStorage(), database: database(), env: { VERCEL: "1" }, backgroundProjection: true });
    const inline = await vault.commit(userId, [{ path: "Alpha.md", content: note("Alpha"), baseRevision: null }]);
    expect(inline.projection).toEqual({ status: "ready", revision: 1 });

    const kept: Promise<unknown>[] = [];
    (globalThis as any)[requestContext] = { get: () => ({ waitUntil: (work: Promise<unknown>) => kept.push(work) }) };
    const deferred = await vault.commit(userId, [{ path: "Beta.md", content: note("Beta"), baseRevision: null }]);
    expect(deferred.projection).toEqual({ status: "queued", revision: 2 });
    expect(kept).toHaveLength(1);
    expect(await kept[0]).toEqual({ status: "ready", revision: 2 });
    expect((await titles(userId)).Beta).toBeDefined();
  });
});
