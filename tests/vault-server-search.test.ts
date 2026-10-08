import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { createCaptureTestDatabase } from "./helpers/captureDatabase.mjs";
import { readVaultProjectionCheckpoint, writeState } from "../server/db/repository.mjs";
import { searchVaultPassages } from "../server/db/searchRepository.mjs";
import { normalizeAppState } from "../server/db/validation.mjs";
import { createVaultService } from "../server/vault/index.mjs";
import { passageSnippet, vaultSearchTerms } from "../server/vault/search.mjs";
import { digest } from "../server/vault/storage.mjs";
import { createApiHandler } from "../server/routes/api.mjs";
import { createMarkdownWorkspace } from "@margin-chat/workspace-contracts/markdown";
import { createEmptyState, createStandaloneNoteConversation } from "../client/src/initialState";
import { createVaultTransport } from "../client/src/lib/vaultApi";
import { setApiTransport } from "../client/src/lib/apiTransport";
import type { VaultSearchEvent } from "../client/src/lib/vaultTypes";

function memoryStorage() {
  const objects = new Map<string, Buffer>();
  const reads: string[] = [];
  const writes: string[] = [];
  return {
    kind: "memory", objects, reads, writes,
    async read(key: string) { reads.push(key); const bytes = objects.get(key); return bytes ? { bytes: Buffer.from(bytes), etag: digest(bytes) } : null; },
    async putImmutable(key: string, bytes: Buffer) { writes.push(key); objects.set(key, Buffer.from(bytes)); },
    async compareAndSwap(key: string, bytes: Buffer, expected: string | null) {
      if ((objects.has(key) ? digest(objects.get(key)!) : null) !== expected) return false;
      writes.push(key); objects.set(key, Buffer.from(bytes)); return true;
    },
  };
}

const at = (day: number) => `2026-09-${String(day).padStart(2, "0")}T10:00:00.000Z`;

/** A plan document with blocks, a chat with messages, and a standalone note. */
function workspace() {
  const state = createEmptyState();
  const plan = state.conversations[state.rootId];
  plan.title = "Launch plan";
  plan.createdAt = plan.updatedAt = at(20);
  plan.document = { schemaVersion: 1, blocks: [
    { id: "intro", kind: "markdown", content: "Goals for the quarter.", createdAt: at(20), updatedAt: at(20) },
    { id: "pricing", kind: "markdown", content: "We agreed the pricing tiers stay simple, with one annual discount.", createdAt: at(20), updatedAt: at(20) },
  ], prompts: [], generations: [] } as any;
  const chat = createStandaloneNoteConversation({ id: "chat", noteId: "chat-note", createdAt: at(10) });
  chat.title = "Supplier call";
  chat.kind = "chat";
  chat.notes = [];
  chat.messages = [{ id: "m1", role: "user", content: "Can the supplier hold pricing through March?", createdAt: at(10) } as any];
  chat.updatedAt = at(10);
  state.conversations.chat = chat;
  const note = createStandaloneNoteConversation({ id: "note", noteId: "note-body", createdAt: at(5) });
  note.title = "Pricing ideas";
  note.notes![0].content = "Try usage pricing for teams.";
  note.updatedAt = at(5);
  state.conversations.note = note;
  return createMarkdownWorkspace(state).files as Record<string, string>;
}

describe("search helpers", () => {
  test("terms are words of the query and snippets locate the match", () => {
    expect(vaultSearchTerms("  Pricing, TIERS pricing ")).toEqual(["pricing", "tiers"]);
    expect(vaultSearchTerms("100% _ x")).toEqual(["100", "x"]);
    const text = `${"Lead in text. ".repeat(10)}The pricing   tiers stay simple.${" Tail.".repeat(40)}`;
    const found = passageSnippet(text, ["tiers", "pricing"])!;
    expect(text.slice(found.start, found.end)).toBe("pricing");
    expect(found.snippet.slice(found.match.start, found.match.end)).toBe("pricing");
    expect(found.snippet.startsWith("…")).toBe(true);
    expect(found.snippet.endsWith("…")).toBe(true);
    expect(passageSnippet("Nothing here", ["pricing"])).toBeNull();
  });
});

