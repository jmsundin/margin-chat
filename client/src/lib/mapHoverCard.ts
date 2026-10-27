/**
 * The small card that shows a document's opening lines when the pointer rests
 * on a Map circle. Sweeping across circles shows nothing: the card waits until
 * the pointer stops on one. Once a card is open, the next circle's card opens
 * at once, until the pointer has been off every circle for a moment.
 */

import { stripInlineMarkdown } from "./documentTitleSuggestion";
import type { MapBox } from "./mapDotNodes";

/** How long the pointer must stay still on a circle before its card opens. */
export const MAP_HOVER_REST_MS = 300;
/** A hand never holds a mouse perfectly still; drifting less than this still counts as resting. */
const REST_DRIFT_PX = 4;
/** After the last card closes, the next circle opens its card at once for this long. */
export const MAP_HOVER_WARM_MS = 1000;

export interface MapHoverIntentTimers {
  now: () => number;
  setTimeout: (callback: () => void, ms: number) => number;
  clearTimeout: (handle: number) => void;
}

const browserTimers: MapHoverIntentTimers = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  clearTimeout: (handle) => window.clearTimeout(handle),
};

export interface MapHoverIntent {
  /** The pointer entered or moved on a circle, at screen point `x`, `y`. */
  move: (id: string, x?: number, y?: number) => void;
  /** The pointer left a circle. */
  leave: (id: string) => void;
  /** Close the card now and start cold, as when a press or drag begins. */
  cancel: () => void;
  dispose: () => void;
}

/** `onChange` gets the id whose card should show, or null to hide it. */
export function createMapHoverIntent(onChange: (id: string | null) => void, timers: MapHoverIntentTimers = browserTimers,
  restMs = MAP_HOVER_REST_MS, warmMs = MAP_HOVER_WARM_MS): MapHoverIntent {
  let shown: string | null = null, over: string | null = null, timer = 0, closedAt = -Infinity, restX = NaN, restY = NaN;
  const show = (id: string | null) => {
    if (id === shown) return;
    if (shown && !id) closedAt = timers.now();
    shown = id;
    onChange(id);
  };
  const stop = () => { if (timer) timers.clearTimeout(timer); timer = 0; };
  return {
    move(id, x = NaN, y = NaN) {
      const entered = over !== id;
      over = id;
      if (shown === id) return;
      // Warm: a card is open, or one closed a moment ago.
      if (shown || timers.now() - closedAt < warmMs) { stop(); show(id); return; }
      // Cold: moving restarts the wait, so only a resting pointer opens a card.
      if (!entered && timer && !(Math.hypot(x - restX, y - restY) > REST_DRIFT_PX)) return;
      restX = x; restY = y;
      stop();
      timer = timers.setTimeout(() => { timer = 0; if (over === id) show(id); }, restMs);
    },
    leave(id) {
      if (over !== id) return;
      over = null;
      stop();
      show(null);
    },
    cancel() {
      over = null;
      stop();
      if (shown) { shown = null; onChange(null); }
      closedAt = -Infinity;
    },
    dispose() { stop(); },
  };
}

/** A document's opening words as plain text: no front matter, headings marks, code or Markdown. */
export function mapHoverSnippet(markdown: string, maxLength = 220): string {
  let lines = markdown.replace(/\r\n?/gu, "\n").split("\n");
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)\s*$/u.test(line));
    if (end > 0) lines = lines.slice(end + 1);
  }
  const words: string[] = [];
  let fence: string | null = null, length = 0;
  for (const raw of lines) {
    const fenceMark = /^\s*(`{3,}|~{3,})/u.exec(raw)?.[1];
    if (fence) { if (fenceMark?.startsWith(fence)) fence = null; continue; }
    if (fenceMark) { fence = fenceMark; continue; }
    // Tables and rules say little in a few lines.
    if (/^\s*\|/u.test(raw) || /^\s*(?:[-*_]\s*){3,}$/u.test(raw)) continue;
    const text = stripInlineMarkdown(raw.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)+/u, ""));
    if (!text) continue;
    words.push(text);
    length += text.length + 1;
    if (length > maxLength) break;
  }
  const joined = words.join(" ");
  if (joined.length <= maxLength) return joined;
  const clipped = joined.slice(0, maxLength);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${(lastSpace > maxLength / 2 ? clipped.slice(0, lastSpace) : clipped).replace(/[\s.,;:\-–—(]+$/u, "")}…`;
}

export interface MapHoverCardPlacement { left: number; top: number; side: "right" | "left" | "below" | "above" }

const CARD_GAP = 12;
const EDGE = 8;

function overlap(a: MapBox, b: MapBox) {
  const width = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), height = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return width > 0 && height > 0 ? width * height : 0;
}

/**
 * Where the card goes beside `anchor` (the circle, in screen pixels): right of
 * it if that is clear, else whichever side covers the least of `obstacles`
 * (other circles and titles), always inside `view`.
 */
export function placeMapHoverCard(anchor: MapBox, card: { width: number; height: number }, view: { width: number; height: number },
  obstacles: MapBox[], rightGap = CARD_GAP): MapHoverCardPlacement {
  const centerX = (anchor.x0 + anchor.x1) / 2, centerY = (anchor.y0 + anchor.y1) / 2;
  const clampX = (left: number) => Math.max(EDGE, Math.min(left, view.width - card.width - EDGE));
  const clampY = (top: number) => Math.max(EDGE, Math.min(top, view.height - card.height - EDGE));
  // Beside the circle the card starts level with it, or rises to end level with it.
  const sideTops = [clampY(centerY - Math.min(card.height / 2, 28)), clampY(centerY + 28 - card.height)];
  const candidates: MapHoverCardPlacement[] = [
    ...sideTops.map((top) => ({ side: "right" as const, left: anchor.x1 + rightGap, top })),
    ...sideTops.map((top) => ({ side: "left" as const, left: anchor.x0 - CARD_GAP - card.width, top })),
    { side: "below", left: clampX(centerX - card.width / 2), top: anchor.y1 + CARD_GAP + 20 },
    { side: "above", left: clampX(centerX - card.width / 2), top: anchor.y0 - CARD_GAP - card.height },
  ];
  let best = candidates[0], bestCost = Infinity;
  for (const candidate of candidates) {
    const box = { x0: candidate.left, y0: candidate.top, x1: candidate.left + card.width, y1: candidate.top + card.height };
    // Leaving the map costs more than covering a neighbor.
    const outside = card.width * card.height - Math.max(0, Math.min(box.x1, view.width) - Math.max(box.x0, 0)) * Math.max(0, Math.min(box.y1, view.height) - Math.max(box.y0, 0));
    const cost = outside * 4 + obstacles.reduce((sum, obstacle) => sum + overlap(box, obstacle), 0);
    if (cost < bestCost) { best = candidate; bestCost = cost; }
    if (cost === 0) break;
  }
  return best;
}
