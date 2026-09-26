import { describe, expect, test } from "bun:test";
import {
  createAppStateFromWorkspaceDocument, createMarkdownWorkspace, createWorkspaceDocument,
  normalizeEditableDocument, parseMarkdownWorkspace,
  type AppState, type Conversation, type DocumentLink,
} from "@margin-chat/workspace-contracts";
import { createEmptyState, createMainConversation } from "../client/src/initialState";
import { hydratePersistedState } from "../client/src/lib/appState";
import { getEditableDocument, insertDocumentBlock, removeDocumentBlock, updateDocumentBlock } from "../client/src/lib/editableDocument";
import { addDocumentLink, createDocumentLink, getDocumentLinkTarget, remapDocumentLinks, removeDocumentLink } from "../client/src/lib/documentLinks";
import { normalizeAppState } from "../server/db/validation.mjs";
import { readState, writeState } from "../server/db/repository.mjs";
import { createCaptureTestDatabase } from "./helpers/captureDatabase.mjs";

const now = "2026-09-25T12:00:00.000Z";
const later = "2026-09-25T13:00:00.000Z";
function conversation(id: string, content: string): Conversation {
  return { ...createMainConversation({ id, createdAt: now }), title: id,
    messages: [{ id: `${id}-answer`, role: "assistant", content, createdAt: now }] };
}
function fixture(): { state: AppState; source: Conversation; target: Conversation; link: DocumentLink } {
  const original = conversation("source", "Before selected after");
  const target = conversation("target", "# Target heading\n\nExisting block content.");
  const link = createDocumentLink(original, target, { messageId: "source-answer", sourceBlockId: "message:source-answer",
    startOffset: 7, endOffset: 15, quote: "selected" }, undefined, { id: "user-edge", createdAt: now })!;
  const source = addDocumentLink(original, link);
  const state = { ...createEmptyState(), rootId: source.id, activeConversationId: source.id,
    conversations: { [source.id]: source, [target.id]: target } };
  return { state, source, target, link };
}

