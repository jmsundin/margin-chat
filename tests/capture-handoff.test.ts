import { describe, expect, test } from "bun:test";
import type { Capture } from "@margin-chat/capture-contracts";
import { createEmptyState } from "../client/src/initialState";
import { createCaptureAIRequest, openCaptureAsNote, readCaptureHandoff } from "../client/src/lib/captures";
import { buildDocumentAIMessage } from "../client/src/lib/documentAI";
import { closeDocument, minimizeDocument } from "../client/src/lib/documentWorkspace";
import { getEditableDocument } from "../client/src/lib/editableDocument";

const capture: Capture = {
  schemaVersion: 1,
  clientCaptureId: "extension-capture-1234",
  id: "saved-capture-1234",
  kind: "article",
  title: "A useful page",
  sourceUrl: "https://example.com/research",
  content: "Opening passage.\n\n## More context\n\nThe important fact is at the end.",
  comment: "How does this apply to my project?",
  capturedAt: "2026-09-27T12:00:00.000Z",
  createdAt: "2026-09-27T12:00:01.000Z",
};

describe("extension capture handoff", () => {
  test("reads only a saved capture identifier and explicit ask intent", () => {
    expect(readCaptureHandoff("?inbox=1&capture=saved-capture-1234&intent=ask")).toEqual({ captureId: capture.id, intent: "ask" });
    expect(readCaptureHandoff("?capture=saved-capture-1234&intent=unknown&question=ignore-me")).toEqual({ captureId: capture.id, intent: "note" });
    for (const search of ["", "?inbox=1", "?intent=ask", "?capture=", "?capture=..%2Fsecret", `?capture=${"a".repeat(101)}`]) {
      expect(readCaptureHandoff(search)).toBeNull();
    }
  });

  test("reopening restores a closed or minimized source without replacing its current edits", () => {
    const imported = openCaptureAsNote(createEmptyState(), capture);
    const id = imported.activeConversationId;
    const document = getEditableDocument(imported.conversations[id]);
    document.blocks[0].content = "My current edited source";
    imported.conversations[id].document = document;
    for (const hidden of [closeDocument(imported, id), minimizeDocument(imported, id)]) {
      const reopened = openCaptureAsNote(hidden, capture);
      expect(reopened.activeConversationId).toBe(id);
      expect(reopened.conversations[id].document?.blocks[0].content).toBe("My current edited source");
      expect(reopened.conversations[id].documentLayout?.minimizedIds ?? []).not.toContain(id);
      expect(reopened.conversations[id].documentLayout?.closedIds ?? []).not.toContain(id);
      expect(Object.keys(reopened.conversations)).toHaveLength(2);
    }
  });

  test("creates a linked side request with the complete source and independently supplied question", () => {
    const imported = openCaptureAsNote(createEmptyState(), capture);
    const note = imported.conversations[imported.activeConversationId];
    const request = createCaptureAIRequest(note, "  Explain the final fact  ")!;
    expect(request.destination).toBe("side");
    expect(request.prompt).toBe("Explain the final fact");
    expect(request.blockId).toBe(getEditableDocument(note).blocks[0].id);
    expect(request.from).toBe(0);
    expect(request.to).toBe(0);
    expect(request.quote).toBeUndefined();
    const message = buildDocumentAIMessage(note, {
      id: "question", role: "user", content: request.prompt, createdAt: capture.createdAt,
    });
    expect(message.content).toContain(capture.sourceUrl);
    expect(message.content).toContain(capture.comment);
    expect(message.content).toContain("The important fact is at the end.");
    expect(message.content).toContain("Explain the final fact");
    expect(createCaptureAIRequest(note, "   ")).toBeNull();
    expect(note.childIds).toEqual([]);
    expect(note.messages).toEqual([]);
  });
});
