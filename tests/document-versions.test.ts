import { describe, expect, test } from "bun:test";
import type { Conversation, DocumentBlock, DocumentGeneration } from "@margin-chat/workspace-contracts";
import { normalizeEditableDocument } from "@margin-chat/workspace-contracts";
import { acceptDocumentVersion, remapDocumentReplacement, undoDocumentInsertion } from "../client/src/lib/documentVersions";
import { getEditableDocument, insertDocumentBlock, insertDocumentGeneration, updateDocumentBlock, upsertDocumentGeneration, upsertDocumentPrompt } from "../client/src/lib/editableDocument";

const now = "2026-09-20T12:00:00.000Z";
const later = "2026-09-20T13:00:00.000Z";
function fixture(): Conversation {
  const conversation: Conversation = { id: "versions", title: "Versions", serviceId: "backend-services", modelId: "smart-routing",
    parentId: null, childIds: [], branchAnchor: null, createdAt: now, updatedAt: now,
    messages: [{ id: "prompt", role: "user", content: "Write a response", createdAt: now },
      { id: "original", role: "assistant", content: "Original response", createdAt: now }] };
  return { ...conversation, document: getEditableDocument(conversation) };
}
function candidate(conversation: Conversation, id: string, content: string, status: DocumentGeneration["status"] = "complete", alternativeOf = "generation:original"): Conversation {
  let next = upsertDocumentPrompt(conversation, { id: `prompt:${id}`, content: `Rerun ${id}`, createdAt: later, serviceId: conversation.serviceId, modelId: conversation.modelId }, later);
  next = { ...next, messages: [...next.messages, { id: `message:${id}`, role: "assistant", content, createdAt: later }] };
  return upsertDocumentGeneration(next, { id, promptId: `prompt:${id}`, messageId: `message:${id}`, createdAt: later,
    serviceId: conversation.serviceId, modelId: conversation.modelId, status, alternativeOf, blockIds: [] }, later);
}
function block(id: string, content: string): DocumentBlock {
  return { id, kind: "markdown", content, createdAt: now, updatedAt: now };
}

describe("safe document version acceptance", () => {
  test("empty, failed and streaming candidates never remove existing edited text", () => {
    const edited = updateDocumentBlock(fixture(), "message:original", "Carefully edited response", later);
    for (const [content, status] of [["", "complete"], ["  \n", "stopped"], ["Partial failure", "failed"], ["In progress", "streaming"]] as const) {
      const next = candidate(edited, "candidate", content, status);
      expect(acceptDocumentVersion(next, "candidate", later)).toBe(next);
      expect(next.document!.blocks[0].content).toBe("Carefully edited response");
    }
    const missing = candidate(edited, "candidate", "Answer");
    missing.messages = missing.messages.filter((message) => message.id !== "message:candidate");
    expect(acceptDocumentVersion(missing, "candidate", later)).toBe(missing);
  });

  test("acceptance snapshots human edits while original outputs/settings remain immutable", () => {
    const edited = updateDocumentBlock(fixture(), "message:original", "Human-authored improvement", later);
    const pending = candidate(edited, "new", "A newer response");
    const history = structuredClone(pending.messages);
    const accepted = acceptDocumentVersion(pending, "new", later);
    expect(accepted.document!.blocks.map((value) => value.content)).toEqual(["A newer response"]);
    const generation = accepted.document!.generations.find((value) => value.id === "new")!;
    expect(generation.previousBlocks).toEqual(edited.document!.blocks);
    expect(generation.previousBlocks![0]).not.toBe(edited.document!.blocks[0]);
    expect(accepted.messages).toBe(pending.messages);
    expect(accepted.messages).toEqual(history);
    expect(generation).toMatchObject({ status: "complete", acceptedAt: later, modelId: "smart-routing" });
    expect(normalizeEditableDocument(accepted.document)).toEqual(accepted.document);
    expect(acceptDocumentVersion(accepted, "new", later)).toBe(accepted);
    expect(pending.document!.blocks[0].content).toBe("Human-authored improvement");
  });

  test("a second rerun replaces the currently accepted version and supports nested undo", () => {
    const original = updateDocumentBlock(fixture(), "message:original", "Original with user edits", later);
    let first = acceptDocumentVersion(candidate(original, "first", "First alternative"), "first", later);
    first = updateDocumentBlock(first, first.document!.blocks[0].id, "First alternative with user edits", later);
    const second = acceptDocumentVersion(candidate(first, "second", "Second alternative"), "second", later);
    expect(second.document!.blocks.map((value) => value.content)).toEqual(["Second alternative"]);
    expect(second.document!.generations.find((value) => value.id === "second")!.previousBlocks![0].content).toBe("First alternative with user edits");
    const undoneSecond = undoDocumentInsertion(second, "second", later);
    expect(undoneSecond.document!.blocks[0].content).toBe("First alternative with user edits");
    expect(undoDocumentInsertion(undoneSecond, "first", later).document!.blocks[0].content).toBe("Original with user edits");
    expect(undoDocumentInsertion(undoneSecond, "second", later)).toBe(undoneSecond);
  });

  test("undo restores edited previous blocks while preserving unrelated inserted and edited blocks", () => {
    let original = updateDocumentBlock(fixture(), "message:original", "My edited original", later);
    original = insertDocumentBlock(original, block("before", "Before"), { blockId: "message:original", offset: 0 }, later);
    original = insertDocumentBlock(original, block("after", "After"), undefined, later);
    let accepted = acceptDocumentVersion(candidate(original, "new", "Replacement"), "new", later);
    accepted = insertDocumentBlock(accepted, block("new-user-content", "Unrelated new paragraph"), { blockId: "after", offset: 0 }, later);
    accepted = updateDocumentBlock(accepted, "before", "Edited before", later);
    const undone = undoDocumentInsertion(accepted, "new", later);
    expect(undone.document!.blocks.map((value) => value.content)).toEqual(["Edited before", "My edited original", "Unrelated new paragraph", "After"]);
    expect(undone.document!.generations.find((value) => value.id === "new")!.previousBlocks![0].content).toBe("My edited original");
    expect(undone.messages).toBe(accepted.messages);
    expect(undone.document!.generations.find((value) => value.id === "generation:original")!.blockIds).toEqual(["message:original"]);
  });
});