describe("document passage links", () => {
  test("links an existing document or block without modifying branch relationships or history", () => {
    const { source, target, link } = fixture();
    expect(source.parentId).toBeNull();
    expect(source.childIds).toEqual([]);
    expect(source.branchAnchor).toBeNull();
    expect(source.messages).toEqual(conversation("source", "Before selected after").messages);
    expect(getDocumentLinkTarget(link, { target })).toEqual({ conversation: target });
    const targetBlock = getEditableDocument(target).blocks[1];
    const toBlock = createDocumentLink(source, target, { messageId: link.sourceMessageId, ...link }, targetBlock.id)!;
    expect(getDocumentLinkTarget(toBlock, { target })).toEqual({ conversation: target, block: targetBlock });
    const withinDocument = createDocumentLink(source, source, { messageId: link.sourceMessageId, ...link }, "message:source-answer");
    expect(withinDocument?.targetConversationId).toBe(source.id);
    expect(addDocumentLink(source, { ...link, id: "duplicate" })).toBe(source);
    expect(removeDocumentLink(source, "missing")).toBe(source);
    expect(removeDocumentLink(source, link.id).document!.links).toEqual([]);
  });

  test("rejects stale source selections and missing targets at confirmation and navigation", () => {
    const { source, target, link } = fixture();
    const selection = { messageId: link.sourceMessageId, ...link };
    expect(createDocumentLink(source, undefined, selection)).toBeNull();
    expect(createDocumentLink(source, target, selection, "missing")).toBeNull();
    expect(createDocumentLink(source, target, { ...selection, startOffset: 0 })).toBeNull();
    expect(createDocumentLink(source, target, { ...selection, endOffset: Infinity })).toBeNull();
    expect(createDocumentLink(source, target, { ...selection, quote: "changed" })).toBeNull();
    const edited = updateDocumentBlock(source, "message:source-answer", "Before replaced after", later);
    expect(createDocumentLink(edited, target, selection)).toBeNull();
    expect(addDocumentLink(edited, { ...link, id: "stale" })).toBe(edited);
    expect(getDocumentLinkTarget(link, {})).toBeNull();
    expect(getDocumentLinkTarget({ ...link, targetConversationId: "toString" }, {})).toBeNull();
    expect(getDocumentLinkTarget({ ...link, targetBlockId: "missing" }, { target })).toBeNull();
  });

  test("remaps surviving source offsets and moves the source to its split block", () => {
    const { source, link } = fixture();
    const edited = remapDocumentLinks(source, updateDocumentBlock(source, "message:source-answer", "New Before selected after", later));
    expect(edited.document!.links![0]).toEqual({ ...link, startOffset: 11, endOffset: 19 });
    const split = insertDocumentBlock(source, { id: "inserted", kind: "markdown", content: "A new paragraph", createdAt: later, updatedAt: later },
      { blockId: "message:source-answer", offset: 7 }, later);
    const remapped = remapDocumentLinks(source, split).document!.links![0];
    expect(remapped.sourceBlockId).toBe(split.document!.blocks[2].id);
    expect(remapped.startOffset).toBe(0);
    expect(remapped.endOffset).toBe(8);
    expect(remapped.targetConversationId).toBe(link.targetConversationId);
    expect(remapDocumentLinks(source, source)).toBe(source);
  });

  test("retains deleted passages as detached history instead of borrowing unrelated matching text", () => {
    const { source, link } = fixture();
    const edited = remapDocumentLinks(source, updateDocumentBlock(source, "message:source-answer", "Replaced completely", later));
    expect(edited.document!.links![0]).toEqual({ ...link, sourceBlockId: "detached:message:source-answer" });
    const deleted = remapDocumentLinks(source, removeDocumentBlock(source, "message:source-answer", later));
    expect(deleted.document!.links![0]).toEqual({ ...link, sourceBlockId: "detached:message:source-answer" });
    const restoredText = updateDocumentBlock(edited, "message:source-answer", "Before selected after", later);
    expect(remapDocumentLinks(edited, restoredText).document!.links![0].sourceBlockId).toStartWith("detached:");
    expect(normalizeEditableDocument(deleted.document)!.links).toEqual(deleted.document!.links);
  });

  test("preserves links through local hydration, workspace snapshots, Markdown vaults and cloud validation", () => {
    const { state, source, target, link } = fixture();
    const blockLink = { ...link, id: "block-edge", targetBlockId: getEditableDocument(target).blocks[1].id };
    state.conversations[source.id] = addDocumentLink(source, blockLink);
    const markdown = createMarkdownWorkspace(state, now);
    const copies = [hydratePersistedState(state), createAppStateFromWorkspaceDocument(createWorkspaceDocument(state)),
      parseMarkdownWorkspace(markdown.manifest, markdown.files)];
    for (const copy of copies) expect(copy?.conversations[source.id].document?.links).toEqual([link, blockLink]);
    expect(normalizeAppState(state).conversations.find((entry: Conversation) => entry.id === source.id).document.links).toEqual([link, blockLink]);
    expect(normalizeEditableDocument(source.document)!.links![0]).not.toBe(link);
  });

  test("validates link metadata without dropping authored content or detached references", () => {
    const { source, link } = fixture();
    for (const links of [null, {}, [link, link], [{ ...link, startOffset: -1 }], [{ ...link, endOffset: 0 }],
      [{ ...link, targetConversationId: "" }], [{ ...link, createdAt: "bad" }], [{ ...link, quote: "" }]]) {
      expect(normalizeEditableDocument({ ...source.document!, links })).toBeUndefined();
    }
    const legacy = { ...source.document! };
    delete legacy.links;
    expect(normalizeEditableDocument(legacy)?.links).toBeUndefined();
  });

  test("existing JSON database projection persists links without a schema migration", async () => {
    const db = await createCaptureTestDatabase();
    try {
      await db.client.query("insert into marginchat_users (id,email,password_hash,display_name) values ($1,$2,'unused','Links')", ["link-user", "links@example.test"]);
      const { state, source, target, link } = fixture();
      const blockLink = { ...link, id: "block-edge", targetBlockId: getEditableDocument(target).blocks[1].id };
      state.conversations[source.id] = addDocumentLink(source, blockLink);
      await writeState(db.client, "link-user", normalizeAppState(state));
      const restored = await readState(db.client, "link-user");
      expect(restored.conversations[source.id].document.links).toEqual([link, blockLink]);
      expect(restored.conversations[target.id].parentId).toBeNull();
      restored.conversations[source.id] = removeDocumentLink(restored.conversations[source.id], link.id);
      await writeState(db.client, "link-user", normalizeAppState(restored));
      expect((await readState(db.client, "link-user")).conversations[source.id].document.links).toEqual([blockLink]);
    } finally { await db.pg.close(); }
  }, 30_000);
});
