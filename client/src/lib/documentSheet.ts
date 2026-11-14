/**
 * The document beside the map. Document view has one map underneath it and the only thing that changes is
 * how much of it the document covers: all of it (the page), the right-hand pane of a split whose divider
 * is dragged to any width, or none while the document is put away. On an upright phone the document slides
 * up from the bottom instead and stops at full, half and a peek.
 */
export type DocumentSheetMode = "page" | "docked" | "map";
export type DocumentSheetEdge = "top" | "left";
/** `size` is how many pixels of map show at the sheet's edge while it is docked. */
export interface DocumentSheet { mode: DocumentSheetMode; size: number }

const LAST_KEY = "margin-chat:document-sheet";
export const SHEET_MARGIN = 300;
/** Below this width the map in the margin would squeeze the page, so the margin stop is skipped. */
export const SHEET_MARGIN_MIN_WIDTH = 1000;
export const SHEET_PEEK = 84;
/** A docked map narrower than this drops its toolbars and shows only the map. */
export const SHEET_NARROW_MAP = 430;
const SNAP = 70;
/** The document pane never gets narrower than this while the split is open. */
export const SHEET_MIN_DOCUMENT = 360;
/** Dragging the divider this close to the right edge puts the document away. */
const PUT_AWAY = 200;

export const PAGE_SHEET: DocumentSheet = { mode: "page", size: 0 };

/** A phone held upright slides the sheet up from the bottom; anything wider drags its left edge. */
export function getDocumentSheetEdge(phone: boolean, width: number, height: number): DocumentSheetEdge {
  return phone && height > width ? "top" : "left";
}

/** Where a docked sheet comes to rest, as pixels of map showing. */
export function getDocumentSheetStops(edge: DocumentSheetEdge, width: number, height: number): number[] {
  if (edge === "top") return [Math.round(height * 0.46), Math.max(0, height - SHEET_PEEK)];
  return width >= SHEET_MARGIN_MIN_WIDTH ? [SHEET_MARGIN, Math.round(width * 0.5)] : [Math.round(width * 0.5)];
}

/** Where the sheet goes when the map button brings the map out and nothing was remembered: map and document split evenly. */
export function getDefaultDocumentSheet(edge: DocumentSheetEdge, width: number, height: number): DocumentSheet {
  const stops = getDocumentSheetStops(edge, width, height);
  return { mode: "docked", size: edge === "top" ? stops[0] : stops[stops.length - 1] };
}

/** The widest the map gets beside the document before the document would be too narrow to read. */
function getMaxDockedMap(width: number) {
  return Math.max(Math.round(width * 0.5), width - SHEET_MIN_DOCUMENT);
}

/**
 * Where a dragged divider settles. With a mouse it stays where it is let go unless a stop is near; at the
 * far right edge the document is put away, and near the left edge the page covers the map again. On a
 * phone it always lands on a stop, carried on by a flick (`velocity`, pixels per frame).
 */
export function settleDocumentSheet(edge: DocumentSheetEdge, size: number, width: number, height: number, velocity = 0): DocumentSheet {
  const stops = getDocumentSheetStops(edge, width, height);
  if (edge === "top") {
    const goal = size + velocity * 12;
    const nearest = [0, ...stops].reduce((best, stop) => Math.abs(stop - goal) < Math.abs(best - goal) ? stop : best, 0);
    return nearest === 0 ? PAGE_SHEET : { mode: "docked", size: nearest };
  }
  if (size > width - PUT_AWAY) return { mode: "map", size: 0 };
  if (size < 60) return PAGE_SHEET;
  const nearest = stops.reduce((best, stop) => Math.abs(stop - size) < Math.abs(best - size) ? stop : best, stops[0]);
  return { mode: "docked", size: Math.min(getMaxDockedMap(width), Math.abs(nearest - size) < SNAP ? nearest : Math.round(size)) };
}

/** A remembered size still has to fit the window it comes back to. */
export function fitDocumentSheet(sheet: DocumentSheet, edge: DocumentSheetEdge, width: number, height: number): DocumentSheet {
  if (edge === "top") {
    // A phone has no put-away: the peek is as far as the sheet goes.
    if (sheet.mode === "map") return { mode: "docked", size: Math.max(0, height - SHEET_PEEK) };
    if (sheet.mode === "docked") return { mode: "docked", size: Math.min(Math.max(0, height - SHEET_PEEK), Math.max(80, sheet.size)) };
    return sheet;
  }
  if (sheet.mode === "docked") return { mode: "docked", size: Math.min(getMaxDockedMap(width), Math.max(120, sheet.size)) };
  return sheet;
}

/** The box the map takes inside the document area, in that area's own coordinates. */
export function getDocumentSheetMapBox(sheet: DocumentSheet, edge: DocumentSheetEdge, width: number, height: number) {
  if (sheet.mode === "page") return null;
  if (sheet.mode !== "docked") return { left: 0, top: 0, width, height };
  return edge === "top" ? { left: 0, top: 0, width, height: Math.min(height, sheet.size) } : { left: 0, top: 0, width: Math.min(width, sheet.size), height };
}

/**
 * The last width the split was left at, so the map button brings it back there. A floating card, which
 * earlier versions remembered, is no longer a place the document goes, so it reads as nothing remembered.
 */
export function loadLastDocumentSheet(): DocumentSheet | null {
  try {
    const stored = JSON.parse(localStorage.getItem(LAST_KEY) ?? "null") as Partial<DocumentSheet> | null;
    if (!stored || stored.mode !== "docked" || !Number.isFinite(stored.size) || Number(stored.size) <= 0) return null;
    return { mode: "docked", size: Number(stored.size) };
  } catch { return null; }
}

export function saveLastDocumentSheet(sheet: DocumentSheet) {
  if (sheet.mode !== "docked") return;
  try { localStorage.setItem(LAST_KEY, JSON.stringify(sheet)); } catch { /* Best effort. */ }
}
