import { describe, expect, test } from "bun:test";
import { createMarkdownWorkspace } from "@margin-chat/workspace-contracts";
import { createEmptyState, createStandaloneNoteConversation } from "../client/src/initialState";
import { createVaultService } from "../server/vault/index.mjs";
import { digest } from "../server/vault/storage.mjs";
import { sha256 } from "../server/vault/provenance/lines.mjs";
import { createAuthorshipTools, matchesAuthorFilter } from "../server/mcp/authorshipTools.mjs";
import { agentActor, createWriteTools } from "../server/mcp/writeTools.mjs";

function memoryStorage() {
  const objects = new Map<string, Buffer>();
  return {
    kind: "memory", objects,
    async read(key: string) { const bytes = objects.get(key); return bytes ? { bytes: Buffer.from(bytes), etag: digest(bytes) } : null; },
    async putImmutable(key: string, bytes: Buffer) { objects.set(key, Buffer.from(bytes)); },
    async compareAndSwap(key: string, bytes: Buffer, expected: string | null) {
      if ((objects.has(key) ? digest(objects.get(key)!) : null) !== expected) return false;
      objects.set(key, Buffer.from(bytes)); return true;
    },
  };
}

const at = "2026-11-01T10:00:00.000Z";
const muse = agentActor({ agentId: "t1", agentName: "Muse" });
const chatgpt = agentActor({ agentId: "t2", agentName: "ChatGPT" });
type Block = { id: string; content: string; authorship?: "ai" | "user" | "mixed" };

/** A vault with fixtures B (Jon's), C (mixed), F (locked and open twins), a chat, a PDF-backed document and a hidden one. */
async function setup() {
  const storage = memoryStorage();
  const vault = createVaultService({ storage });
  const state = createEmptyState();
  const doc = (id: string, blocks: Block[], extra: Record<string, unknown> = {}) => {
    const conversation = { ...structuredClone(state.conversations[state.rootId]), id, title: id, createdAt: at, updatedAt: at, childIds: [], parentId: null, ...extra } as any;
    conversation.document = { schemaVersion: 1, prompts: [], generations: [],
      blocks: blocks.map((block) => ({ kind: "markdown", createdAt: at, updatedAt: at, ...block })) };
    return conversation;
  };
  const mixed: Block[] = [
    { id: "ai1", content: "AI intro.\nAI detail.", authorship: "ai" },
    { id: "mine", content: "Jon one.\nJon two.\nJon three.", authorship: "user" },
    { id: "ai2", content: "AI kept.\nAI line Jon will edit.", authorship: "ai" },
  ];
  const chat = createStandaloneNoteConversation({ id: "chat", noteId: "chat-note", createdAt: at });
  Object.assign(chat, { kind: "chat", title: "Chat", messages: [{ id: "m1", role: "user", content: "Hi", createdAt: at }] });
  const conversations: Record<string, any> = {
    B: doc("B", [{ id: "jon", content: "First.\nSecond.\nThird.", authorship: "user" }]),
    C: doc("C", mixed),
    locked: doc("locked", [{ id: "ai", content: "AI text.", authorship: "ai" }, { id: "j", content: "Jon.", authorship: "user" }], { agentEdit: "locked" }),
    open: doc("open", [{ id: "ai", content: "AI text.", authorship: "ai" }, { id: "j", content: "Jon.", authorship: "user" }], { agentEdit: "open" }),
    hidden: doc("hidden", [{ id: "ai", content: "Secret AI text.", authorship: "ai" }], { hiddenFromAI: true }),
    pdf: doc("pdf", [{ id: "ai", content: "Extracted.", authorship: "ai" }], { documents: [{ id: "file1", filename: "a.pdf", mimeType: "application/pdf", sizeBytes: 1, status: "ready", createdAt: at }] }),
    chat,
  };
  state.conversations = conversations;
  state.rootId = "B";
  const files = createMarkdownWorkspace(state, at).files as Record<string, string>;
  await vault.commit("jon", Object.entries(files).map(([path, content]) => ({ path, content, baseRevision: null })));
  // Jon edits one line of the AI block in fixture C: that line, and only it, becomes his.
  conversations.C.document.blocks[2] = { ...conversations.C.document.blocks[2], content: "AI kept.\nJon's version of this line.", authorship: "mixed" };
  const index = await vault.index("jon");
  const entryC = index.entries.find((entry: any) => entry.id === "C")!;
  const next = createMarkdownWorkspace(state, at).files as Record<string, string>;
  await vault.commit("jon", [{ path: entryC.path, content: next[entryC.path], baseRevision: entryC.revision }]);
  const tools = (actor = muse) => createAuthorshipTools({ userId: "jon", vault, database: null, actor });
  const writer = (actor = muse) => createWriteTools({ userId: "jon", vault, agentName: actor.label, agentId: actor.id.slice(4), quotaBytes: undefined });
  return { vault, storage, tools, writer };
}

const hashes = (lines: string[]) => lines.map(sha256);
const revisionCount = async (vault: any) => vault.revision("jon");

