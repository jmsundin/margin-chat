import { describe, expect, test } from "bun:test";
import { drawingMarkdown, EMPTY_DRAWING, isDrawingMarkdown, readDrawing } from "../client/src/lib/documentDrawing";
import { getRichDocumentFallbackReason } from "../client/src/lib/richDocumentMarkdown";
import { createEmptyState } from "../client/src/initialState";
import { getEditableDocument } from "../client/src/lib/editableDocument";
import { stateToVaultFiles, vaultToState } from "../client/src/lib/vaultWorkspace";
import { formatDocumentDateTime } from "../client/src/lib/documentDateTime";

describe("embedded document drawings", () => {
  test("drawing scenes and attached images survive Markdown vault save/reopen", () => {
    const scene = { ...JSON.parse(EMPTY_DRAWING), elements: [{ id: "shape", type: "rectangle", x: 10, y: 20, width: 80, height: 50 }], files: { picture: { id: "picture", mimeType: "image/png", dataURL: "data:image/png;base64,aGVsbG8=", created: 1 } } };
    const markdown = drawingMarkdown(JSON.stringify(scene));
    expect(isDrawingMarkdown(markdown)).toBe(true);
    expect(getRichDocumentFallbackReason(markdown)).toBe("Drawing");
    const state = createEmptyState();
    const conversation = state.conversations[state.rootId];
    conversation.document = getEditableDocument(conversation);
    conversation.document.blocks[0].content = markdown;
    const restored = vaultToState(stateToVaultFiles(state, {}), state);
    expect(readDrawing(restored.conversations[state.rootId].document!.blocks[0].content)).toEqual(scene);
  });
  test("invalid or unfinished scenes remain recoverable source", () => {
    expect(() => readDrawing('```excalidraw\n{broken\n```')).toThrow();
    expect(() => readDrawing('```excalidraw\n{"type":"excalidraw","elements":{}}\n```')).toThrow();
    expect(() => readDrawing('```excalidraw\n{}')).toThrow();
    expect(isDrawingMarkdown('```json\n{}\n```')).toBe(false);
  });
});

test("document timestamps include local date, time, UTC offset and timezone through DST", () => {
  expect(formatDocumentDateTime(new Date("2026-09-27T15:42:07Z"), "America/New_York")).toBe("2026-09-27 11:42:07 GMT-4 (America/New_York)");
  expect(formatDocumentDateTime(new Date("2026-01-27T15:42:07Z"), "America/New_York")).toBe("2026-01-27 10:42:07 GMT-5 (America/New_York)");
  expect(formatDocumentDateTime(new Date("2026-09-27T00:00:00Z"), "UTC")).toMatch(/^2026-09-27 00:00:00 GMT(?:\+0)? \(UTC\)$/);
});