function selectionReplacement(): Conversation {
  let conversation = updateDocumentBlock(fixture(), "message:original", "Before selected after", later);
  conversation = candidate(conversation, "replacement", "Generated selection");
  return insertDocumentGeneration(conversation, "replacement", { blockId: "message:original", offset: 7, replaceTo: 15 }, later);
}

describe("selection replacement undo", () => {
  test("restores the selected text at a rebased point after unrelated prefix editing", () => {
    const replaced = selectionReplacement();
    const edited = updateDocumentBlock(replaced, "message:original", "New Before ", later);
    edited.document = { ...edited.document!, generations: edited.document!.generations.map((generation) =>
      remapDocumentReplacement(generation, replaced.document!.blocks, edited.document!.blocks)) };
    const undone = undoDocumentInsertion(edited, "replacement", later);
    expect(undone.document!.blocks.map((value) => value.content)).toEqual(["New Before selected", " after"]);
    expect(undoDocumentInsertion(undone, "replacement", later)).toBe(undone);
  });

  test("restores a separate block when the original source was removed or its offset is invalid", () => {
    const replaced = selectionReplacement();
    for (const missingSource of [true, false]) {
      const edited = { ...replaced, document: { ...replaced.document!, blocks: replaced.document!.blocks.filter((value) => !missingSource || value.id !== "message:original"),
        generations: replaced.document!.generations.map((generation) => generation.id === "replacement" && !missingSource
          ? { ...generation, replacement: { ...generation.replacement!, offset: 999 } } : generation) } };
      const undone = undoDocumentInsertion(edited, "replacement", later);
      expect(undone.document!.blocks.map((value) => value.content)).toEqual(missingSource ? ["selected", " after"] : ["Before ", "selected", " after"]);
      expect(undone.document!.blocks.some((value) => value.id.startsWith("restored:replacement"))).toBe(true);
      expect(normalizeEditableDocument(undone.document)).toEqual(undone.document);
    }
  });

  test("ambiguous edits detach the restoration point rather than inserting into unrelated text", () => {
    const replaced = selectionReplacement();
    const generation = replaced.document!.generations.find((value) => value.id === "replacement")!;
    const before = [block("message:original", "Before after")];
    const after = [block("message:original", "Completely changed")];
    const rebased = remapDocumentReplacement(generation, before, after);
    expect(rebased.replacement).toEqual({ blockId: "restore:replacement", offset: 0, content: "selected" });
  });
});
