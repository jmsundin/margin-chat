import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createCaptureTestDatabase } from "./helpers/captureDatabase.mjs";
import { readVaultProjectionCheckpoint, writeState } from "../server/db/repository.mjs";
import { readAgentConversation, searchAgentPassages } from "../server/db/searchRepository.mjs";
import { normalizeAppState } from "../server/db/validation.mjs";
import { createVaultService } from "../server/vault/index.mjs";
import { digest } from "../server/vault/storage.mjs";
import { agentToolDefinitions, createAgentToolExecutor, describeAgentStep } from "../server/chat/agent/tools.mjs";
import { createChatService } from "../server/chat/index.mjs";
import { getDefaultModelIdForService } from "../server/lib/backendModels.mjs";
import { createMarkdownWorkspace } from "@margin-chat/workspace-contracts/markdown";
import { createEmptyState, createStandaloneNoteConversation } from "../client/src/initialState";

function memoryStorage() {
  const objects = new Map<string, Buffer>();
  return {
    kind: "memory",
    async read(key: string) { const bytes = objects.get(key); return bytes ? { bytes: Buffer.from(bytes), etag: digest(bytes) } : null; },
    async putImmutable(key: string, bytes: Buffer) { objects.set(key, Buffer.from(bytes)); },
    async compareAndSwap(key: string, bytes: Buffer, expected: string | null) {
      if ((objects.has(key) ? digest(objects.get(key)!) : null) !== expected) return false;
      objects.set(key, Buffer.from(bytes)); return true;
    },
  };
}

const at = (day: number) => `2026-09-${String(day).padStart(2, "0")}T10:00:00.000Z`;

/**
 * A plan document (with an old message that is no longer in it), a chat under it
 * with a private margin comment, and a note the plan "supports".
 */
function workspace() {
  const state = createEmptyState();
  const plan = state.conversations[state.rootId];
  plan.id = "plan";
  plan.title = "Launch plan";
  plan.createdAt = plan.updatedAt = at(20);
  plan.messages = [{ id: "old", role: "assistant", content: "An old pricing draft that was deleted.", createdAt: at(19) } as any];
  plan.document = { schemaVersion: 1, blocks: [
    { id: "intro", kind: "markdown", content: "Goals for the quarter.", createdAt: at(20), updatedAt: at(20) },
    { id: "pricing", kind: "markdown", content: "We agreed the pricing tiers stay simple.", createdAt: at(20), updatedAt: at(20) },
  ], prompts: [], generations: [] } as any;
  plan.relations = [{ type: "supports", targetConversationId: "note" }];
  plan.childIds = ["chat"];
  const chat = createStandaloneNoteConversation({ id: "chat", noteId: "chat-note", createdAt: at(10) });
  Object.assign(chat, { title: "Supplier call", kind: "chat", parentId: "plan", updatedAt: at(10) });
  chat.messages = [{ id: "m1", role: "user", content: "Can the supplier hold pricing through March?", createdAt: at(10) } as any];
  chat.notes = [{ id: "c1", kind: "comment", sourceMessageId: "m1", startOffset: null, endOffset: null, quote: null,
    content: "Private pricing worry, keep to myself.", createdAt: at(10), updatedAt: at(10) } as any];
  const note = createStandaloneNoteConversation({ id: "note", noteId: "note-body", createdAt: at(5) });
  note.title = "Pricing ideas";
  note.notes![0].content = "Try usage pricing for teams.";
  note.updatedAt = at(5);
  state.rootId = "plan";
  state.conversations = { plan, chat, note };
  return createMarkdownWorkspace(state).files as Record<string, string>;
}

function request(ai: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    ai: { mode: "balanced", contextScope: "workspace", selectedConversationIds: [], ...ai },
    conversation: { id: "current", title: "Current", ancestorContext: [] },
    messages: [{ role: "user", content: "What did we decide about pricing?" }],
    workspaceContext: [],
    ...extra,
  };
}

