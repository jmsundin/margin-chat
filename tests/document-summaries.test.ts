import { describe, expect, test } from "bun:test";
import { createChildConversation, createMainConversation, createStandaloneNoteConversation } from "../client/src/initialState";
import { buildDocumentSummaries, buildThreadSummaries } from "../client/src/lib/conversationSearch";
import { updateDocumentBlock } from "../client/src/lib/editableDocument";

describe("independent document summaries", () => {
  test("lists main, side, and nested side documents with their own activity and preview", () => {
    const main = createMainConversation({ id: "main", createdAt: "2026-01-01T00:00:00Z" });
    main.title = "Main research";
    const side = createChildConversation({ id: "side", parentConversation: main, createdAt: "2026-01-02T00:00:00Z" });
    side.title = "Side research";
    const nested = createChildConversation({ id: "nested", parentConversation: side, createdAt: "2026-01-03T00:00:00Z" });
    nested.title = "Nested research";
    side.messages = [{ id: "side-response", role: "assistant", content: "Side-specific text", createdAt: side.createdAt }];
    nested.messages = [{ id: "nested-response", role: "assistant", content: "Nested-specific text", createdAt: nested.createdAt }];
    main.childIds = [side.id];
    side.childIds = [nested.id];
    const conversations = { main, side, nested };
    const before = structuredClone(conversations);

    const summaries = buildDocumentSummaries(conversations);

    expect(summaries.map(({ id }) => id)).toEqual(["nested", "side", "main"]);
    expect(summaries[0]).toMatchObject({ title: "Nested research", preview: "Nested-specific text", conversationCount: 1, updatedAt: nested.updatedAt });
    expect(summaries[1]).toMatchObject({ title: "Side research", preview: "Side-specific text", conversationCount: 1, updatedAt: side.updatedAt });
    expect(summaries[2]).toMatchObject({ title: "Main research", preview: "No messages yet.", conversationCount: 1, updatedAt: main.updatedAt });
    expect(buildThreadSummaries(conversations).map(({ id }) => id)).toEqual(["main"]);
    expect(conversations).toEqual(before);
  });

  test("previews current edited content rather than historical messages or notes", () => {
    const main = createMainConversation({ id: "main" });
    const side = createChildConversation({ id: "side", parentConversation: main });
    side.messages = [{ id: "response", role: "assistant", content: "Historical response", createdAt: side.createdAt }];
    const editedSide = updateDocumentBlock(side, "message:response", "Current side document text");
    const note = createStandaloneNoteConversation({ id: "note", noteId: "body" });
    note.notes![0].content = "Historical note";
    const editedNote = updateDocumentBlock(note, "note:body", "Current note document text");

    const summaries = buildDocumentSummaries({ main, side: editedSide, note: editedNote });

    expect(summaries.find(({ id }) => id === "side")?.preview).toBe("Current side document text");
    expect(summaries.find(({ id }) => id === "note")).toMatchObject({ kind: "note", preview: "Current note document text" });
    expect(JSON.stringify(summaries)).not.toContain("Historical");
  });
});
