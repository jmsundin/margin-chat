import { describe, expect, test } from "bun:test";
import { createChildConversation, createMainConversation, createStandaloneNoteConversation } from "../client/src/initialState";
import { getEditableDocument, insertDocumentBlock, removeDocumentBlock, updateDocumentBlock } from "../client/src/lib/editableDocument";
import { getCurrentDocumentText, getPrimaryDocumentSources } from "../client/src/lib/documentSources";
import { buildSearchExploration } from "../client/src/lib/searchExploration";
import { buildSearchResults, buildThreadSummaries } from "../client/src/lib/conversationSearch";
import { normalizeEvidence, resolveGraphEvidence, searchGraphSources } from "../client/src/lib/graphExploration";
import { getConversationRequestPayload } from "../client/src/lib/chatContext";
import { prepareAIContext } from "../client/src/lib/aiContext";
import { buildEditableDocumentOutline, groupChatOutline } from "../client/src/lib/chatOutline";
import { buildJevSearchSnapshot } from "../client/src/lib/jevSearch";
import { buildJevWorkspaceSnapshot } from "../client/src/lib/jevAssistance";

function fixture() {
  let chat = createMainConversation({ id: "chat", createdAt: "2026-09-20T00:00:00Z" });
  chat.title = "Reading project";
  chat.messages = [
    { id: "prompt", role: "user", content: "Plan the reader", createdAt: chat.createdAt },
    { id: "response", role: "assistant", content: "OBSOLETE response", createdAt: chat.createdAt },
    { id: "removed", role: "assistant", content: "DELETED old alternative", createdAt: chat.createdAt },
  ];
  chat = updateDocumentBlock(chat, "message:response", "# Current heading\n\nCURRENT edited decision.");
  chat = removeDocumentBlock(chat, "message:removed");
  const note = createStandaloneNoteConversation({ id: "note", noteId: "body" });
  chat.notes = [{ ...note.notes![0], id: "private", kind: "comment", content: "PRIVATE MARGIN" }];
  return { chat, note, conversations: { chat, note } };
}

