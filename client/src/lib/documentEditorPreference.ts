import type { LivePreviewMode } from "./livePreviewMarkdown";

/**
 * Documents open in the Live Preview editor, which types like Obsidian. The
 * classic rich-text editor stays available from Settings. Both choices are
 * saved per device.
 */
const EDITOR_KEY = "margin-chat:document-editor";
const MODE_KEY = "margin-chat:document-view-mode";
const listeners = new Set<() => void>();

export type DocumentEditorKind = "live" | "classic";

export function readDocumentEditorKind(): DocumentEditorKind {
  try { return localStorage.getItem(EDITOR_KEY) === "classic" ? "classic" : "live"; }
  catch { return "live"; }
}

export function saveDocumentEditorKind(kind: DocumentEditorKind) {
  try { localStorage.setItem(EDITOR_KEY, kind); }
  catch { /* Private windows keep the default. */ }
  listeners.forEach((listener) => listener());
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
  return () => listeners.delete(listener);
}
