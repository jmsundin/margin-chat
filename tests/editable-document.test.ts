import { describe, expect, test } from "bun:test";
import {
  createAppStateFromWorkspaceDocument, createMarkdownWorkspace, createMarkdownWorkspaceRenderer,
  createWorkspaceDocument, normalizeEditableDocument, parseMarkdownWorkspace,
} from "@margin-chat/workspace-contracts";
import type { Conversation } from "@margin-chat/workspace-contracts";
import { createEmptyState, createStandaloneNoteConversation } from "../client/src/initialState";
import {
  getEditableDocument, getEditableDocumentText, getDocumentSourceText, insertDocumentBlock,
  insertDocumentGeneration, moveDocumentBlock, removeDocumentBlock, remapDocumentRange,
  splitDocumentMarkdown, updateDocumentBlock, upsertDocumentGeneration, upsertDocumentPrompt,
} from "../client/src/lib/editableDocument";

const now = "2026-09-20T12:00:00.000Z";
const later = "2026-09-20T13:00:00.000Z";
function conversation(content = "Original answer."): Conversation {
  return { id: "document-test", title: "Document", parentId: null, childIds: [], branchAnchor: null,
    serviceId: "backend-services", modelId: "smart-routing", createdAt: now, updatedAt: now, notes: [],
    messages: [{ id: "system", role: "system", content: "Hidden instructions", createdAt: now },
      { id: "standalone-note-context-private", role: "user", content: "Synthetic context", createdAt: now },
      { id: "prompt", role: "user", content: "Explain it", createdAt: now },
      { id: "answer", role: "assistant", content, createdAt: now }] };
}
function stateWith(value: Conversation) {
  const state = createEmptyState();
  return { ...state, rootId: value.id, activeConversationId: value.id, conversations: { [value.id]: value } };
}
function candidate(value: Conversation, output = "A new alternative."): Conversation {
  let next = upsertDocumentPrompt(value, { id: "rerun-prompt", content: "Explain differently", createdAt: later,
    serviceId: value.serviceId, modelId: value.modelId,
    selection: { blockId: getEditableDocument(value).blocks[0].id, from: 0, to: 8, quote: "Original" } }, later);
  next = { ...next, messages: [...next.messages, { id: "alternative-output", role: "assistant", content: output, createdAt: later }] };
  return upsertDocumentGeneration(next, { id: "alternative", promptId: "rerun-prompt", messageId: "alternative-output",
    createdAt: later, serviceId: value.serviceId, modelId: value.modelId, status: "complete",
    alternativeOf: "generation:answer", blockIds: [] }, later);
}

