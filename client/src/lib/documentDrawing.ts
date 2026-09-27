import type { ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";

export const EMPTY_DRAWING = JSON.stringify({ type: "excalidraw", version: 2, source: "margin-chat", elements: [], appState: { viewBackgroundColor: "#ffffff" }, files: {} });
export function isDrawingMarkdown(markdown: string) { return /^\s*(`{3,}|~{3,})excalidraw\s*\n/i.test(markdown); }
export function drawingMarkdown(json: string) { return `\`\`\`excalidraw\n${JSON.stringify(JSON.parse(json), null, 2)}\n\`\`\``; }
export function readDrawing(markdown: string): ExcalidrawInitialDataState {
  const match = /^\s*(`{3,}|~{3,})excalidraw[^\S\n]*\n([\s\S]*?)\n\1\s*$/i.exec(markdown);
  if (!match) throw new Error("The drawing needs a complete excalidraw Markdown fence.");
  const value = JSON.parse(match[2]);
  if (!value || value.type !== "excalidraw" || !Array.isArray(value.elements)
    || value.elements.some((element: unknown) => !element || typeof element !== "object" || Array.isArray(element))
    || value.appState && (typeof value.appState !== "object" || Array.isArray(value.appState))
    || value.files && (typeof value.files !== "object" || Array.isArray(value.files))) {
    throw new Error("This is not a valid Excalidraw drawing. Its original source is still available in Edit Markdown.");
  }
  return value;
}
