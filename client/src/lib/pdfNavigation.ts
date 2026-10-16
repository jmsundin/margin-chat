import { useSyncExternalStore } from "react";
import type { PdfOutlineEntry } from "./pdfOutline";

/** What an open PDF shares with the rest of the app: its contents, where the reader is, and how to move them. */
export interface PdfNavigation {
  outline: PdfOutlineEntry[] | null;
  labels: string[] | null;
  currentPage: number;
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

export function usePdfNavigation(conversationId: string | null | undefined): PdfNavigation | null {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => conversationId ? open.get(conversationId) ?? null : null,
  );
}
