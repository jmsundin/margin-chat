import { useSyncExternalStore } from "react";
import type { LivePreviewMode } from "./livePreviewMarkdown";
import { findRunnableFences } from "./codeRunner/languages";

/**
 * Each way of working with a document gets its own interface (thread "Give each way of working its
 * own interface"): Write shows the page with Ask AI at the caret, Read shows the rendered page with
 * nothing to edit, Language shows the tap-a-word reader, Board shows the canvas. The document decides
 * first (a board opens as Board, a language document as Language); the mode button in its header
 * switches, and a Write or Read pick is remembered for that document on this device.
 */
export type DocumentMode = "write" | "read" | "code" | "language" | "board";
export type PickedMode = "write" | "read" | "code";

export const DOCUMENT_MODE_LABELS: Readonly<Record<DocumentMode, string>> = {
  write: "Write", read: "Read", code: "Code", language: "Language", board: "Board",
};

export const DOCUMENT_MODE_HINTS: Readonly<Record<DocumentMode, string>> = {
  write: "Your page, its margin notes and Ask AI at the caret",
  read: "The rendered page, with nothing to edit",
  code: "Run every cell, and ask AI to explain, fix or test the code",
  language: "Tap a word to see, save and rate what it means",
  board: "The page as one full-size canvas",
};

const PICKS_KEY = "margin-chat:document-modes";
const listeners = new Set<() => void>();
let cached: { raw: string | null; picks: Readonly<Record<string, PickedMode>> } | null = null;

function parsePicks(raw: string | null): Readonly<Record<string, PickedMode>> {
  let value: unknown = null;
  try { value = raw ? JSON.parse(raw) : null; } catch { value = null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, PickedMode] => entry[1] === "write" || entry[1] === "read" || entry[1] === "code"));
}

/** Write or Read, as last picked for each document on this device; the same object until it changes. */
export function readDocumentModePicks(): Readonly<Record<string, PickedMode>> {
  let raw: string | null = null;
  try { raw = localStorage.getItem(PICKS_KEY); } catch { raw = cached?.raw ?? null; }
  if (!cached || cached.raw !== raw) cached = { raw, picks: parsePicks(raw) };
  return cached.picks;
}

/** Remembers Write, Read or Code for one document. Only the most recent 500 documents are kept. */
export function saveDocumentModePick(id: string, mode: PickedMode) {
  const { [id]: _previous, ...rest } = readDocumentModePicks();
  const entries = [...Object.entries(rest), [id, mode] as const].slice(-500);
  const raw = JSON.stringify(Object.fromEntries(entries));
  try { localStorage.setItem(PICKS_KEY, raw); } catch { /* Private windows keep it until reload. */ }
  cached = { raw, picks: parsePicks(raw) };
  listeners.forEach((listener) => listener());
}

/** Forgets the pick for one document, so it opens in the mode its content chooses again. */
export function clearDocumentModePick(id: string) {
  const picks = readDocumentModePicks();
  if (!(id in picks)) return;
  const { [id]: _previous, ...rest } = picks;
  const raw = JSON.stringify(rest);
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

const NO_PICKS: Readonly<Record<string, PickedMode>> = {};
export function useDocumentModePicks() {
  return useSyncExternalStore(subscribeDocumentModes, readDocumentModePicks, () => NO_PICKS);
}

/**
 * The mode a document opens in. A board is always Board and a language document always Language,
 * because what they hold decides. Otherwise the pick for this document, and failing that the
 * device's page view (Reading means Read, Live Preview and Source mean Write).
 */
export function documentModeOf(document: { id: string; nodeType?: string; languageLearning?: unknown },
  picks: Readonly<Record<string, PickedMode>>, deviceView: LivePreviewMode, code: CodeShare = NO_CODE): DocumentMode {
  if (document.nodeType === "board") return "board";
  if (document.languageLearning) return "language";
  const picked = picks[document.id];
  if (picked && (picked !== "code" || code.cells > 0)) return picked;
  if (code.mostlyCode) return "code";
  return deviceView === "reading" ? "read" : "write";
}

/**
 * Why the document chose its mode by itself, said once the first time a page opens that way
 * ("Opened in Code because this page is mostly code"). Null when the mode is a pick or plain Write/Read.
 */
export function automaticModeReason(document: { id: string; nodeType?: string; languageLearning?: unknown },
  picks: Readonly<Record<string, PickedMode>>, code: CodeShare = NO_CODE, languageName?: string): { mode: "code" | "language" | "board"; reason: string } | null {
  if (document.nodeType === "board") return { mode: "board", reason: "this page is a board" };
  if (document.languageLearning) return { mode: "language", reason: languageName ? `this page is for learning ${languageName}` : "this page is for learning a language" };
  if (picks[document.id] && (picks[document.id] !== "code" || code.cells > 0)) return null;
  if (code.mostlyCode) return { mode: "code", reason: "this page is mostly code" };
  return null;
}

export interface CodeShare { cells: number; mostlyCode: boolean }
const NO_CODE: CodeShare = { cells: 0, mostlyCode: false };
const codeShares = new WeakMap<object, CodeShare>();

/**
 * How many runnable code cells a document holds, and whether code is most of it (by characters,
 * not counting spaces): a page that is mostly code opens in Code, a page with a snippet stays in Write.
 */
export function codeShareOf(blocks: ReadonlyArray<{ kind?: string; content?: string }>): CodeShare {
  const known = codeShares.get(blocks);
  if (known) return known;
  let cells = 0, code = 0, all = 0;
  for (const block of blocks) {
    if (block.kind !== "markdown" || !block.content) continue;
    const fences = findRunnableFences(block.content);
    cells += fences.length;
    code += fences.reduce((total, fence) => total + fence.source.replace(/\s+/gu, "").length, 0);
    all += block.content.replace(/\s+/gu, "").length;
  }
  const share = cells ? { cells, mostlyCode: code * 2 >= all } : NO_CODE;
  codeShares.set(blocks, share);
  return share;
}

/** How the editor shows the page in Write or Read: Read is Reading; Write keeps Live Preview or Source. */
export function editorViewFor(mode: "write" | "read", deviceView: LivePreviewMode): LivePreviewMode {
  if (mode === "read") return "reading";
  return deviceView === "reading" ? "live" : deviceView;
}
