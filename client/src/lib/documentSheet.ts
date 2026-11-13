/**
 * The document as a sheet of paper lying on the map. Document view has one map underneath it and the only
 * thing that changes is how much of it the sheet covers: all of it (the page), all but a margin, half, a
 * card floating on the map, or none while the sheet is put away. On an upright phone the sheet slides up
 * from the bottom instead and stops at full, half and a peek.
 */
export type DocumentSheetMode = "page" | "docked" | "card" | "map";
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

/** Where the sheet goes when the map button brings the map out and nothing was remembered. */
export function getDefaultDocumentSheet(edge: DocumentSheetEdge, width: number, height: number): DocumentSheet {
  return { mode: "docked", size: getDocumentSheetStops(edge, width, height)[0] };
}

/**
 * Where a dragged edge settles. With a mouse the sheet stays where it is let go unless a stop is near;
 * far enough across it lifts off as a card, and at the far edge it is put away. On a phone it always
 * lands on a stop, carried on by a flick (`velocity`, pixels per frame).
 */
export function settleDocumentSheet(edge: DocumentSheetEdge, size: number, width: number, height: number, velocity = 0): DocumentSheet {
  const stops = getDocumentSheetStops(edge, width, height);
  if (edge === "top") {
    const goal = size + velocity * 12;
    const nearest = [0, ...stops].reduce((best, stop) => Math.abs(stop - goal) < Math.abs(best - goal) ? stop : best, 0);
    return nearest === 0 ? PAGE_SHEET : { mode: "docked", size: nearest };
  }
  if (size > width * 0.9) return { mode: "map", size: 0 };
  if (size > width * 0.66) return { mode: "card", size: 0 };
  if (size < 60) return PAGE_SHEET;
  const nearest = stops.reduce((best, stop) => Math.abs(stop - size) < Math.abs(best - size) ? stop : best, stops[0]);
  return { mode: "docked", size: Math.abs(nearest - size) < SNAP ? nearest : Math.round(size) };
}

/** A remembered size still has to fit the window it comes back to. */
export function fitDocumentSheet(sheet: DocumentSheet, edge: DocumentSheetEdge, width: number, height: number): DocumentSheet {
  if (edge === "top") {
    // A phone has no card and no put-away: the peek is as far as the sheet goes.
    if (sheet.mode === "card" || sheet.mode === "map") return { mode: "docked", size: Math.max(0, height - SHEET_PEEK) };
    if (sheet.mode === "docked") return { mode: "docked", size: Math.min(Math.max(0, height - SHEET_PEEK), Math.max(80, sheet.size)) };
    return sheet;
  }
  if (sheet.mode === "docked") return { mode: "docked", size: Math.min(Math.round(width * 0.66), Math.max(120, sheet.size)) };
  return sheet;
}

/** The box the map takes inside the document area, in that area's own coordinates. */
export function getDocumentSheetMapBox(sheet: DocumentSheet, edge: DocumentSheetEdge, width: number, height: number) {
  if (sheet.mode === "page") return null;
  if (sheet.mode !== "docked") return { left: 0, top: 0, width, height };
  return edge === "top" ? { left: 0, top: 0, width, height: Math.min(height, sheet.size) } : { left: 0, top: 0, width: Math.min(width, sheet.size), height };
}

/** The card's box on the map: right of the middle, where the map keeps the document's own dot in view. */
export function getDocumentSheetCardBox(width: number, height: number, moved?: { left: number; top: number } | null) {
  const cardWidth = Math.min(460, Math.max(280, width - 40));
  const cardHeight = Math.min(600, Math.max(240, height - 48));
  const left = moved?.left ?? Math.min(width - cardWidth - 20, Math.round(width * 0.5) + 60);
  const top = moved?.top ?? Math.round((height - cardHeight) / 2);
  return { left: Math.max(8 - cardWidth + 80, Math.min(width - 80, left)), top: Math.max(0, Math.min(height - 48, top)), width: cardWidth, height: cardHeight };
}

/** The last place the sheet rested off the page, so the map button brings it back there. */
export function loadLastDocumentSheet(): DocumentSheet | null {
  try {
    const stored = JSON.parse(localStorage.getItem(LAST_KEY) ?? "null") as Partial<DocumentSheet> | null;
    if (!stored || (stored.mode !== "docked" && stored.mode !== "card")) return null;
    return { mode: stored.mode, size: Number.isFinite(stored.size) ? Math.max(0, Number(stored.size)) : 0 };
  } catch { return null; }
}

export function saveLastDocumentSheet(sheet: DocumentSheet) {
  if (sheet.mode !== "docked" && sheet.mode !== "card") return;
  try { localStorage.setItem(LAST_KEY, JSON.stringify(sheet)); } catch { /* Best effort. */ }
}