describe("agent vault tools", () => {
  let fixture: Awaited<ReturnType<typeof createCaptureTestDatabase>>;
  let userId: string;
  let vault: ReturnType<typeof createVaultService>;
  const database = {
    getVaultProjectionCheckpoint: (id: string) => readVaultProjectionCheckpoint(fixture.client, id),
    projectVaultState: (id: string, source: any, revision: number, options: any) => writeState(fixture.client, id, source === null ? null : normalizeAppState(source), {
      vaultRevision: revision, forceVaultProjection: options.force, vaultAttachments: options.attachments,
      deletedVaultAttachmentIds: options.deletedAttachmentIds, attachmentRevisions: options.attachmentRevisions,
      expectedVaultProjectionRevision: options.expectedProjectionRevision, unchangedConversationIds: options.unchangedConversationIds,
    }),
    searchAgentPassages: (args: any) => searchAgentPassages(fixture.client, args),
    readAgentConversation: (args: any) => readAgentConversation(fixture.client, args),
  };

  beforeAll(async () => {
    fixture = await createCaptureTestDatabase();
    userId = crypto.randomUUID();
    await fixture.client.query(
      "insert into marginchat_users (id, email, password_hash, display_name) values ($1, $2, 'unused', 'Agent test')",
      [userId, `${userId}@example.test`],
    );
    vault = createVaultService({ storage: memoryStorage(), database });
    const saved = await vault.commit(userId, Object.entries(workspace()).map(([path, content]) => ({ path, content, baseRevision: null })));
    expect(saved.projection.status).toBe("ready");
  }, 30000);
  afterAll(async () => { await fixture?.pg.close(); });

  const tools = (ai: Record<string, unknown>, extra?: Record<string, unknown>) =>
    createAgentToolExecutor({ chatRequest: request(ai, extra), workspace: { userId, vault, database } });

  test("search finds titles and readable text, never margin comments or a document's deleted history", async () => {
    const run = tools({});
    const found: any = await run("search_vault", { query: "pricing" });
    expect(found.results.map((hit: any) => [hit.title, hit.matched])).toEqual([
      ["Pricing ideas", "title"], ["Launch plan", "text"], ["Supplier call", "text"],
    ]);
    expect(found.results[1].snippet).toBe("We agreed the pricing tiers stay simple.");
    expect(found.results[0].snippet).toBe("Try usage pricing for teams.");
    expect((await run("search_vault", { query: "private worry" }) as any).total_matches).toBe(0);
    expect((await run("search_vault", { query: "deleted draft" }) as any).total_matches).toBe(0);
  });

  test("read returns a document's current blocks, a note's body and a chat's messages", async () => {
    const run = tools({ mode: "thorough" });
    const plan: any = await run("read_document", { document_id: "plan" });
    expect(plan.document).toMatchObject({ title: "Launch plan", text: "Goals for the quarter.\n\nWe agreed the pricing tiers stay simple.", truncated: false });
    expect((await run("read_document", { document_id: "note" }) as any).document.text).toBe("Try usage pricing for teams.");
    const chat: any = await run("read_document", { document_id: "chat" });
    expect(chat.document).toMatchObject({ kind: "chat", parent_id: "plan", message_count: 1,
      messages: [{ role: "user", content: "Can the supplier hold pricing through March?" }] });
    expect(JSON.stringify(chat)).not.toContain("Private");
    expect(await run("read_document", { document_id: "missing" })).toEqual({ document_id: "missing", found: false });
  });

  test("the request's own snapshot wins over the saved copy", async () => {
    const run = tools({}, { workspaceContext: [{ id: "plan", title: "Launch plan", updatedAt: at(21), content: "Unsaved: pricing moves to usage.", messages: [] }] });
    expect((await run("read_document", { document_id: "plan" }) as any).document.text).toBe("Unsaved: pricing moves to usage.");
  });

  test("related lists the parent, children, typed relations and backlinks", async () => {
    const run = tools({});
    const plan: any = await run("list_related", { document_id: "plan" });
    expect(plan.related.map((item: any) => [item.title, item.relation])).toEqual([["Pricing ideas", "supports"], ["Supplier call", "child"]]);
    expect((await run("list_related", { document_id: "chat" }) as any).related.map((item: any) => [item.title, item.relation])).toEqual([["Launch plan", "parent"]]);
    expect((await run("list_related", { document_id: "note" }) as any).related.map((item: any) => [item.title, item.relation])).toEqual([["Launch plan", "linked from"]]);
  });

  test("selected material limits what the tools reach, and this-chat-only offers none", async () => {
    const workspaceAccess = { userId, vault, database };
    expect(agentToolDefinitions(request({ contextScope: "conversation" }), workspaceAccess).map((tool: any) => tool.name))
      .toEqual(["search_conversations", "list_recent_conversations", "get_conversation"]);
    expect(agentToolDefinitions(request({}), null)).toHaveLength(3);
    expect(agentToolDefinitions(request({}), workspaceAccess).map((tool: any) => tool.name).slice(3)).toEqual(["search_vault", "read_document", "list_related"]);
    const run = tools({ contextScope: "selected", selectedConversationIds: ["note"] });
    expect((await run("search_vault", { query: "pricing" }) as any).results.map((hit: any) => hit.title)).toEqual(["Pricing ideas"]);
    expect(await run("read_document", { document_id: "plan" })).toMatchObject({ found: false, error: expect.stringContaining("outside") });
    expect((await run("list_related", { document_id: "note" }) as any).related).toEqual([]);
  });

  test("the run log describes vault steps without their contents", () => {
    expect(describeAgentStep("search_vault", { query: "pricing" }, { total_matches: 3, results: [] }))
      .toEqual({ kind: "tool", tool: "search_vault", label: "Searched your vault for “pricing”", detail: "3 results", ok: true });
    expect(describeAgentStep("read_document", { document_id: "plan" }, { found: true, document: { title: "Launch plan", truncated: true } }))
      .toMatchObject({ label: "Read “Launch plan”", detail: "Shortened to fit", ok: true });
    expect(describeAgentStep("list_related", { document_id: "plan" }, { found: true, document: { title: "Launch plan" }, total_related: 1 }))
      .toMatchObject({ label: "Checked what's connected to “Launch plan”", detail: "1 connection" });
    expect(describeAgentStep("read_document", { document_id: "x" }, { document_id: "x", found: false, error: "outside" }))
      .toMatchObject({ label: "Tried to open a document outside the allowed context", ok: false });
    expect(describeAgentStep("search_vault", { query: "x" }, { ok: false, error: "down" }))
      .toMatchObject({ label: "Couldn't reach your saved vault", ok: false });
  });
});

