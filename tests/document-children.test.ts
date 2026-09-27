import { expect, test } from "bun:test";
import { createMainConversation, createSideConversation } from "../client/src/initialState";
import { getDocumentChildrenByParent } from "../client/src/lib/documentWorkspace";
import { getEditableDocument } from "../client/src/lib/editableDocument";
import type { DocumentLink } from "../client/src/types";

function link(targetConversationId: string, id = targetConversationId, targetBlockId?: string): DocumentLink {
  return { id, targetConversationId, ...(targetBlockId ? { targetBlockId } : {}), sourceMessageId: "source", quote: "passage", startOffset: 0, endOffset: 7, createdAt: "2026-09-27T12:00:00Z" };
}

test("Children combines direct and linked documents once, skips missing/self targets, and handles reciprocal links", () => {
  const source = createMainConversation({ id: "source" });
  const branch = createSideConversation({ id: "branch", sourceConversation: source });
  source.childIds = [branch.id];
  const target = createMainConversation({ id: "target" });
  target.document = getEditableDocument(target);
  const block = target.document.blocks[0];
  source.document = { ...getEditableDocument(source), links: [
    link(target.id), link(target.id, "second-passage"), link(target.id, "block-link", block.id),
    link(branch.id), link(source.id), link("missing"), link("toString"),
  ] };
  target.document.links = [link(source.id)];
  const conversations = { source, branch, target };
  const before = JSON.stringify(conversations);
  const children = getDocumentChildrenByParent(conversations);
  expect(children.get(source.id)?.map(document => document.id)).toEqual(["branch", "target"]);
  expect(children.get(target.id)?.map(document => document.id)).toEqual(["source"]);
  expect(children.has(branch.id)).toBe(false);
  expect(JSON.stringify(conversations)).toBe(before);
  source.document.links = [];
  expect(getDocumentChildrenByParent(conversations).get(source.id)?.map(document => document.id)).toEqual(["branch"]);
});

test("links to unavailable blocks are excluded, and direct parent metadata survives a stale child index", () => {
  const source = createMainConversation({ id: "source" });
  const branch = createSideConversation({ id: "branch", sourceConversation: source });
  const target = createMainConversation({ id: "target" });
  source.document = { ...getEditableDocument(source), links: [link(target.id, "removed-block", "missing-block")] };
  expect(getDocumentChildrenByParent({ source, branch, target }).get(source.id)?.map(document => document.id)).toEqual(["branch"]);
});
