import { describe, expect, test } from "bun:test";
import { getDocumentBlockAuthorship, normalizeEditableDocument, type DocumentBlock } from "@margin-chat/workspace-contracts";
import { createMainConversation, createStandaloneNoteConversation } from "../client/src/initialState";
import { getEditableDocument, insertDocumentBlock, moveDocumentBlock, updateDocumentBlock } from "../client/src/lib/editableDocument";

const now = "2026-09-27T12:00:00.000Z";
const later = "2026-09-27T13:00:00.000Z";
const block: DocumentBlock = { id: "block", kind: "markdown", content: "Original wording", createdAt: now, updatedAt: now };
const messages = [{ id: "answer", role: "assistant" as const }];

describe("document block authorship", () => {
  test("infers legacy AI origins and respects explicit mixed or user attribution", () => {
    expect(getDocumentBlockAuthorship(block)).toBe("user");
    expect(getDocumentBlockAuthorship({ ...block, generationId: "generation" })).toBe("ai");
    expect(getDocumentBlockAuthorship({ ...block, sourceMessageId: "answer" }, messages)).toBe("ai");
    expect(getDocumentBlockAuthorship({ ...block, sourceMessageId: "answer", authorship: "mixed" }, messages)).toBe("mixed");
    expect(getDocumentBlockAuthorship({ ...block, generationId: "generation", authorship: "user" }, messages)).toBe("user");
  });

  test("normalization preserves current and historical attribution without inventing it for old blocks", () => {
    const document = { schemaVersion: 1, blocks: [block, { ...block, id: "mixed", authorship: "mixed" }],
      prompts: [{ id: "prompt", content: "Generate", createdAt: now, serviceId: "backend-services", modelId: "smart-routing" }],
      generations: [{ id: "generation", promptId: "prompt", messageId: "answer", createdAt: now,
        serviceId: "backend-services", modelId: "smart-routing", status: "complete", blockIds: ["mixed"],
        previousBlocks: [{ ...block, authorship: "ai" }] }] };
    expect(normalizeEditableDocument(document)).toEqual(document);
    expect(normalizeEditableDocument({ ...document, blocks: [{ ...block, authorship: "unknown-value" }] })).toBeUndefined();
  });

  test("human edits retain AI origin, untouched output and fresh manual notes remain distinct", () => {
    const conversation = createMainConversation({ id: "authorship", createdAt: now });
    conversation.messages = [{ id: "answer", role: "assistant", content: "First paragraph.\n\nSecond paragraph.", createdAt: now }];
    const projected = getEditableDocument(conversation);
    expect(projected.blocks.map((value) => value.authorship)).toEqual(["ai", "ai"]);
    expect(updateDocumentBlock(conversation, projected.blocks[0].id, projected.blocks[0].content)).toBe(conversation);
    const edited = updateDocumentBlock(conversation, projected.blocks[0].id, "My revision.", later);
    expect(edited.document!.blocks.map((value) => value.authorship)).toEqual(["mixed", "ai"]);
    expect(updateDocumentBlock(edited, projected.blocks[0].id, "Another revision.", later).document!.blocks[0].authorship).toBe("mixed");
    expect(edited.messages[0].content).toBe(conversation.messages[0].content);
    const note = createStandaloneNoteConversation({ id: "manual", noteId: "note", createdAt: now });
    const noteBlock = getEditableDocument(note).blocks[0];
    expect(noteBlock.authorship).toBe("user");
    expect(updateDocumentBlock(note, noteBlock.id, "My words", later).document!.blocks[0].authorship).toBe("user");
  });

  test("splitting and reordering text preserve each fragment's origin", () => {
    const conversation = createMainConversation({ id: "authorship-split", createdAt: now });
    conversation.document = { schemaVersion: 1, blocks: [{ ...block, authorship: "mixed" }], prompts: [], generations: [] };
    const inserted = insertDocumentBlock(conversation, { ...block, id: "manual", content: "My addition", authorship: "user" }, { blockId: block.id, offset: 8 }, later);
    expect(inserted.document!.blocks.map((value) => value.authorship)).toEqual(["mixed", "user", "mixed"]);
    const reordered = moveDocumentBlock(inserted, "manual", null, later);
    expect(reordered.document!.blocks.map((value) => value.authorship)).toEqual(["mixed", "mixed", "user"]);
  });
});
