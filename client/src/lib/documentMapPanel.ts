/**
 * The map around the focused document, inside Document view: a popup over the document, split beside it
 * (top and bottom on a phone held upright, left and right otherwise), or minimized to a pill that brings it back.
 */
export type DocumentMapLayout = "popup" | "split";
export type DocumentMapPanel = "closed" | "open" | "minimized";
export type DocumentMapSplitEdge = "top" | "left";

const LAYOUT_KEY = "margin-chat:document-map-layout";
const SPLIT_SIZE_KEY = "margin-chat:document-map-split-size";

export const MIN_SPLIT_SIZE = 0.2;
export const MAX_SPLIT_SIZE = 0.8;

export function loadDocumentMapLayout(): DocumentMapLayout {
  try { return localStorage.getItem(LAYOUT_KEY) === "split" ? "split" : "popup"; } catch { return "popup"; }
}

export function saveDocumentMapLayout(layout: DocumentMapLayout) {
  try { localStorage.setItem(LAYOUT_KEY, layout); } catch { /* Best effort. */ }
}

export function clampSplitSize(size: number) {
  return Number.isFinite(size) ? Math.min(MAX_SPLIT_SIZE, Math.max(MIN_SPLIT_SIZE, size)) : 0.45;
}

export function loadDocumentMapSplitSize(): number {
  try {
    const stored = localStorage.getItem(SPLIT_SIZE_KEY);
    return stored === null ? 0.45 : clampSplitSize(Number(stored));
  } catch { return 0.45; }
}

export function saveDocumentMapSplitSize(size: number) {
  try { localStorage.setItem(SPLIT_SIZE_KEY, String(clampSplitSize(size))); } catch { /* Best effort. */ }
}

/** A phone held upright stacks the map over the document; anything wider puts it on the left. */
export function getDocumentMapSplitEdge(phone: boolean, width: number, height: number): DocumentMapSplitEdge {
  return phone && height > width ? "top" : "left";
}

/** The header's map button: open the map, or put an open one away to its pill. */
export function nextDocumentMapPanel(panel: DocumentMapPanel): DocumentMapPanel {
  return panel === "open" ? "minimized" : "open";
}

/** The box the map takes inside the document area, in that area's own coordinates. */
export function getDocumentMapSplitBox(edge: DocumentMapSplitEdge, size: number, width: number, height: number) {
  const share = clampSplitSize(size);
  return edge === "top"
    ? { left: 0, top: 0, width, height: Math.round(height * share) }
    : { left: 0, top: 0, width: Math.round(width * share), height };
}