describe("cloud vault index and search", () => {
  let fixture: Awaited<ReturnType<typeof createCaptureTestDatabase>>;
  beforeAll(async () => { fixture = await createCaptureTestDatabase(); }, 30000);
  afterAll(async () => { await fixture?.pg.close(); });
  afterEach(() => setApiTransport(null));

  async function user() {
    const id = crypto.randomUUID();
    await fixture.client.query(
      "insert into marginchat_users (id, email, password_hash, display_name) values ($1, $2, 'unused', 'Search test')",
      [id, `${id}@example.test`],
    );
    return id;
  }

  const database = {
    getVaultProjectionCheckpoint: (id: string) => readVaultProjectionCheckpoint(fixture.client, id),
    projectVaultState: (id: string, source: any, revision: number, options: any) => writeState(fixture.client, id, source === null ? null : normalizeAppState(source), {
      vaultRevision: revision, forceVaultProjection: options.force, vaultAttachments: options.attachments,
      deletedVaultAttachmentIds: options.deletedAttachmentIds, attachmentRevisions: options.attachmentRevisions,
      expectedVaultProjectionRevision: options.expectedProjectionRevision, unchangedConversationIds: options.unchangedConversationIds,
    }),
    searchVaultPassages: (args: any) => searchVaultPassages(fixture.client, args),
  };

  async function seeded() {
    const userId = await user();
    const storage = memoryStorage();
    const vault = createVaultService({ storage, database });
    const files = workspace();
    const saved = await vault.commit(userId, Object.entries(files).map(([path, content]) => ({ path, content, baseRevision: null })));
    expect(saved.projection.status).toBe("ready");
    return { userId, storage, vault, files, saved };
  }

  async function collect(vault: ReturnType<typeof createVaultService>, userId: string, query: string) {
    const events: any[] = [];
    await vault.search(userId, query, { emit: (event: any) => events.push(event) });
    return events;
  }

  test("titles match first, then passages from documents, messages and notes", async () => {
    const { userId, vault } = await seeded();
    const events = await collect(vault, userId, "pricing");
    expect(events[0].type).toBe("documents");
    expect(events[0].results.map((entry: any) => entry.title)).toEqual(["Pricing ideas"]);
    expect(events.at(-1)).toMatchObject({ type: "done", revision: 1, indexedRevision: 1 });
    const passages = Object.fromEntries(events.filter((event) => event.type === "passages").map((event) => [event.source, event.results]));
    expect(passages.documents).toHaveLength(1);
    expect(passages.documents[0]).toMatchObject({ title: "Launch plan", source: "document", position: { blockId: "pricing" } });
    expect(passages.documents[0].path).toMatch(/\.md$/u);
    const block = "We agreed the pricing tiers stay simple, with one annual discount.";
    expect(block.slice(passages.documents[0].position.start, passages.documents[0].position.end)).toBe("pricing");
    expect(passages.messages).toEqual([expect.objectContaining({ id: "chat", source: "message", position: expect.objectContaining({ messageId: "m1" }) })]);
    expect(passages.notes).toEqual([expect.objectContaining({ id: "note", source: "note", snippet: "Try usage pricing for teams." })]);

    // Every term must appear; an empty query lists the newest documents.
    const both = await collect(vault, userId, "pricing tiers");
    expect(both.filter((event) => event.type === "passages").flatMap((event) => event.results).map((result: any) => result.id)).toEqual([expect.any(String)]);
    const recent = await collect(vault, userId, "");
    expect(recent[0].results.map((entry: any) => entry.title)).toEqual(["Launch plan", "Supplier call", "Pricing ideas"]);
    expect(recent.some((event) => event.type === "passages")).toBe(false);
  });

  test("another account's passages are never returned", async () => {
    await seeded();
    const stranger = await user();
    const vault = createVaultService({ storage: memoryStorage(), database });
    await vault.commit(stranger, [{ path: "Mine.md", content: "# Mine\n\nNothing shared.\n", baseRevision: null }]);
    const events = await collect(vault, stranger, "pricing");
    expect(events.filter((event) => event.results?.length)).toEqual([]);
  });

  test("the index lists newest first, and a save re-summarizes only what it changed", async () => {
    const { userId, storage, vault, files, saved } = await seeded();
    expect((await vault.index(userId)).entries.map((entry: any) => entry.title)).toEqual(["Launch plan", "Supplier call", "Pricing ideas"]);
    const notePath = Object.keys(files).find((path) => files[path].includes("Pricing ideas"))!;
    await vault.commit(userId, [{ path: notePath, content: files[notePath].replace("Try usage", "Try seat"), baseRevision: saved.manifest.files[notePath].revision }]);
    // A cold server reuses stored index shards; only the edited file is read.
    storage.reads.length = 0;
    storage.writes.length = 0;
    const cold = createVaultService({ storage, database });
    expect((await cold.index(userId)).entries).toHaveLength(3);
    expect(storage.reads.filter((key) => key.includes("/files/"))).toEqual([expect.stringContaining(digest(notePath))]);
    expect(storage.writes.filter((key) => key.includes("/index/"))).toHaveLength(1);
    expect(storage.objects.get(`vaults/v1/${digest(userId)}/index.json`)!.length).toBeLessThan(64 * 1024);
  });

  test("the HTTP routes stream the index and search to the browser transport", async () => {
    const { userId, vault } = await seeded();
    const handler = createApiHandler({
      runtimeConfig: { host: "127.0.0.1", port: 8787 }, vaultService: vault,
      authService: { async getAuthContext() { return { user: { id: userId, role: "admin", billing: {} } }; } },
    } as any);
    const http = createServer(handler);
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    setApiTransport({ fetch: (input, init) => fetch(`${base}${input}`, init) });
    try {
      const plain = await fetch(`${base}/api/vault/index`);
      expect(plain.headers.get("content-type")).toContain("application/json");
      expect((await plain.json()).entries).toHaveLength(3);
      const streamed = await fetch(`${base}/api/vault/index`, { headers: { Accept: "application/x-ndjson" } });
      expect(streamed.headers.get("content-type")).toContain("application/x-ndjson");
      const [header, ...lines] = (await streamed.text()).trim().split("\n").map((line) => JSON.parse(line));
      expect(header).toEqual({ type: "index", configured: true, revision: 1, count: 3 });
      expect(lines.map((entry) => entry.title)).toEqual(["Launch plan", "Supplier call", "Pricing ideas"]);

      const transport = createVaultTransport(userId);
      const index = await transport.index!();
      expect(index.entries.map((entry) => entry.title)).toEqual(["Launch plan", "Supplier call", "Pricing ideas"]);
      const events: VaultSearchEvent[] = [];
      await transport.search!("pricing", { limit: 5 }, (event) => events.push(event));
      expect(events[0]).toMatchObject({ type: "documents", results: [{ title: "Pricing ideas" }] });
      expect(events.filter((event) => event.type === "passages")).toHaveLength(3);
      expect(events.at(-1)).toMatchObject({ type: "done", revision: 1 });
      expect((await fetch(`${base}/api/vault/search?q=x&limit=500`)).status).toBe(400);
    } finally {
      await new Promise((resolve) => http.close(resolve));
    }
  });
});