describe("update_document", () => {
  test("edits only lines nobody wrote by hand, and keeps the rest attributed (fixtures A and C)", async () => {
    const { vault, tools } = await setup();
    const blame = await tools().blame({ document_id: "C" });
    expect(blame.blocks.map((block: any) => [block.block_id, block.lines.map((line: any) => line.author.type).join(",")]))
      .toEqual([["ai1", "ai,ai"], ["mine", "human,human,human"], ["ai2", "ai,human"]]);
    const updated = await tools().update({ document_id: "C", base_revision_id: blame.revision_id, reason: "Tighten the intro",
      operations: [
        { op: "replace_lines", block_id: "ai1", start_line: 1, end_line: 1, expected_sha256: hashes(["AI detail."]), new_text: "Sharper detail.\nAnd one more." },
        { op: "delete_lines", block_id: "ai2", start_line: 0, end_line: 0, expected_sha256: hashes(["AI kept."]) },
        { op: "insert_lines", block_id: "mine", after_line: 0, new_text: "Agent note between Jon's lines." },
        { op: "append_block", new_text: "A new section by the agent." },
      ] });
    expect(updated).toMatchObject({ ok: true, document_id: "C", previous_revision_id: blame.revision_id, changed: { added: 3, modified: 1, deleted: 1 },
      authorship: { humanLines: 4 } });
    const after = await tools().blame({ document_id: "C" });
    expect(after.revision_id).toBe(updated.revision_id);
    expect(after.blocks.map((block: any) => block.lines.map((line: any) => `${line.author.type}`).join(","))).toEqual([
      "ai,agent,agent", "human,agent,human,human", "human", "agent"]);
    // Jon's lines keep their origin; the agent's new lines name it and this revision.
    expect(after.blocks[1].lines[0].origin_revision_id).toBe(blame.blocks[1].lines[0].origin_revision_id);
    expect(after.blocks[0].lines[1].author).toEqual({ type: "agent", label: "Muse" });
    const read = await tools().readAuthorship("C");
    expect(read!.blocks[1].lines.map((line: any) => line.text)).toEqual(["Jon one.", "Agent note between Jon's lines.", "Jon two.", "Jon three."]);
    const head = await vault.provenance.current("jon", "C");
    expect(head).toMatchObject({ source: "mcp", reason: "Tighten the intro", actor: { type: "agent", label: "Muse" } });
  });

  test("a patch touching one of Jon's lines is refused whole, naming the line, and saves nothing (fixtures B and C)", async () => {
    const { vault, tools } = await setup();
    const c = await tools().blame({ document_id: "C" });
    const before = await revisionCount(vault);
    const refused = await tools().update({ document_id: "C", base_revision_id: c.revision_id, operations: [
      { op: "replace_lines", block_id: "ai1", start_line: 0, end_line: 0, expected_sha256: hashes(["AI intro."]), new_text: "Fine." },
      { op: "replace_lines", block_id: "ai2", start_line: 1, end_line: 1, expected_sha256: hashes(["Jon's version of this line."]), new_text: "Mine now." },
    ] });
    expect(refused).toMatchObject({ ok: false, code: "PROTECTED_AUTHORSHIP", status: 403,
      protected_lines: [{ block_id: "ai2", line: 1, author_label: "You", snippet: "Jon's version of this line." }] });
    expect(await revisionCount(vault)).toBe(before);
    const b = await tools().blame({ document_id: "B" });
    expect(await tools().update({ document_id: "B", base_revision_id: b.revision_id, operations: [
      { op: "delete_lines", block_id: "jon", start_line: 2, end_line: 2, expected_sha256: hashes(["Third."]) }] })).toMatchObject({ code: "PROTECTED_AUTHORSHIP" });
    // A move is a delete plus an insert: refused for Jon's lines.
    expect(await tools().update({ document_id: "B", base_revision_id: b.revision_id, operations: [
      { op: "delete_lines", block_id: "jon", start_line: 0, end_line: 0, expected_sha256: hashes(["First."]) },
      { op: "insert_lines", block_id: "jon", after_line: 2, new_text: "First." }] })).toMatchObject({ code: "PROTECTED_AUTHORSHIP" });
    expect(await revisionCount(vault)).toBe(before);
    // Insertion between Jon's lines is not modification.
    expect(await tools().update({ document_id: "B", base_revision_id: b.revision_id, operations: [
      { op: "insert_lines", block_id: "jon", after_line: 1, new_text: "An agent's aside." }] })).toMatchObject({ ok: true });
  });

  test("legacy edited-AI lines are Unknown and protected (fixture D)", async () => {
    const { storage, tools } = await setup();
    for (const key of [...storage.objects.keys()]) if (key.includes("/provenance/")) storage.objects.delete(key);
    const blame = await tools().blame({ document_id: "C" });
    expect(blame.inferred).toBe(true);
    expect(blame.blocks[2].lines.map((line: any) => line.author.type)).toEqual(["unknown", "unknown"]);
    expect(await tools().update({ document_id: "C", base_revision_id: blame.revision_id, operations: [
      { op: "delete_lines", block_id: "ai2", start_line: 0, end_line: 0, expected_sha256: hashes(["AI kept."]) }] })).toMatchObject({ code: "PROTECTED_AUTHORSHIP" });
  });

  test("locked refuses before diffing; open allows what the default refuses (fixture F)", async () => {
    const { tools } = await setup();
    const locked = await tools().blame({ document_id: "locked" });
    expect(await tools().update({ document_id: "locked", base_revision_id: "0".repeat(64), operations: [
      { op: "append_block", new_text: "x" }] })).toMatchObject({ code: "DOCUMENT_LOCKED", status: 403 });
    expect(locked.agent_edit).toBe("locked");
    const open = await tools().blame({ document_id: "open" });
    const patch = { op: "replace_lines", block_id: "j", start_line: 0, end_line: 0, expected_sha256: hashes(["Jon."]), new_text: "Agent rewrote Jon." };
    expect(await tools().update({ document_id: "open", base_revision_id: open.revision_id, operations: [patch] })).toMatchObject({ ok: true });
  });

  test("preconditions: stale revision, changed line, overlapping operations", async () => {
    const { tools } = await setup();
    const blame = await tools().blame({ document_id: "C" });
    expect(await tools().update({ document_id: "C", base_revision_id: "a".repeat(64), operations: [{ op: "append_block", new_text: "x" }] }))
      .toMatchObject({ code: "STALE_REVISION", status: 409, current_revision_id: blame.revision_id });
    expect(await tools().update({ document_id: "C", base_revision_id: blame.revision_id, operations: [
      { op: "delete_lines", block_id: "ai1", start_line: 0, end_line: 0, expected_sha256: hashes(["Not this."]) }] }))
      .toMatchObject({ code: "LINE_CHANGED", status: 409, block_id: "ai1", line: 0 });
    expect(await tools().update({ document_id: "C", base_revision_id: blame.revision_id, operations: [
      { op: "delete_lines", block_id: "ai1", start_line: 0, end_line: 1, expected_sha256: hashes(["AI intro.", "AI detail."]) },
      { op: "insert_lines", block_id: "ai1", after_line: 0, new_text: "x" }] })).toMatchObject({ code: "OVERLAPPING_OPERATIONS", status: 400 });
  });

  test("hidden documents, chats and PDF-backed documents are refused", async () => {
    const { tools } = await setup();
    expect(await tools().blame({ document_id: "hidden" })).toMatchObject({ found: false });
    expect(await tools().update({ document_id: "hidden", base_revision_id: "a".repeat(64), operations: [{ op: "append_block", new_text: "x" }] })).toMatchObject({ found: false });
    expect(await tools().readAuthorship("hidden")).toBeNull();
    expect(await tools().update({ document_id: "chat", base_revision_id: "a".repeat(64), operations: [{ op: "append_block", new_text: "x" }] })).toMatchObject({ code: "UNSUPPORTED_KIND" });
    expect(await tools().update({ document_id: "pdf", base_revision_id: "a".repeat(64), operations: [{ op: "append_block", new_text: "x" }] })).toMatchObject({ code: "UNSUPPORTED_KIND" });
  });

  test("one app creates, another updates the first's lines; read-back shows both, attributed (§11, test 8)", async () => {
    const { tools, writer } = await setup();
    const created = await writer(muse).run("create_document", { title: "Living memory", content: "Fact one.\nStale fact.\nFact three." });
    expect(created).toMatchObject({ ok: true });
    const blame = await tools(chatgpt).blame({ document_id: created.document_id });
    expect(blame.blocks[0].lines.map((line: any) => line.author.label)).toEqual(["Muse", "Muse", "Muse"]);
    const updated = await tools(chatgpt).update({ document_id: created.document_id, base_revision_id: created.revision_id, operations: [
      { op: "replace_lines", block_id: blame.blocks[0].block_id, start_line: 1, end_line: 1, expected_sha256: hashes(["Stale fact."]), new_text: "Fresh fact." }] });
    expect(updated).toMatchObject({ ok: true, changed: { added: 0, modified: 1, deleted: 0 } });
    const read = await tools().readAuthorship(created.document_id);
    expect(read!.blocks[0].lines.map((line: any) => [line.text, line.author.label])).toEqual([
      ["Fact one.", "Muse"], ["Fresh fact.", "ChatGPT"], ["Fact three.", "Muse"]]);
    expect(read!.revision_id).toBe(updated.revision_id);
  });

  test("search's author filter works on document totals", () => {
    const mine = { humanLines: 2, aiLines: 0, agentLines: 1, importLines: 0, totalLines: 3 };
    const theirs = { humanLines: 0, aiLines: 3, agentLines: 0, importLines: 0, totalLines: 3 };
    expect([matchesAuthorFilter("mine", mine), matchesAuthorFilter("mine", theirs), matchesAuthorFilter("not-mine", theirs),
      matchesAuthorFilter("agent", mine), matchesAuthorFilter("ai", mine), matchesAuthorFilter("any", undefined), matchesAuthorFilter("mine", undefined)])
      .toEqual([true, false, true, true, false, true, false]);
  });
});
