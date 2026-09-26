import { describe, expect, test } from "bun:test";
import { createMarkdownWorkspace, parseMarkdownWorkspace, normalizeEditableDocument, type AppState, type DocumentBlock, type EditableDocument } from "@margin-chat/workspace-contracts";
import { createEmptyState, createSideConversation } from "../client/src/initialState";
import { transferDocumentBlock } from "../client/src/lib/documentBlockTransfer";
import { getEditableDocument } from "../client/src/lib/editableDocument";
import { undoDocumentInsertion } from "../client/src/lib/documentVersions";
import { normalizeAppState } from "../server/db/validation.mjs";

const now = "2026-09-25T12:00:00.000Z";
const later = "2026-09-25T13:00:00.000Z";
function block(id: string, content: string): DocumentBlock {
  return { id, kind: "markdown", content, createdAt: now, updatedAt: now };
}
function fixture(): AppState {
  const state = createEmptyState();
  const source = state.conversations[state.rootId];
  source.document = { schemaVersion: 1, blocks: [block("move", "An authored **passage**.\r\n\r\n| A | B |\r\n| - | - |\r\n| 1 | 2 |"), block("stay", "Keep source text")], prompts: [], generations: [] };
  const target = createSideConversation({ id: "target", sourceConversation: source, createdAt: now });
  target.document = { schemaVersion: 1, blocks: [block("before", "Before"), block("after", "After")], prompts: [], generations: [] };
  source.childIds = [target.id];
  source.documentLayout = { order: [target.id, source.id], minimizedIds: [] };
  state.conversations[target.id] = target;
  return state;
}
function move(state: AppState, beforeBlockId: string | null = "after", newId = "moved") {
  return transferDocumentBlock(state, state.rootId, "move", "target", beforeBlockId, later, newId);
}
function generatedFixture(): AppState {
  const state = fixture();
  const source = state.conversations[state.rootId];
  source.messages = [{ id: "question", role: "user", content: "Write a two-part answer", createdAt: now },
    { id: "answer", role: "assistant", content: "Original answer.\n\nOther paragraph.", createdAt: now }];
  delete source.document;
  source.document = getEditableDocument(source);
  source.document.blocks[0] = { ...source.document.blocks[0], id: "move", content: "Human-edited **answer**\r\n" };
  const generation = source.document.generations[0];
  generation.blockIds[0] = "move";
  generation.alternativeOf = "older-generation";
  generation.previousBlocks = [block("old-response", "Do not restore source-only text in the target")];
  generation.replacement = { blockId: "source-only", offset: 0, content: "Do not insert this source selection" };
  generation.insertion = { blockId: "source-only", offset: 0 };
  return state;
}