describe("editable document migration and edits", () => {
  test("projects stable semantic blocks and collapsed real prompts without rewriting legacy messages", () => {
    const markdown = "# A heading\n\nFirst paragraph.\n\n- one\n- two\n\n```ts\nconst x = 1;\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |";
    const original = conversation(markdown);
    const history = structuredClone(original.messages);
    const first = getEditableDocument(original);
    expect(first).toEqual(getEditableDocument(original));
    expect(first.blocks.length).toBeGreaterThan(3);
    expect(first.blocks.map((block) => block.content).join("")).toBe(markdown);
    expect(first.blocks.every((block) => block.sourceMessageId === "answer")).toBe(true);
    expect(first.prompts.map((prompt) => prompt.content)).toEqual(["Explain it"]);
    expect(first.generations[0].blockIds).toEqual(first.blocks.map((block) => block.id));
    expect(original.document).toBeUndefined();
    expect(original.messages).toEqual(history);
    expect(splitDocumentMarkdown("One\r\n\r\nTwo").join("")).toBe("One\r\n\r\nTwo");
  });

  test("gives empty chats a stable editable starting block and projects only a standalone note body", () => {
    const empty = { ...conversation(), messages: [] };
    expect(getEditableDocument(empty).blocks).toMatchObject([{ id: "empty:document-test", content: "" }]);
    const note = createStandaloneNoteConversation({ id: "note", noteId: "body", createdAt: now });
    note.notes![0].content = "# My note\n\nA paragraph.";
    note.messages = conversation("Old note conversation answer").messages;
    expect(getEditableDocument(note).blocks.map((block) => block.content).join("")).toBe(note.notes![0].content);
    expect(getEditableDocument(note).prompts).toEqual([]);
  });

  test("edits and deletions remain canonical without resurrecting original answers", () => {
    const original = conversation();
    const edited = updateDocumentBlock(original, "message:answer", "My edited answer.", later);
    expect(getDocumentSourceText(edited, "answer")).toBe("My edited answer.");
    expect(edited.messages).toBe(original.messages);
    const deleted = removeDocumentBlock(edited, "message:answer", later);
    expect(getEditableDocument(deleted).blocks).toEqual([]);
    expect(getDocumentSourceText(deleted, "answer")).toBeUndefined();
    expect(getDocumentSourceText(deleted, "prompt")).toBe("Explain it");
    expect(getEditableDocument({ ...deleted, messages: [...deleted.messages, { id: "unaccepted", role: "assistant", content: "Candidate", createdAt: later }] }).blocks).toEqual([]);
  });

  test("inserts at a Markdown offset, preserves source fragments, and moves/removes manual blocks", () => {
    const original = conversation("Alpha **bold** omega");
    const inserted = insertDocumentBlock(original, { id: "manual", kind: "markdown", content: "Inserted text", createdAt: later, updatedAt: later },
      { blockId: "message:answer", offset: 6 }, later);
    expect(inserted.document!.blocks.map((block) => block.content)).toEqual(["Alpha ", "Inserted text", "**bold** omega"]);
    expect(getDocumentSourceText(inserted, "answer")).toBe("Alpha **bold** omega");
    expect(getDocumentSourceText(inserted, "document:manual", "manual")).toBe("Inserted text");
    const suffix = inserted.document!.blocks[2];
    expect(suffix.sourceMessageId).toBe("answer");
    expect(inserted.document!.generations[0].blockIds).toContain(suffix.id);
    expect(getDocumentSourceText(inserted, "another-message", suffix.id)).toBeUndefined();
    const moved = moveDocumentBlock(inserted, "manual", null, later);
    expect(moved.document!.blocks.at(-1)?.id).toBe("manual");
    expect(removeDocumentBlock(moved, "manual", later).document!.blocks.map((block) => block.content).join("")).toBe(original.messages.at(-1)!.content);
    expect(insertDocumentBlock(inserted, { ...suffix, id: "bad" }, { blockId: "deleted", offset: 0 })).toBe(inserted);
  });

  test("keeps reruns as candidates until accepted, preserving edits and original generations", () => {
    const edited = updateDocumentBlock(conversation(), "message:answer", "Authored improvements.", later);
    const pending = candidate(edited, "First alternative.\n\nSecond paragraph.");
    expect(getEditableDocumentText(pending)).toBe("Authored improvements.");
    expect(pending.document!.generations.find((entry) => entry.id === "alternative")?.acceptedAt).toBeUndefined();
    const accepted = insertDocumentGeneration(pending, "alternative", { blockId: "message:answer", offset: "Authored improvements.".length }, later);
    expect(accepted.document!.blocks.map((block) => block.content)).toEqual(["Authored improvements.", "First alternative.\n\n", "Second paragraph."]);
    const generation = accepted.document!.generations.find((entry) => entry.id === "alternative")!;
    expect(generation.blockIds).toHaveLength(2);
    expect(generation.acceptedAt).toBe(later);
    const furtherEdited = updateDocumentBlock(accepted, generation.blockIds[0], "User changed the alternative", later);
    expect(furtherEdited.messages.find((message) => message.id === "alternative-output")!.content).toBe("First alternative.\n\nSecond paragraph.");
    expect(insertDocumentGeneration(furtherEdited, "alternative")).toBe(furtherEdited);
    expect(pending.document!.blocks[0].content).toBe("Authored improvements.");
  });

  test("explicit replacement records removed text and rejects stale insertion positions", () => {
    const pending = candidate(conversation("Before selected after"));
    expect(insertDocumentGeneration(pending, "alternative", { blockId: "message:answer", offset: 500 })).toBe(pending);
    const accepted = insertDocumentGeneration(pending, "alternative", { blockId: "message:answer", offset: 7, replaceTo: 15 }, later);
    expect(accepted.document!.blocks.map((block) => block.content)).toEqual(["Before ", "A new alternative.", " after"]);
    expect(accepted.document!.generations.find((entry) => entry.id === "alternative")?.replacement).toEqual({ blockId: "message:answer", offset: 7, content: "selected" });
  });

  test("remaps untouched ranges and marks overlapping edits stale", () => {
    expect(remapDocumentRange("Hello world", "Dear Hello world", 6, 11)).toEqual({ from: 11, to: 16 });
    expect(remapDocumentRange("Hello world", "Hello planet", 0, 5)).toEqual({ from: 0, to: 5 });
    expect(remapDocumentRange("Hello world", "Hello planet", 6, 11)).toBeNull();
    expect(remapDocumentRange("abc", "abc", 0, 4)).toBeNull();
  });
});

