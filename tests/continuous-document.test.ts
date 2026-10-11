import { describe, expect, test } from "bun:test";
import type { Conversation, DocumentBlock } from "@margin-chat/workspace-contracts";
import { blockChildGroups, isDraftBlockId, joinDocumentBlocks, reconcileDocumentBlocks, sameBlockList } from "../client/src/lib/continuousDocument";
import { remapDocumentAnchor } from "../client/src/lib/documentAnchors";

const now = "2026-10-11T12:00:00.000Z";
const later = "2026-10-11T13:00:00.000Z";
const messages = [{ id: "answer", role: "assistant" as const }];
function block(id: string, content: string, extra: Partial<DocumentBlock> = {}): DocumentBlock {
  return { id, kind: "markdown", content, createdAt: now, updatedAt: now, ...extra };
}
function conversation(blocks: DocumentBlock[]): Conversation {
  return { id: "lines", title: "Lines", serviceId: "backend-services", modelId: "smart-routing",
    parentId: null, childIds: [], branchAnchor: null, createdAt: now, updatedAt: now,
    document: { schemaVersion: 1, blocks, prompts: [], generations: [] },
    messages: [{ id: "answer", role: "assistant", content: blocks.map((value) => value.content).join("\n\n"), createdAt: now }] };
}

describe("lines of a continuous document", () => {
  const lines = [{ from: 0, to: 10 }, { from: 10, to: 20 }, { from: 20, to: 30 }, { from: 30, to: 40 }];

  test("every line is its own block unless a saved passage spans lines", () => {
    expect(blockChildGroups(lines, [])).toEqual([[0], [1], [2], [3]]);
    expect(blockChildGroups(lines, [{ from: 2, to: 8 }, { from: 21, to: 29 }])).toEqual([[0], [1], [2], [3]]);
    expect(blockChildGroups(lines, [{ from: 5, to: 15 }])).toEqual([[0, 1], [2], [3]]);
    expect(blockChildGroups(lines, [{ from: 15, to: 35 }])).toEqual([[0], [1, 2, 3]]);
    expect(blockChildGroups(lines, [{ from: 5, to: 12 }, { from: 25, to: 32 }])).toEqual([[0, 1], [2, 3]]);
  });

  test("a passage that ends exactly where a line ends does not join the next line", () => {
    expect(blockChildGroups(lines, [{ from: 10, to: 20 }])).toEqual([[0], [1], [2], [3]]);
    expect(blockChildGroups(lines, [{ from: 0, to: 0 }])).toEqual([[0], [1], [2], [3]]);
  });

  test("saving keeps untouched blocks and gives split lines their origin's provenance", () => {
    const answer = block("answer-block", "First line\n\nSecond line", { sourceMessageId: "answer", generationId: "generation" });
    const note = block("note", "My note");
    const next = reconcileDocumentBlocks([answer, note], [
      { id: "answer-block", markdown: "First line", changed: true },
      { id: "fresh", splitFrom: "answer-block", markdown: "Second line", changed: true },
      { id: "note", markdown: "My note", changed: false },
      { id: "draft:lines:1", markdown: "", changed: false },
    ], messages, later);
    expect(next.map((item) => item.id)).toEqual(["answer-block", "fresh", "note"]);
    expect(next[0]).toEqual({ ...answer, content: "First line", updatedAt: later, authorship: "ai" });
    expect(next[1]).toEqual({ id: "fresh", kind: "markdown", content: "Second line", createdAt: later, updatedAt: later,
      sourceMessageId: "answer", generationId: "generation", authorship: "ai" });
    expect(next[2]).toBe(note);
  });

  test("only whole lines of AI text stay AI; rewritten or new text does not", () => {
    const answer = block("answer-block", "First line\n\nSecond line", { sourceMessageId: "answer", generationId: "generation" });
    const next = reconcileDocumentBlocks([answer], [
      { id: "answer-block", markdown: "First line!", changed: true },
      { id: "split", splitFrom: "answer-block", markdown: "Second", changed: true },
      { id: "typed", markdown: "My own line", changed: true },
    ], messages, later);
    expect(next.map((item) => [item.content, item.generationId, item.authorship])).toEqual([
      ["First line!", "generation", "mixed"], ["Second", "generation", "mixed"], ["My own line", undefined, "user"]]);
    const mine = reconcileDocumentBlocks([block("mine", "One\n\nTwo", { authorship: "user" })], [
      { id: "mine", markdown: "One", changed: true }, { id: "two", splitFrom: "mine", markdown: "Two", changed: true }], messages, later);
    expect(mine.map((item) => item.authorship)).toEqual(["user", "user"]);
  });

  test("typing on the empty last line saves a new user block", () => {
    const next = reconcileDocumentBlocks([], [{ id: "draft:lines:1", markdown: "Typed", changed: true }], messages, later);
    expect(next).toHaveLength(1);
    expect(isDraftBlockId(next[0].id)).toBe(false);
    expect(next[0]).toMatchObject({ content: "Typed", authorship: "user" });
  });

  test("an unchanged editor keeps the saved block list", () => {
    const saved = [block("one", "One"), block("two", "Two")];
    const next = reconcileDocumentBlocks(saved, saved.map((item) => ({ id: item.id, markdown: item.content, changed: false })));
    expect(sameBlockList(saved, next)).toBe(true);
  });
});

