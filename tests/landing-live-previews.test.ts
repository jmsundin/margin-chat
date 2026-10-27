import { expect, test } from "bun:test";
import { addDemoSideDocument, createDemoVault, DEMO_MAIN_DOCUMENT_ID } from "../client/src/lib/demoVault";
import { getAnchorsByMessageId } from "../client/src/lib/documentAnchorLinks";
import type { SelectionDraft } from "../client/src/types";

const quote = "check a claim against a source";

// The editor reports a passage in a document block as message `document:<blockId>`.
function selectionInMainDocument(): SelectionDraft {
  const vault = createDemoVault();
  const block = vault.conversations[DEMO_MAIN_DOCUMENT_ID].document!.blocks[1];
  const startOffset = block.content.indexOf(quote);
  return {
    conversationId: DEMO_MAIN_DOCUMENT_ID, messageId: `document:${block.id}`, sourceBlockId: block.id, quote,
    startOffset, endOffset: startOffset + quote.length, prompt: "", rect: { left: 0, top: 0, width: 0, height: 0 },
  };
}

test("the sample vault is a small connected set of notes", () => {
  const vault = createDemoVault();
  const ids = Object.keys(vault.conversations);
  expect(ids.length).toBeGreaterThan(5);
  for (const conversation of Object.values(vault.conversations)) {
    for (const childId of conversation.childIds) expect(vault.conversations[childId]?.parentId).toBe(conversation.id);
    for (const linkedId of conversation.linkedConversationIds ?? []) expect(ids).toContain(linkedId);
  }
  // Each visitor gets a fresh copy, so one tab's edits never leak into another render.
  expect(createDemoVault()).not.toBe(vault);
});

test("creating a side document from a selection adds an anchored child", () => {
  const vault = createDemoVault();
  const next = addDemoSideDocument(vault, selectionInMainDocument(), "Literacy and printing fed each other", "demo-side-1", "2026-10-11T20:00:00.000Z");
  const side = next.conversations["demo-side-1"];
  expect(side).toBeDefined();
  expect(side.parentId).toBe(DEMO_MAIN_DOCUMENT_ID);
  expect(side.kind).toBe("note");
  expect(side.document?.marginNote).toBeUndefined();
  expect(side.branchAnchor?.prompt).toBe("Side document");
  expect(next.conversations[DEMO_MAIN_DOCUMENT_ID].childIds).toContain("demo-side-1");
  const anchors = Object.values(getAnchorsByMessageId(next.conversations, DEMO_MAIN_DOCUMENT_ID)).flat();
  expect(anchors.some((link) => link.anchor.quote === quote)).toBe(true);
  // The original vault is untouched.
  expect(vault.conversations["demo-side-1"]).toBeUndefined();
});

test("a side document without a note quotes the passage", () => {
  const next = addDemoSideDocument(createDemoVault(), selectionInMainDocument(), "  ", "demo-side-2", "2026-10-11T20:00:00.000Z");
  const text = next.conversations["demo-side-2"].document!.blocks.map((block) => block.content).join("\n");
  expect(text).toContain(quote);
});
