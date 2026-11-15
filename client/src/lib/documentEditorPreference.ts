import type { LivePreviewMode } from "./livePreviewMarkdown";

/**
 * Documents open in the Live Preview editor, which types like Obsidian. Its
 * view mode (Live, Source or Reading) is saved per device. The earlier block
 * editor is no longer offered; only tests that still cover it can open it.
 */
const TEST_CLASSIC_KEY = "margin-chat:test-classic-editor";
const MODE_KEY = "margin-chat:document-view-mode";
const listeners = new Set<() => void>();

export type DocumentEditorKind = "live" | "classic";

/** Always Live Preview for people; the old editor only for tests that set the test flag. */
export function readDocumentEditorKind(): DocumentEditorKind {
  try { return localStorage.getItem(TEST_CLASSIC_KEY) === "1" ? "classic" : "live"; }
  catch { return "live"; }
}

export function readDocumentViewMode(): LivePreviewMode {
  try {
    const value = localStorage.getItem(MODE_KEY);
    return value === "source" || value === "reading" ? value : "live";
  } catch { return "live"; }
}

export function saveDocumentViewMode(mode: LivePreviewMode) {
  try { localStorage.setItem(MODE_KEY, mode); }
  catch { /* Private windows keep the default. */ }
  listeners.forEach((listener) => listener());
}

export function subscribeDocumentEditorPreference(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