describe("vault tools in the chat service", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  function reply(contextScope: string) {
    const bodies: any[] = [];
    globalThis.fetch = (async (_url: any, init: any) => { bodies.push(JSON.parse(init.body)); return Response.json({ output_text: "Done.", output: [] }); }) as typeof fetch;
    const service = createChatService({ autoRouter: async () => null, database: {}, runtimeConfig: { defaultBackendProvider: "openai-api" },
      env: { OPENAI_API_KEY: "openai-test" }, vaultService: { configured: true } });
    const payload = { ...request({ contextScope, agent: true }), serviceId: "openai-api", modelId: getDefaultModelIdForService("openai-api"),
      conversation: { ancestorContext: [], branchAnchor: null, id: "current", parentId: null, title: "Current" } };
    return service.requestReply(payload, { userId: "owner" }).then(() => bodies[0]);
  }

  test("offers the vault tools when the user lets AI search their workspace", async () => {
    const body = await reply("workspace");
    expect(body.tools.map((tool: any) => tool.name)).toContain("search_vault");
    expect(body.instructions).toContain("saved vault in the cloud");
  });

  test("otherwise tells the model how the user can widen its reach", async () => {
    const body = await reply("conversation");
    expect(body.tools.map((tool: any) => tool.name)).not.toContain("search_vault");
    expect(body.instructions).toContain("Search relevant notes and conversations in my workspace");
  });
});