describe("joining lines for a passage across them", () => {
  const blocks = [block("intro", "# Intro"), block("one", "First paragraph.", { sourceMessageId: "answer" }), block("two", "Second paragraph."), block("end", "End")];

  test("lines join into the first with the text unchanged", () => {
    const joined = joinDocumentBlocks(blocks, "one", ["two"], messages, later)!;
    expect(joined.map((item) => item.id)).toEqual(["intro", "one", "end"]);
    expect(joined[1]).toEqual({ ...blocks[1], content: "First paragraph.\n\nSecond paragraph.", updatedAt: later, authorship: "mixed" });
    expect(joined.map((item) => item.content).join("\n\n")).toBe(blocks.map((item) => item.content).join("\n\n"));
    expect(joinDocumentBlocks(blocks, "intro", ["one"], messages, later)![0].authorship).toBe("mixed");
    expect(joinDocumentBlocks(blocks, "two", ["end"], messages, later)![2].authorship).toBe("user");
  });

  test("lines that are no longer next to each other do not join", () => {
    expect(joinDocumentBlocks(blocks, "one", ["end"])).toBeNull();
    expect(joinDocumentBlocks(blocks, "missing", ["two"])).toBeNull();
    expect(joinDocumentBlocks(blocks, "end", ["after"])).toBeNull();
    expect(joinDocumentBlocks(blocks, "one", [])).toBeNull();
  });

  test("a highlight follows its line when a block splits, even when its text repeats", () => {
    const answer = { sourceMessageId: "answer", generationId: "generation" };
    const before = conversation([block("cats", "cat one\n\nthe cat", answer)]);
    const after = conversation([block("cats", "cat one!", { ...answer, authorship: "mixed" }), block("split", "the cat", answer)]);
    const second = { id: "second", sourceBlockId: "cats", sourceMessageId: "answer", startOffset: 13, endOffset: 16, quote: "cat" };
    expect(remapDocumentAnchor(second, before, after)).toMatchObject({ sourceBlockId: "split", startOffset: 4, endOffset: 7 });
    const first = { id: "first", sourceBlockId: "cats", sourceMessageId: "answer", startOffset: 0, endOffset: 3, quote: "cat" };
    expect(remapDocumentAnchor(first, before, after)).toEqual(first);
  });

  test("a highlight on a block's first line follows it when only that line joins the line above", () => {
    const answer = { sourceMessageId: "answer", generationId: "generation" };
    const before = conversation([block("intro", "Intro", { authorship: "user" }), block("lines", "P1 text\n\nP2 text\n\nP3 text", answer)]);
    const after = conversation([block("intro", "IntroP1 text", { authorship: "user" }), block("lines", "P2 text", answer), block("split", "P3 text", answer)]);
    const moved = remapDocumentAnchor({ id: "one", sourceBlockId: "lines", sourceMessageId: "answer", startOffset: 0, endOffset: 7, quote: "P1 text" }, before, after);
    expect(moved).toMatchObject({ sourceBlockId: "intro", sourceMessageId: "document:intro", startOffset: 5, endOffset: 12 });
    expect(remapDocumentAnchor({ id: "two", sourceBlockId: "lines", sourceMessageId: "answer", startOffset: 9, endOffset: 16, quote: "P2 text" }, before, after))
      .toMatchObject({ sourceBlockId: "lines", startOffset: 0, endOffset: 7 });
    expect(remapDocumentAnchor({ id: "three", sourceBlockId: "lines", sourceMessageId: "answer", startOffset: 18, endOffset: 25, quote: "P3 text" }, before, after))
      .toMatchObject({ sourceBlockId: "split", startOffset: 0, endOffset: 7 });
  });

  test("a highlight in a joined line moves into the joined block", () => {
    const before = conversation(blocks);
    const after = conversation(joinDocumentBlocks(blocks, "one", ["two"])!);
    const highlight = { id: "highlight", sourceBlockId: "two", sourceMessageId: "document:two", startOffset: 0, endOffset: 6, quote: "Second" };
    const moved = remapDocumentAnchor(highlight, before, after);
    expect(moved).toMatchObject({ sourceBlockId: "one", sourceMessageId: "answer", quote: "Second" });
    expect(after.document!.blocks[1].content.slice(moved.startOffset!, moved.endOffset!)).toBe("Second");
    const first = { id: "first", sourceBlockId: "one", sourceMessageId: "answer", startOffset: 0, endOffset: 5, quote: "First" };
    expect(remapDocumentAnchor(first, before, after)).toEqual(first);
  });
});