describe("cross-document block transfer", () => {
  test("atomically moves exact Markdown at the requested position without changing ancestry or input", () => {
    const state = fixture();
    const before = structuredClone(state);
    const next = move(state);
    expect(next).not.toBe(state);
    expect(state).toEqual(before);
    expect(next.conversations[state.rootId].document!.blocks.map((item) => item.id)).toEqual(["stay"]);
    expect(next.conversations.target.document!.blocks.map((item) => item.id)).toEqual(["before", "moved", "after"]);
    expect(next.conversations.target.document!.blocks[1].content).toBe(before.conversations[state.rootId].document!.blocks[0].content);
    expect(next.conversations[state.rootId].childIds).toEqual(["target"]);
    expect(next.conversations.target.parentId).toBe(state.rootId);
    expect(next.conversations[state.rootId].documentLayout).toEqual(before.conversations[state.rootId].documentLayout);
    expect(next.conversations.target.updatedAt).toBe(later);
    expect(next.activeConversationId).toBe(state.activeConversationId);
    expect(() => normalizeAppState(next)).not.toThrow();
  });

  test("missing and stale destinations, self moves and colliding IDs are harmless no-ops", () => {
    const state = fixture();
    for (const [source, id, target, before, movedId] of [
      ["missing", "move", "target", null, "moved"], [state.rootId, "gone", "target", null, "moved"],
      [state.rootId, "move", "missing", null, "moved"], [state.rootId, "move", state.rootId, null, "moved"],
      [state.rootId, "move", "target", "deleted", "moved"], [state.rootId, "move", "target", null, "move"],
      [state.rootId, "move", "target", null, "document:stay"], [state.rootId, "move", "target", null, ""],
    ] as const) expect(transferDocumentBlock(state, source, id, target, before, later, movedId)).toBe(state);
    expect(transferDocumentBlock(state, state.rootId, "move", "target", null, "invalid", "moved")).toBe(state);
    state.conversations.target.messages.push({ id: "document:moved", role: "user", content: "Historical identity", createdAt: now });
    expect(move(state)).toBe(state);
  });

  test("source annotations retain historical snapshots without reparenting linked documents", () => {
    const state = fixture();
    const source = state.conversations[state.rootId];
    source.notes = [{ id: "annotation", kind: "comment", content: "Keep this note", sourceMessageId: "document:move", sourceBlockId: "move",
      startOffset: 3, endOffset: 11, quote: "authored", createdAt: now, updatedAt: now }];
    state.conversations.target.branchAnchor = { id: "branch", sourceConversationId: source.id, sourceMessageId: "document:move", sourceBlockId: "move",
      startOffset: 3, endOffset: 11, quote: "authored", prompt: "Discuss this", createdAt: now };
    const next = move(state);
    const after = next.conversations[source.id];
    expect(after.messages.find((message) => message.id === "document:move")?.content).toBe(source.document!.blocks[0].content);
    expect(after.notes![0]).toMatchObject({ id: "annotation", sourceMessageId: "document:move", sourceBlockId: "detached:move", quote: "authored" });
    expect(next.conversations.target.notes).toEqual([]);
    expect(next.conversations.target.branchAnchor).toMatchObject({ sourceConversationId: source.id, sourceBlockId: "detached:move", sourceMessageId: "document:move" });
    expect(next.conversations.target.parentId).toBe(source.id);
    expect(() => normalizeAppState(next)).not.toThrow();
  });

  test("copies AI provenance with fresh identities and limits destination undo to the transferred block", () => {
    const state = generatedFixture();
    const source = state.conversations[state.rootId];
    const next = move(state);
    const target = next.conversations.target;
    const moved = target.document!.blocks[1];
    const copied = target.document!.generations[0];
    const prompt = target.document!.prompts[0];
    expect(moved.content).toBe(source.document!.blocks[0].content);
    expect(moved.generationId).toBe(copied.id);
    expect(moved.sourceMessageId).toBe(copied.messageId);
    expect(copied.promptId).toBe(prompt.id);
    expect(copied.blockIds).toEqual([moved.id]);
    expect(copied.id).not.toBe(source.document!.generations[0].id);
    expect(copied).toMatchObject({ createdAt: now, acceptedAt: now, status: "complete", modelId: "smart-routing" });
    for (const field of ["alternativeOf", "previousBlocks", "replacement", "insertion"]) expect((copied as any)[field]).toBeUndefined();
    expect(target.messages.find((message) => message.id === copied.messageId)?.content).toBe(source.messages[1].content);
    expect(target.messages.find((message) => message.id === prompt.sourceMessageId)?.content).toBe(source.messages[0].content);
    expect(next.conversations[source.id].messages).toBe(source.messages);
    expect(next.conversations[source.id].document!.generations[0].blockIds).not.toContain("move");
    expect(next.conversations[source.id].document!.generations[0].previousBlocks).toEqual(source.document!.generations[0].previousBlocks);
    expect(undoDocumentInsertion(target, copied.id, later).document!.blocks.map((item) => item.id)).toEqual(["before", "after"]);
    expect(normalizeEditableDocument(target.document)).toEqual(target.document);
    expect(() => normalizeAppState(next)).not.toThrow();
  });

  test("legacy assistant blocks without a prompt keep their original message while invalid provenance is not discarded", () => {
    const state = fixture();
    const source = state.conversations[state.rootId];
    source.messages = [{ id: "legacy-answer", role: "assistant", content: "Original generated text", createdAt: now }];
    source.document!.blocks[0].sourceMessageId = "legacy-answer";
    const next = move(state);
    const moved = next.conversations.target.document!.blocks[1];
    expect(moved.sourceMessageId).not.toBe("legacy-answer");
    expect(next.conversations.target.messages.find((message) => message.id === moved.sourceMessageId)?.content).toBe("Original generated text");
    expect(next.conversations.target.document!.generations).toEqual([]);
    expect(next.conversations[source.id].messages).toBe(source.messages);
    expect(() => normalizeAppState(next)).not.toThrow();
    source.document!.blocks[0].sourceMessageId = "missing-original";
    expect(move(state)).toBe(state);
    source.document!.blocks[0].generationId = "missing-generation";
    expect(move(state)).toBe(state);
  });

  test("rejects moving or inserting before streaming blocks while allowing unrelated streams", () => {
    const state = generatedFixture();
    const source = state.conversations[state.rootId];
    source.document!.generations[0].status = "streaming";
    expect(move(state)).toBe(state);
    const manual = fixture();
    const streamed = source.document!.generations[0];
    const unrelatedStream = { ...streamed, id: "stream", blockIds: ["stay"], previousBlocks: undefined, replacement: undefined };
    manual.conversations[manual.rootId].document!.prompts = source.document!.prompts;
    manual.conversations[manual.rootId].document!.generations = [unrelatedStream];
    manual.conversations[manual.rootId].document!.blocks[1].generationId = "stream";
    const targetStream = { ...unrelatedStream, id: "target-stream", blockIds: ["before"] };
    manual.conversations.target.document!.prompts = source.document!.prompts;
    manual.conversations.target.document!.generations = [targetStream];
    manual.conversations.target.document!.blocks[0].generationId = "target-stream";
    expect(move(manual, "before")).toBe(manual);
    const next = move(manual, null);
    expect(next).not.toBe(manual);
    expect(next.conversations[manual.rootId].document!.generations[0]).toBe(unrelatedStream);
    expect(next.conversations.target.document!.generations[0]).toBe(targetStream);
  });

  test("new empty destinations replace only their unreferenced lone placeholder", () => {
    const state = fixture();
    delete state.conversations.target.document;
    const next = move(state, null);
    expect(next.conversations.target.document!.blocks.map((item) => item.id)).toEqual(["moved"]);
    const intentional = fixture();
    intentional.conversations.target.document!.blocks[0].content = "";
    expect(move(intentional, null).conversations.target.document!.blocks.map((item) => item.id)).toEqual(["before", "after", "moved"]);
    state.conversations[state.rootId].document!.links = [{ id: "keep-placeholder", sourceBlockId: "move", sourceMessageId: "document:move", startOffset: 0,
      endOffset: 2, quote: "An", targetConversationId: "target", targetBlockId: "empty:target", createdAt: now }];
    expect(move(state, null).conversations.target.document!.blocks.map((item) => item.id)).toEqual(["empty:target", "moved"]);
  });

  test("moves valid outgoing links, detaches source link history, and follows incoming block links", () => {
    const state = fixture();
    const source = state.conversations[state.rootId];
    source.document!.links = [{ id: "outgoing", sourceBlockId: "move", sourceMessageId: "document:move", startOffset: 3, endOffset: 11,
      quote: "authored", targetConversationId: "target", targetBlockId: "after", createdAt: now }];
    state.conversations.target.document!.links = [{ id: "incoming", sourceBlockId: "before", sourceMessageId: "document:before", startOffset: 0, endOffset: 6,
      quote: "Before", targetConversationId: source.id, targetBlockId: "move", createdAt: now }];
    const next = move(state);
    expect(next.conversations[source.id].document!.links![0].sourceBlockId).toBe("detached:move");
    const links = next.conversations.target.document!.links!;
    expect(links[0]).toMatchObject({ id: "incoming", targetConversationId: "target", targetBlockId: "moved" });
    expect(links[1]).toMatchObject({ sourceBlockId: "moved", sourceMessageId: "document:moved", quote: "authored", startOffset: 3, endOffset: 11,
      targetConversationId: "target", targetBlockId: "after" });
    expect(links[1].id).not.toBe("outgoing");
    expect(() => normalizeAppState(next)).not.toThrow();
  });

  test("manual and generated transfers survive Markdown round trips without resurrecting moved content", () => {
    // The existing vault parser normalizes CRLF on every document read.
    const restoredDocument = (document: EditableDocument) => ({ ...document,
      blocks: document.blocks.map((item) => ({ ...item, content: item.content.replace(/\r\n/g, "\n") })),
    });
    for (const state of [fixture(), generatedFixture()]) {
      const next = move(state);
      const markdown = createMarkdownWorkspace(next, later);
      const restored = parseMarkdownWorkspace(markdown.manifest, markdown.files)!;
      expect(restored.conversations[next.rootId].document).toEqual(restoredDocument(next.conversations[next.rootId].document!));
      expect(restored.conversations.target.document).toEqual(restoredDocument(next.conversations.target.document!));
      expect(restored.conversations.target.messages).toEqual(next.conversations.target.messages);
      expect(() => normalizeAppState(restored)).not.toThrow();
    }
    const state = fixture();
    state.conversations[state.rootId].document!.blocks = [state.conversations[state.rootId].document!.blocks[0]];
    const next = move(state);
    expect(getEditableDocument(next.conversations[state.rootId]).blocks).toEqual([]);
  });
});