describe("current editable document readers", () => {
  test("searches and previews edited blocks without resurrecting history or changing identity", () => {
    const { chat, conversations } = fixture();
    const before = structuredClone(conversations);
    for (const query of ["OBSOLETE", "DELETED"]) {
      expect(buildSearchResults(conversations, query)).toEqual([]);
      expect(buildSearchExploration({ conversations, query }).results).toEqual([]);
      expect(searchGraphSources(conversations, query)).toEqual([]);
    }
    const result = buildSearchExploration({ conversations, query: "CURRENT edited" }).results[0];
    expect(result.evidence).toMatchObject({ sourceKind: "document", sourceBlockId: "message:response", messageId: "response" });
    expect(result.passage).toBe("CURRENT edited decision.");
    expect(buildThreadSummaries(conversations).find((item) => item.id === chat.id)?.preview).toContain("CURRENT");
    expect(buildSearchResults(conversations, "CURRENT")[0].matchLabel).toBe("Document passage");
    expect(buildSearchExploration({ conversations, query: "PRIVATE" }).results[0].localOnly).toBe(true);
    expect(searchGraphSources(conversations, "PRIVATE")).toEqual([]);
    expect(conversations).toEqual(before);
    expect(chat.kind).toBe("chat");
    expect(chat.messages[1].content).toContain("OBSOLETE");
  });

  test("resolves legacy references against current content and marks deleted sources missing", () => {
    const { conversations } = fixture();
    expect(resolveGraphEvidence(conversations, { conversationId: "chat", sourceKind: "message", messageId: "response", quote: "OBSOLETE response" }).status).toBe("stale");
    expect(resolveGraphEvidence(conversations, { conversationId: "chat", sourceKind: "message", messageId: "removed" }).status).toBe("missing");
    const source = { conversationId: "chat", sourceKind: "document" as const, sourceBlockId: "message:response", quote: "CURRENT", startOffset: 0, endOffset: 7 };
    const normalized = normalizeEvidence(source)!;
    expect(normalized.sourceBlockId).toBe("message:response");
    expect(resolveGraphEvidence(conversations, normalized)).toMatchObject({ status: "recovered", highlight: { startOffset: 19, endOffset: 26 } });
    expect(normalizeEvidence({ conversationId: "chat", sourceKind: "document" })).toBeNull();
  });

  test("split blocks have unique search and outline targets while old message text resolves in order", () => {
    const { chat } = fixture();
    const block = chat.document!.blocks[0];
    const split = insertDocumentBlock(chat, { id: "manual", kind: "markdown", content: "## Authored idea\n\nA new thought.", createdAt: chat.createdAt, updatedAt: chat.updatedAt }, { blockId: block.id, offset: 19 });
    const sources = getPrimaryDocumentSources(split);
    expect(sources).toHaveLength(3);
    const outline = buildEditableDocumentOutline(split);
    expect(new Set(outline.map((item) => item.id)).size).toBe(outline.length);
    expect(outline.some((item) => item.id === "heading-document:manual-0" && item.label === "Authored idea")).toBe(true);
    expect(outline.filter((item) => item.kind === "response").map((item) => item.id)).toEqual(split.document!.blocks.map((item) => `message-document:${item.id}`));
    const old = resolveGraphEvidence({ chat: split }, { conversationId: "chat", sourceKind: "message", messageId: "response" });
    expect(old.content).toBe(block.content);
    expect(getCurrentDocumentText(split)).toContain("A new thought.");
  });

  test("uses current standalone document content and never the pre-edit note body", () => {
    let { note } = fixture();
    note.notes![0].content = "OLD NOTE BODY";
    note = updateDocumentBlock(note, "note:body", "# Edited note\n\nNEW NOTE BODY");
    const conversations = { note };
    expect(buildSearchExploration({ conversations, query: "OLD" }).results).toEqual([]);
    expect(buildSearchResults(conversations, "OLD")).toEqual([]);
    expect(buildThreadSummaries(conversations)[0].preview).toContain("NEW");
    expect(resolveGraphEvidence(conversations, { conversationId: "note", sourceKind: "standalone-note", noteId: "body" }).content).toContain("NEW");
    const empty = removeDocumentBlock(note, "note:body");
    expect(getPrimaryDocumentSources(empty)).toEqual([]);
    expect(buildSearchExploration({ conversations: { note: empty }, query: "BODY" }).results).toEqual([]);
  });

  test("AI workspace, ancestor context and Jev snapshots use current permitted document text", () => {
    const { chat, conversations } = fixture();
    const child = createChildConversation({ id: "child", parentConversation: chat });
    child.ai = { mode: "balanced", contextScope: "workspace", selectedConversationIds: [] };
    const context = getConversationRequestPayload(conversations, child);
    expect(context.ancestorContext[0].messages[0].content).toBe(getCurrentDocumentText(chat));
    const workspace = prepareAIContext(conversations, child, [{ id: "question", role: "user", content: "What is current?", createdAt: child.createdAt }]);
    expect(workspace.workspaceContext.find((item) => item.id === chat.id)?.content).toContain("CURRENT");
    const search = buildSearchExploration({ conversations, query: "CURRENT" });
    const shortlist = buildJevSearchSnapshot({ conversations, query: "CURRENT", ...search, currentConversationId: chat.id })!;
    expect(shortlist.items[0].sourceKind).toBe("document");
    const organization = buildJevWorkspaceSnapshot(conversations, chat.id)!;
    for (const payload of [context, workspace, shortlist, organization]) {
      expect(JSON.stringify(payload)).toContain("CURRENT");
      expect(JSON.stringify(payload)).not.toMatch(/OBSOLETE|DELETED|PRIVATE/);
    }
  });

  test("the lazy document outline matches current renderer IDs without changing legacy storage", () => {
    const legacy = createMainConversation();
    legacy.messages = [{ id: "user", role: "user", content: "Write a plan", createdAt: legacy.createdAt }, { id: "ai", role: "assistant", content: "# Plan", createdAt: legacy.createdAt }];
    expect(buildEditableDocumentOutline(legacy).map((item) => item.id)).toEqual(["message-user", "message-document:message:ai", "heading-document:message:ai-0"]);
    expect(legacy.document).toBeUndefined();
    expect(getEditableDocument(legacy).blocks[0].sourceMessageId).toBe("ai");
  });

  test("accepted alternative paragraphs share one response and navigate only to the original prompt marker", () => {
    const { chat } = fixture();
    const original = chat.document!.generations[0];
    const prompt = chat.document!.prompts[0];
    chat.document!.prompts.push({ ...prompt, id: "retry-prompt", sourceMessageId: undefined }, { ...prompt, id: "accepted-prompt", sourceMessageId: undefined });
    chat.document!.generations.push(
      { ...original, id: "retry", promptId: "retry-prompt", alternativeOf: original.id, acceptedAt: undefined, blockIds: [] },
      { ...original, id: "accepted", promptId: "accepted-prompt", alternativeOf: "retry", blockIds: ["first", "second", "third"] },
    );
    chat.document!.blocks = ["# Accepted plan", "A practical next step.", "## Follow through"].map((content, index) => ({
      id: ["first", "second", "third"][index], kind: "markdown", content, generationId: "accepted", createdAt: chat.createdAt, updatedAt: chat.updatedAt,
    }));
    const outline = buildEditableDocumentOutline(chat);
    expect(outline.filter((item) => item.kind === "prompt").map((item) => item.id)).toEqual(["message-prompt"]);
    const responses = outline.filter((item) => item.kind === "response");
    expect(responses).toHaveLength(1);
    expect(responses[0].memberIds).toEqual(["message-document:first", "message-document:second", "message-document:third"]);
    const grouped = groupChatOutline(outline);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].responses[0].headings.map((item) => item.id)).toEqual(["heading-document:first-0", "heading-document:third-0"]);
    expect(grouped[0].headings).toEqual([]);
  });
});