describe("streamed index in the browser transport", () => {
  afterEach(() => setApiTransport(null));

  test("the newest entries are reported while the rest download", async () => {
    const entry = (i: number) => JSON.stringify({ path: `Notes/${i}.md`, id: `doc-${i}`, revision: "a".repeat(64), type: "conversation", kind: "note", title: `Note ${i}` });
    const body = [JSON.stringify({ type: "index", configured: true, revision: 7, count: 120 }), ...Array.from({ length: 120 }, (_, i) => entry(i)), ""].join("\n");
    // Deliver the stream in uneven pieces that split lines.
    const bytes = new TextEncoder().encode(body);
    setApiTransport({ fetch: async () => new Response(new ReadableStream({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 777) controller.enqueue(bytes.slice(offset, offset + 777));
        controller.close();
      },
    }), { headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } }) });
    const seen: number[] = [];
    const index = await createVaultTransport().index!((partial) => seen.push(partial.entries.length));
    expect(seen).toEqual([50, 100]);
    expect(index.revision).toBe(7);
    expect(index.entries.map((item) => item.id).slice(0, 2)).toEqual(["doc-0", "doc-1"]);
    expect(index.entries).toHaveLength(120);
  });

  test("an older server's JSON index still works", async () => {
    setApiTransport({ fetch: async () => Response.json({ configured: true, revision: 2, entries: [
      { path: "A.md", id: "a", revision: "b".repeat(64), type: "conversation", kind: "note", title: "A" }, { path: "../bad", id: "x" },
    ] }) });
    expect(await createVaultTransport().index!()).toEqual({ revision: 2, entries: [
      { path: "A.md", id: "a", revision: "b".repeat(64), type: "conversation", kind: "note", title: "A" }] });
  });
});
