import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createCaptureTestDatabase } from "./helpers/captureDatabase.mjs";
import { readVaultProjectionCheckpoint, writeState } from "../server/db/repository.mjs";
import { readAgentConversation, searchAgentPassages } from "../server/db/searchRepository.mjs";
import { deleteMissingPassageSources, listAIHiddenIds, listStalePassageSources, replacePassageSources } from "../server/db/passageRepository.mjs";
import { listStaleTopicSources } from "../server/db/topicRepository.mjs";
import { normalizeAppState } from "../server/db/validation.mjs";
import { createVaultService } from "../server/vault/index.mjs";
import { digest } from "../server/vault/storage.mjs";
import { createAgentToolExecutor } from "../server/chat/agent/tools.mjs";
import { createMarkdownWorkspace, parseMarkdownWorkspace, summarizeMarkdownVaultFile } from "@margin-chat/workspace-contracts/markdown";
import { createEmptyState, createChildConversation, createMainConversation, createStandaloneNoteConversation } from "../client/src/initialState";
import { prepareAIContext } from "../client/src/lib/aiContext";
import { getConversationRequestPayload } from "../client/src/lib/chatContext";
import { buildJevWorkspaceSnapshot } from "../client/src/lib/jevAssistance";
import { hydratePersistedState } from "../client/src/lib/appState";
import type { AppState, Conversation } from "../client/src/types";

const at = (day: number) => `2026-10-${String(day).padStart(2, "0")}T10:00:00.000Z`;

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

/** A plan with a margin note under it, and a diary note the user hid from AI. */
function workspaceState(): AppState {
  const state = createEmptyState();
  const plan = state.conversations[state.rootId];
  plan.id = "plan";
  plan.title = "Launch plan";
  plan.createdAt = plan.updatedAt = at(10);
  plan.document = { schemaVersion: 1, blocks: [
    { id: "pricing", kind: "markdown", content: "Pricing tiers stay simple.", createdAt: at(10), updatedAt: at(10) },
  ], prompts: [], generations: [] } as any;
  plan.childIds = ["margin"];
  const margin = createChildConversation({ id: "margin", parentConversation: plan });
  Object.assign(margin, { title: "Pricing worry", createdAt: at(11), updatedAt: at(11), document: { schemaVersion: 1,
    marginNote: { display: "compact" }, blocks: [{ id: "worry", kind: "markdown", content: "Pricing might scare teams.", createdAt: at(11), updatedAt: at(11) }],
    prompts: [], generations: [] } });
  const diary = createStandaloneNoteConversation({ id: "diary", noteId: "diary-body", createdAt: at(5) });
  diary.title = "Pricing diary";
  diary.notes![0].content = "Private pricing thoughts about my salary.";
  diary.updatedAt = at(5);
  diary.hiddenFromAI = true;
  state.rootId = "plan";
  state.conversations = { plan, margin, diary };
  return state;
}

describe("hide from AI in the vault's Markdown", () => {
  test("is a frontmatter property that survives a round trip, and nothing is hidden by default", () => {
    const state = workspaceState();
    const markdown = createMarkdownWorkspace(state);
    const diaryFile = Object.entries(markdown.files).find(([, text]) => text.includes("Private pricing thoughts"))!;
    expect(diaryFile[1]).toMatch(/^hide-from-ai: true$/m);
    // Only in frontmatter, the one place people and Obsidian read it.
    expect(diaryFile[1].match(/hiddenFromAI|hide-from-ai/g)).toEqual(["hide-from-ai"]);
    for (const [path, text] of Object.entries(markdown.files)) if (path !== diaryFile[0]) expect(text).not.toContain("hide-from-ai");

    const parsed = parseMarkdownWorkspace(markdown.manifest, markdown.files)!;
    expect(parsed.conversations.diary.hiddenFromAI).toBe(true);
    expect(parsed.conversations.plan.hiddenFromAI).toBeUndefined();
    // Margin notes are ordinary documents: visible to AI unless the user hides one.
    expect(parsed.conversations.margin.hiddenFromAI).toBeUndefined();
    expect(summarizeMarkdownVaultFile(diaryFile[0], diaryFile[1])).toMatchObject({ id: "diary", hiddenFromAI: true });

    // Turning it off removes the property.
    const shown = { ...parsed, conversations: { ...parsed.conversations, diary: { ...parsed.conversations.diary } } };
    delete shown.conversations.diary.hiddenFromAI;
    const again = createMarkdownWorkspace(shown, undefined, markdown);
    expect(Object.values(again.files).join("\n")).not.toContain("hide-from-ai");
  });

  test("a plain Markdown note can be hidden by hand, and the app keeps the flag", () => {
    const source = "---\ntitle: Journal\nhide-from-ai: true\n---\n# Journal\n\nPersonal.";
    expect(summarizeMarkdownVaultFile("Journal.md", source)).toMatchObject({ hiddenFromAI: true });
    expect(summarizeMarkdownVaultFile("Other.md", "---\nhide-from-ai: false\n---\nText")).not.toHaveProperty("hiddenFromAI");
    const state = hydratePersistedState(JSON.parse(JSON.stringify(workspaceState())));
    expect(state?.conversations.diary.hiddenFromAI).toBe(true);
    expect(state?.conversations.plan).not.toHaveProperty("hiddenFromAI");
  });
});

