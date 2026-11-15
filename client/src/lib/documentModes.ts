import { useSyncExternalStore } from "react";
import type { LivePreviewMode } from "./livePreviewMarkdown";

/**
 * Each way of working with a document gets its own interface (thread "Give each way of working its
 * own interface"): Write shows the page with Ask AI at the caret, Read shows the rendered page with
 * nothing to edit, Language shows the tap-a-word reader, Board shows the canvas. The document decides
 * first (a board opens as Board, a language document as Language); the mode button in its header
 * switches, and a Write or Read pick is remembered for that document on this device.
 */
export type DocumentMode = "write" | "read" | "language" | "board";

export const DOCUMENT_MODE_LABELS: Readonly<Record<DocumentMode, string>> = {
  write: "Write", read: "Read", language: "Language", board: "Board",
};

export const DOCUMENT_MODE_HINTS: Readonly<Record<DocumentMode, string>> = {
  write: "Your page, its margin notes and Ask AI at the caret",
  read: "The rendered page, with nothing to edit",
  language: "Tap a word to see, save and rate what it means",
  board: "The page as one full-size canvas",
};

const PICKS_KEY = "margin-chat:document-modes";
const listeners = new Set<() => void>();
let cached: { raw: string | null; picks: Readonly<Record<string, "write" | "read">> } | null = null;

function parsePicks(raw: string | null): Readonly<Record<string, "write" | "read">> {
  let value: unknown = null;
  try { value = raw ? JSON.parse(raw) : null; } catch { value = null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, "write" | "read"] => entry[1] === "write" || entry[1] === "read"));
}

/** Write or Read, as last picked for each document on this device; the same object until it changes. */
export function readDocumentModePicks(): Readonly<Record<string, "write" | "read">> {
  let raw: string | null = null;
  try { raw = localStorage.getItem(PICKS_KEY); } catch { raw = cached?.raw ?? null; }
  if (!cached || cached.raw !== raw) cached = { raw, picks: parsePicks(raw) };
  return cached.picks;
}

/** Remembers Write or Read for one document. Only the most recent 500 documents are kept. */
export function saveDocumentModePick(id: string, mode: "write" | "read") {
  const { [id]: _previous, ...rest } = readDocumentModePicks();
  const entries = [...Object.entries(rest), [id, mode] as const].slice(-500);
  const raw = JSON.stringify(Object.fromEntries(entries));
  try { localStorage.setItem(PICKS_KEY, raw); } catch { /* Private windows keep it until reload. */ }
  cached = { raw, picks: parsePicks(raw) };
  listeners.forEach((listener) => listener());
}

export function subscribeDocumentModes(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => { if (event.key === PICKS_KEY) listener(); };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(listener); window.removeEventListener("storage", onStorage); };
}

const NO_PICKS: Readonly<Record<string, "write" | "read">> = {};
export function useDocumentModePicks() {
  return useSyncExternalStore(subscribeDocumentModes, readDocumentModePicks, () => NO_PICKS);
}

/**
 * The mode a document opens in. A board is always Board and a language document always Language,
 * because what they hold decides. Otherwise the pick for this document, and failing that the
 * device's page view (Reading means Read, Live Preview and Source mean Write).
 */
export function documentModeOf(document: { id: string; nodeType?: string; languageLearning?: unknown },
  picks: Readonly<Record<string, "write" | "read">>, deviceView: LivePreviewMode): DocumentMode {
  if (document.nodeType === "board") return "board";
  if (document.languageLearning) return "language";
  return picks[document.id] ?? (deviceView === "reading" ? "read" : "write");
}

/** How the editor shows the page in Write or Read: Read is Reading; Write keeps Live Preview or Source. */
export function editorViewFor(mode: "write" | "read", deviceView: LivePreviewMode): LivePreviewMode {
  if (mode === "read") return "reading";
  return deviceView === "reading" ? "live" : deviceView;
}