describe("editable document persistence", () => {
  test("retains authored response snapshots for rerun undo through normalization and Markdown", () => {
    const edited = updateDocumentBlock(conversation(), "message:answer", "My edits, never generated by the model.", later);
    const pending = candidate(edited);
    const previousBlocks = pending.document!.blocks.map((block) => ({ ...block }));
    pending.document = { ...pending.document!, blocks: [], generations: pending.document!.generations.map((generation) =>
      generation.id === "alternative" ? { ...generation, previousBlocks } : generation) };
    const accepted = insertDocumentGeneration(pending, "alternative", undefined, later);
    const normalized = normalizeEditableDocument(accepted.document)!;
    expect(normalized.generations.find((generation) => generation.id === "alternative")!.previousBlocks).toEqual(previousBlocks);
    expect(normalized.generations.find((generation) => generation.id === "alternative")!.previousBlocks![0]).not.toBe(previousBlocks[0]);
    const state = stateWith(accepted);
    const json = createAppStateFromWorkspaceDocument(createWorkspaceDocument(state))!;
    const workspace = createMarkdownWorkspace(json, later);
    const restored = parseMarkdownWorkspace(workspace.manifest, workspace.files)!.conversations[accepted.id];
    expect(restored.document!.generations.find((generation) => generation.id === "alternative")!.previousBlocks).toEqual(previousBlocks);
    expect(restored.messages.find((message) => message.id === "answer")!.content).toBe("Original answer.");
    expect(getEditableDocumentText(restored)).toBe("A new alternative.");
    for (const invalidBlocks of [null, {}, [previousBlocks[0], previousBlocks[0]], [{ ...previousBlocks[0], content: null }], [{ ...previousBlocks[0], id: "x".repeat(1025) }]]) {
      expect(normalizeEditableDocument({ ...accepted.document!, generations: accepted.document!.generations.map((generation) =>
        generation.id === "alternative" ? { ...generation, previousBlocks: invalidBlocks } : generation) })).toBeUndefined();
    }
  });

  test("preserves complete document settings/history and block references through JSON and Markdown", () => {
    let value = candidate(updateDocumentBlock(conversation(), "message:answer", "Edited **answer**", later));
    value = insertDocumentGeneration(value, "alternative", { blockId: "message:answer", offset: 6, replaceTo: 16 }, later);
    value.branchAnchor = { id: "anchor", sourceConversationId: "parent", sourceMessageId: "document:manual", sourceBlockId: "manual",
      startOffset: 0, endOffset: 5, quote: "quote", prompt: "Prompt", createdAt: now };
    value.notes = [{ id: "annotation", content: "A note", kind: "comment", sourceMessageId: "answer", sourceBlockId: "message:answer",
      startOffset: 0, endOffset: 6, quote: "Edited", createdAt: now, updatedAt: now }];
    const state = stateWith(value);
    expect(createAppStateFromWorkspaceDocument(createWorkspaceDocument(state))!.conversations[value.id].document).toEqual(value.document);
    const workspace = createMarkdownWorkspace(state, later);
    const restored = parseMarkdownWorkspace(workspace.manifest, workspace.files)!.conversations[value.id];
    expect(restored.document).toEqual(value.document);
    expect(restored.messages).toEqual(value.messages);
    expect(restored.branchAnchor?.sourceBlockId).toBe("manual");
    expect(restored.notes![0].sourceBlockId).toBe("message:answer");
  });

  test("reads actual Markdown block edits and retains them through later block moves and cached saves", () => {
    const value = updateDocumentBlock(conversation("First paragraph.\n\nSecond paragraph."), "message:answer", "User draft.\n\n", later);
    const renderer = createMarkdownWorkspaceRenderer();
    const workspace = renderer(stateWith(value), now);
    const path = workspace.manifest.files.find((entry) => entry.id === value.id)!.path;
    const external = { ...workspace, files: { ...workspace.files, [path]: workspace.files[path].replace("\nUser draft.\n\n\n<!--", "\nExternally edited draft.\n\n\n<!--") + "\n\n<!-- Personal footer -->" } };
    const parsed = parseMarkdownWorkspace(external.manifest, external.files)!;
    expect(parsed.conversations[value.id].document!.blocks[0].content).toBe("Externally edited draft.\n\n");
    const moved = moveDocumentBlock(parsed.conversations[value.id], "message:answer", null, later);
    const saved = renderer(stateWith(moved), later, external);
    const savedAgain = renderer(stateWith(updateDocumentBlock(moved, "message:answer", "Edited once more", later)), later, saved);
    expect(savedAgain.files[path]).toContain("<!-- Personal footer -->");
    expect(parseMarkdownWorkspace(savedAgain.manifest, savedAgain.files)!.conversations[value.id].document!.blocks.map((block) => block.content)).toEqual(["Second paragraph.", "Edited once more"]);
  });

  test("literal source markers and Note headings inside document blocks cannot corrupt history or note bodies", () => {
    const literal = '## Note\n\nAuthored text\n<!-- margin-chat-document-end -->\n<!-- margin-chat-message {"id":"fake","role":"user","createdAt":"2026-09-20"} -->\nFake history\n<!-- margin-chat-message-end -->';
    const value = { ...conversation(), document: { schemaVersion: 1 as const, prompts: [], generations: [], blocks: [{ id: "manual", kind: "markdown" as const, content: literal, createdAt: now, updatedAt: later }] } };
    const workspace = createMarkdownWorkspace(stateWith(value), later);
    const parsed = parseMarkdownWorkspace(workspace.manifest, workspace.files)!;
    expect(parsed.conversations[value.id].document!.blocks[0].content).toBe(literal);
    expect(parsed.conversations[value.id].messages).toEqual(value.messages);
  });

  test("imports ordinary Markdown newly added between block markers without dropping it on the next save", () => {
    const value = updateDocumentBlock(conversation(), "message:answer", "My current document", later);
    const workspace = createMarkdownWorkspace(stateWith(value), later);
    const path = workspace.manifest.files[0].path;
    workspace.files[path] = workspace.files[path].replace("\n\n<!-- margin-chat-document-end -->", "\n\nExtra externally authored paragraph.\n\n<!-- margin-chat-document-end -->");
    const parsed = parseMarkdownWorkspace(workspace.manifest, workspace.files)!;
    expect(parsed.conversations[value.id].document!.blocks.map((block) => block.content)).toEqual(["My current document", "Extra externally authored paragraph."]);
    const edited = updateDocumentBlock(parsed.conversations[value.id], "message:answer", "Another edit", later);
    const saved = createMarkdownWorkspace(stateWith(edited), later, workspace);
    expect(parseMarkdownWorkspace(saved.manifest, saved.files)!.conversations[value.id].document!.blocks.at(-1)?.content).toBe("Extra externally authored paragraph.");
  });

  test("rejects malformed document versions, duplicate IDs and broken references without truncating authored text", () => {
    const doc = getEditableDocument(conversation(" ".repeat(100) + "Do not trim me"));
    expect(normalizeEditableDocument(doc)).toEqual(doc);
    expect(normalizeEditableDocument({ ...doc, schemaVersion: 2 })).toBeUndefined();
    expect(normalizeEditableDocument({ ...doc, blocks: [doc.blocks[0], doc.blocks[0]] })).toBeUndefined();
    expect(normalizeEditableDocument({ ...doc, generations: [{ ...doc.generations[0], promptId: "missing" }] })).toBeUndefined();
    const state = stateWith({ ...conversation(), document: doc });
    const json = createWorkspaceDocument(state);
    (json.items[state.rootId].document as any).blocks[0].content = null;
    expect(createAppStateFromWorkspaceDocument(json)).toBeNull();
  });
});