describe("hide from AI in what the app sends", () => {
  test("workspace context leaves a hidden document out, even when the user selected it", () => {
    const state = workspaceState();
    const asking = { ...createMainConversation({ id: "asking" }), ai: { contextScope: "selected", selectedConversationIds: ["diary", "plan"] } } as Conversation;
    const question = [{ id: "q", role: "user" as const, content: "pricing", createdAt: at(12) }];
    expect(prepareAIContext(state.conversations, asking, question).workspaceContext.map((item) => item.id)).toEqual(["plan"]);
    const everything = { ...asking, ai: { contextScope: "workspace" } } as Conversation;
    expect(prepareAIContext(state.conversations, everything, question).workspaceContext.map((item) => item.id).sort()).toEqual(["margin", "plan"]);
  });

  test("a hidden parent and the passage quoted from it stay out of a branch's context", () => {
    const state = workspaceState();
    const plan = { ...state.conversations.plan, hiddenFromAI: true };
    const margin = { ...state.conversations.margin, branchAnchor: { id: "a", sourceConversationId: "plan", sourceMessageId: "document:pricing",
      sourceBlockId: "pricing", startOffset: 0, endOffset: 7, quote: "Pricing", prompt: "Margin note", createdAt: at(11) } };
    const conversations = { ...state.conversations, plan, margin };
    const payload = getConversationRequestPayload(conversations, margin);
    expect(payload.ancestorContext).toEqual([]);
    expect(payload.branchAnchor).toBeNull();
    expect(JSON.stringify(payload)).not.toContain("Pricing tiers");
    // Visible again, both return.
    const visible = getConversationRequestPayload({ ...conversations, plan: state.conversations.plan }, margin);
    expect(visible.ancestorContext.map((item) => item.id)).toEqual(["plan"]);
    expect(visible.branchAnchor?.quote).toBe("Pricing");
  });

  test("AI assistance (Jev) never sees a hidden document", () => {
    const state = workspaceState();
    const snapshot = buildJevWorkspaceSnapshot(state.conversations, "plan")!;
    expect(snapshot.items.map((item) => item.id).sort()).toEqual(["margin", "plan"]);
    expect(buildJevWorkspaceSnapshot(state.conversations, "diary")).toBeNull();
  });
});

describe("hide from AI on the server", () => {
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
    listAIHiddenIds: (args: any) => listAIHiddenIds(fixture.client, args),
  };

  beforeAll(async () => {
    fixture = await createCaptureTestDatabase();
    userId = crypto.randomUUID();
    await fixture.client.query(
      "insert into marginchat_users (id, email, password_hash, display_name) values ($1, $2, 'unused', 'Hidden test')",
      [userId, `${userId}@example.test`],
    );
    vault = createVaultService({ storage: memoryStorage(), database });
    const files = createMarkdownWorkspace(workspaceState()).files as Record<string, string>;
    const saved = await vault.commit(userId, Object.entries(files).map(([path, content]) => ({ path, content, baseRevision: null })));
    expect(saved.projection.status).toBe("ready");
  }, 30000);
  afterAll(async () => { await fixture?.pg.close(); });

  const request = (ai: Record<string, unknown> = {}) => ({
    ai: { mode: "balanced", contextScope: "conversation", selectedConversationIds: [], ...ai },
    conversation: { id: "current", title: "Current", ancestorContext: [] },
    messages: [{ role: "user", content: "What do I think about pricing?" }],
    workspaceContext: [],
  });

  test("the saved copy records which documents are hidden", async () => {
    expect(await listAIHiddenIds(fixture.client, { userId })).toEqual(["diary"]);
    expect(await readAgentConversation(fixture.client, { userId, conversationId: "diary" })).toBeNull();
    expect((await readAgentConversation(fixture.client, { userId, conversationId: "margin" }))?.text).toBe("Pricing might scare teams.");
  });

  test("Agent mode and connected apps can't search, read or list a hidden document", async () => {
    const run = createAgentToolExecutor({ chatRequest: request(), workspace: { userId, vault, database } });
    const found: any = await run("search_vault", { query: "pricing" });
    expect(found.results.map((hit: any) => hit.document_id).sort()).toEqual(["margin", "plan"]);
    expect(JSON.stringify(found)).not.toContain("salary");
    expect(await run("read_document", { document_id: "diary" })).toMatchObject({ found: false });
    expect(await run("list_related", { document_id: "diary" })).toMatchObject({ found: false });
    // Even when the user selected it for the agent.
    const selected = createAgentToolExecutor({ chatRequest: request({ agentScope: "selected", selectedConversationIds: ["diary"] }), workspace: { userId, vault, database } });
    expect(await selected("read_document", { document_id: "diary" })).toMatchObject({ found: false });
  });

  test("search by meaning and topic embeddings never index a hidden document, and forget it once hidden", async () => {
    const stale = await listStalePassageSources(fixture.client, { userId, limit: 50, maxCharacters: 10_000, leadCharacters: 600 });
    expect(stale.sources.map((source: any) => source.id).sort()).toEqual(["margin", "plan"]);
    const topics = await listStaleTopicSources(fixture.client, { userId, model: "test", limit: 50, maxCharacters: 2000 });
    expect(topics.sources.map((source: any) => source.id).sort()).toEqual(["margin", "plan"]);

    // A document indexed before it was hidden loses its passages at the next refresh.
    await replacePassageSources(fixture.client, { userId, sources: stale.sources.map((source: any) => ({ ...source, passages: [] })) });
    await fixture.client.query("update marginchat_conversations set ai_hidden = true where id like '%::margin'");
    await deleteMissingPassageSources(fixture.client, { userId });
    const kept = (await fixture.client.query("select source_id from marginchat_vault_passage_sources")).rows.map((row: any) => row.source_id.split("::").at(-1));
    expect(kept).toEqual(["plan"]);
    await fixture.client.query("update marginchat_conversations set ai_hidden = false where id like '%::margin'");
  });
});
