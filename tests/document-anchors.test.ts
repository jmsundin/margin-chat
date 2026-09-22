import { describe, expect, test } from "bun:test";
import type { Conversation, DocumentBlock } from "@margin-chat/workspace-contracts";
import { createAppStateFromWorkspaceDocument, createMarkdownWorkspace, createWorkspaceDocument, parseMarkdownWorkspace } from "@margin-chat/workspace-contracts";
import { createEmptyState } from "../client/src/initialState";
import { remapDocumentAnchor, type DocumentAnchorRange } from "../client/src/lib/documentAnchors";

const now = "2026-09-20T12:00:00.000Z";
function block(id: string, content: string, sourceMessageId?: string): DocumentBlock {
  return { id, kind: "markdown", content, createdAt: now, updatedAt: now, ...(sourceMessageId ? { sourceMessageId } : {}) };
}
function conversation(blocks: DocumentBlock[]): Conversation {
  return { id: "anchor-document", title: "Anchor document", serviceId: "backend-services", modelId: "smart-routing",
    parentId: null, childIds: [], branchAnchor: null, createdAt: now, updatedAt: now,
    document: { schemaVersion: 1, blocks, prompts: [], generations: [] },
    messages: [{ id: "original-message", role: "assistant", content: blocks.map((value) => value.content).join(""), createdAt: now }] };
}
function anchor(content: string, quote: string, manual = false): DocumentAnchorRange & { id: string } {
  const startOffset = content.indexOf(quote);
  return { id: "saved-highlight", sourceBlockId: "source", sourceMessageId: manual ? "document:source" : "original-message",
    startOffset, endOffset: startOffset + quote.length, quote };
}

describe("document passage anchors", () => {
  test("ordinary prefix edits shift exact ranges while unchanged content retains identity", () => {
    const before = conversation([block("source", "Before selected after", "original-message")]);
    const saved = anchor(before.document!.blocks[0].content, "selected");
    expect(remapDocumentAnchor(saved, before, before)).toBe(saved);
    const after = { ...before, document: { ...before.document!, blocks: [block("source", "New Before selected after", "original-message")] } };
    expect(remapDocumentAnchor(saved, before, after)).toEqual({ ...saved, startOffset: 11, endOffset: 19 });
  });

  test("a suffix split moves an assistant highlight into the new block and preserves the original source message", () => {
    const before = conversation([block("source", "Before selected after", "original-message"), block("neighbor", "Unrelated")]);
    const saved = anchor(before.document!.blocks[0].content, "selected");
    const after = { ...before, document: { ...before.document!, blocks: [block("source", "Before ", "original-message"), block("split", "selected after", "original-message"), before.document!.blocks[1]] } };
    expect(remapDocumentAnchor(saved, before, after)).toEqual({ ...saved, sourceBlockId: "split", startOffset: 0, endOffset: 8 });
    expect(saved.sourceBlockId).toBe("source");
  });

  test("a rich Markdown split rebinds a manual passage to its new synthetic source ID", () => {
    const before = conversation([block("source", "**Before selected after**")]);
    const saved = anchor(before.document!.blocks[0].content, "selected", true);
    const after = { ...before, document: { ...before.document!, blocks: [block("source", "**Before**"), block("split", "**selected after**")] } };
    expect(remapDocumentAnchor(saved, before, after)).toEqual({ ...saved, sourceBlockId: "split", sourceMessageId: "document:split", startOffset: 2, endOffset: 10 });
  });

  test("an inserted generated block is not confused with the surviving split source", () => {
    const before = conversation([block("source", "Before selected after", "original-message")]);
    const saved = anchor(before.document!.blocks[0].content, "selected");
    const after = { ...before, document: { ...before.document!, blocks: [block("source", "Before ", "original-message"),
      block("ai-insertion", "selected", "new-output"), block("suffix", "selected after", "original-message")] } };
    expect(remapDocumentAnchor(saved, before, after).sourceBlockId).toBe("suffix");
  });

  test("deletion detaches the historical passage instead of borrowing an existing or newly created matching block", () => {
    const before = conversation([block("source", "Before selected after", "original-message"), block("neighbor", "selected", "original-message")]);
    const saved = anchor(before.document!.blocks[0].content, "selected");
    for (const blocks of [[before.document!.blocks[1]], [block("new", "selected", "original-message")]]) {
      const after = { ...before, document: { ...before.document!, blocks } };
      const detached = remapDocumentAnchor(saved, before, after);
      expect(detached).toEqual({ ...saved, sourceBlockId: "detached:source" });
      expect(remapDocumentAnchor(detached, after, before)).toBe(detached);
    }
  });

  test("repeated quotes never recover to another occurrence after an ambiguous split or deletion", () => {
    const before = conversation([block("source", "Before selected after", "original-message")]);
    const saved = anchor(before.document!.blocks[0].content, "selected");
    const duplicateSplit = { ...before, document: { ...before.document!, blocks: [block("source", "Before ", "original-message"), block("first", "selected", "original-message"), block("second", "selected", "original-message")] } };
    expect(remapDocumentAnchor(saved, before, duplicateSplit).sourceBlockId).toBe("detached:source");
    const repeated = conversation([block("source", "selected, then selected", "original-message")]);
    const selectedFirst = anchor(repeated.document!.blocks[0].content, "selected");
    const deletedFirst = { ...repeated, document: { ...repeated.document!, blocks: [block("source", "selected", "original-message")] } };
    expect(remapDocumentAnchor(selectedFirst, repeated, deletedFirst).sourceBlockId).toBe("detached:source");
    const three = conversation([block("source", "selected selected selected", "original-message")]);
    const two = { ...three, document: { ...three.document!, blocks: [block("source", "selected selected", "original-message")] } };
    expect(remapDocumentAnchor(anchor(three.document!.blocks[0].content, "selected"), three, two).sourceBlockId).toBe("detached:source");
  });

  test("existing neighbors with matching text cannot attract an edited-away passage", () => {
    const before = conversation([block("source", "Before selected after", "original-message"), block("neighbor", "selected", "original-message")]);
    const after = { ...before, document: { ...before.document!, blocks: [block("source", "Entirely rewritten", "original-message"), before.document!.blocks[1]] } };
    expect(remapDocumentAnchor(anchor(before.document!.blocks[0].content, "selected"), before, after).sourceBlockId).toBe("detached:source");
  });

  test("detached block refs retain quote, range and source message through JSON and Markdown", () => {
    const before = conversation([block("source", "Before selected after", "original-message")]);
    const after = { ...before, document: { ...before.document!, blocks: [] } };
    const saved = remapDocumentAnchor(anchor(before.document!.blocks[0].content, "selected"), before, after);
    const state = createEmptyState();
    state.rootId = before.id;
    state.activeConversationId = before.id;
    state.conversations = { [before.id]: { ...after, childIds: ["child"] }, child: { ...conversation([]), id: "child", parentId: before.id,
      messages: [], branchAnchor: { ...saved, sourceMessageId: saved.sourceMessageId!, startOffset: saved.startOffset!, endOffset: saved.endOffset!, quote: saved.quote!, sourceConversationId: before.id, prompt: "Discuss", createdAt: now } } };
    const json = createAppStateFromWorkspaceDocument(createWorkspaceDocument(state))!;
    const markdown = createMarkdownWorkspace(json, now);
    const restored = parseMarkdownWorkspace(markdown.manifest, markdown.files)!;
    expect(restored.conversations.child.branchAnchor).toEqual(state.conversations.child.branchAnchor);
  });
});
