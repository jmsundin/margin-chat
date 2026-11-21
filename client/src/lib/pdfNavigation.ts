import { useSyncExternalStore } from "react";
import type { PdfOutlineEntry } from "./pdfOutline";

/** What an open PDF shares with the rest of the app: its contents, where the reader is, and how to move them. */
export interface PdfNavigation {
  outline: PdfOutlineEntry[] | null;
  labels: string[] | null;
  currentPage: number;
  pageCount: number;
  jump: (page: number, top?: number | null) => void;
}

const open = new Map<string, PdfNavigation>();
const listeners = new Set<() => void>();
const changed = () => { for (const listener of listeners) listener(); };

/** Called by the PDF viewer for its document; the latest viewer of a document wins. */
export function publishPdfNavigation(conversationId: string, navigation: PdfNavigation) {
  open.set(conversationId, navigation);
  changed();
  return () => {
    if (open.get(conversationId) !== navigation) return;
    open.delete(conversationId);
    changed();
  };
}

const pendingJumps = new Map<string, number>();

/**
 * Open a PDF at a page: at once when it is on screen, otherwise as soon as its
 * viewer opens it (a link to `Book.pdf#page=12` opens the document first).
 */
export function requestPdfPage(conversationId: string, page: number) {
  const navigation = open.get(conversationId);
  if (navigation) { navigation.jump(page); return; }
  pendingJumps.set(conversationId, page);
}

/** The page a link asked this PDF to open at before it was on screen, taken once. */
export function takePendingPdfPage(conversationId: string): number | null {
  const page = pendingJumps.get(conversationId) ?? null;
  pendingJumps.delete(conversationId);
  return page;
}

/** What the PDF open on screen for this document shares, read once rather than followed. */
export function pdfNavigationFor(conversationId: string): PdfNavigation | null {
  return open.get(conversationId) ?? null;
}

export function usePdfNavigation(conversationId: string | null | undefined): PdfNavigation | null {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => conversationId ? open.get(conversationId) ?? null : null,
    () => null,
  );
}
