/**
 * Map documents drawn as a circle with the title below it. The circle grows
 * with the document's connections; a long title wraps onto a second line, and
 * one that would still run into a neighbor is cut short (the CSS adds the "…")
 * so it never covers another circle or title.
 */

const MIN_DIAMETER = 14;
/** Titles wrap onto at most this many lines, each no wider than this (card pixels), and sit this close under their circle. */
export const MAP_DOT_TITLE_LINES = 2;
export const MAP_DOT_TITLE_WIDTH = 180;
export const MAP_DOT_TITLE_GAP = 3;
const MAX_DIAMETER = 36;

/** Circle size in card pixels: the most connected document on the map draws largest. */
export function mapDotDiameter(connections: number, maxConnections: number) {
  if (maxConnections <= 0 || connections <= 0) return MIN_DIAMETER;
  return Math.round(MIN_DIAMETER + (MAX_DIAMETER - MIN_DIAMETER) * Math.sqrt(Math.min(1, connections / maxConnections)));
}

export interface MapDotTitle {
  id: string;
  /** Circle center, in screen pixels. */
  x: number;
  y: number;
  radius: number;
  /** Space between the circle and the title's top. */
  gap: number;
  titleWidth: number;
  /** Height of one line of the title. */
  titleHeight: number;
  /** Higher claims space first. */
  priority: number;
  /** The selected, hovered or found document: placed before all others and never cut. */
  keep?: boolean;
  /** Widths of the title's words and of a space, so it can wrap; without them it wraps anywhere. */
  words?: number[];
  space?: number;
  /** Widest a title may grow before it wraps onto another line. */
  maxWidth?: number;
  /** Most lines a title may take; a kept title may take more. */
  maxLines?: number;
}

export interface MapBox { x0: number; y0: number; x1: number; y1: number }

/** Space kept clear between a title and whatever is beside it. */
const TITLE_MARGIN = 6;
/** Space kept clear under a title, so the circle below never reads as its own. */
const TITLE_MARGIN_BELOW = 4;
/** A cut title still shows a few letters before the "…"; with less room it hides. */
const MIN_TITLE_WIDTH = 48;
/** A row's fair share narrower than this would leave every title a stub; titles then take turns. */
const MIN_SHARED_WIDTH = 88;
/** The selected, hovered or found title may wrap this far, so all of it shows. */
const KEPT_TITLE_LINES = 4;

/** How a title is drawn: its width and how many lines it wraps onto (the last one ends in "…" when cut). */
export interface MapDotTitleFit { width: number; lines: number }

/**
 * Lines a title takes at a width, wrapping between words like the browser does;
 * a word longer than a line breaks inside it (CSS `overflow-wrap: anywhere`).
 */
export function mapDotTitleLines(words: number[], space: number, width: number) {
  if (width <= 0) return Infinity;
  let lines = 1, line = 0;
  for (const word of words) {
    const next = line ? line + space + word : word;
    if (next <= width) { line = next; continue; }
    if (line) { lines += 1; line = 0; }
    // A word longer than the line fills whole lines, the rest starts the next one.
    const whole = Math.max(0, Math.ceil(word / width) - 1);
    lines += whole;
    line = word - whole * width;
  }
  return lines;
}

/** The narrowest width at which the title takes at most `lines` lines, or null when it needs more even at `cap`. */
function widthForLines(words: number[], space: number, titleWidth: number, cap: number, lines: number, unbroken: number) {
  const hi = Math.min(titleWidth, cap);
  // Splitting a word that would fit a title's full width reads worse than cutting the title short.
  if (lines > 1 && hi < unbroken) return null;
  if (mapDotTitleLines(words, space, hi) > lines) return null;
  // No narrower than its longest word, so words only break when one is wider than a title may be.
  let low = Math.max(1, titleWidth / lines - 1, Math.min(hi, Math.max(0, ...words))), high = hi;
  if (mapDotTitleLines(words, space, low) <= lines) return Math.ceil(low);
  for (let step = 0; step < 12 && high - low > 0.5; step++) {
    const mid = (low + high) / 2;
    if (mapDotTitleLines(words, space, mid) <= lines) high = mid; else low = mid;
  }
  // A pixel of slack, so the browser's own measuring never wraps it once more.
  return Math.min(hi, Math.ceil(high) + 1);
}

/**
 * How each title that can't show whole on one line is drawn, keyed by id: a width and a number of
 * lines; width 0 hides a title with no room. Titles are centered under their circle and wrap onto
 * up to `maxLines` lines no wider than `maxWidth`, as narrow as they can while keeping the
 * fewest lines. Each one stops before another circle, a title already placed, or one of
 * `obstacles` (such as an open preview card), and keeps clear of the circle below it, so a title
 * reads as the one of the circle right above it. Kept titles (the selected, hovered or found
 * document) go first and are never cut; then more connected documents, so they keep their full title.
 */
export function fitMapDotTitles(nodes: MapDotTitle[], obstacles: MapBox[] = []) {
  const boxes: MapBox[] = [...obstacles, ...nodes.map((node) => ({
    x0: node.x - node.radius, y0: node.y - node.radius, x1: node.x + node.radius, y1: node.y + node.radius,
  }))];
  const ownCircle = new Map(nodes.map((node, index) => [node.id, obstacles.length + index]));
  const fits = new Map<string, MapDotTitleFit>();
  const order = [...nodes].sort((a, b) => Number(!!b.keep) - Number(!!a.keep) || b.priority - a.priority || a.id.localeCompare(b.id));
  for (const node of order) {
    const top = node.y + node.radius + node.gap;
    const words = node.words ?? [node.titleWidth], space = node.space ?? 0;
    // A fair share of the row: half the way to the nearest circle beside it that has a title of its own,
    // so one title wraps rather than taking the room its neighbor's title needs.
    let share = Infinity;
    if (!node.keep && node.maxLines && node.maxLines > 1) {
      const band = node.radius + node.gap + node.maxLines * node.titleHeight;
      for (const other of nodes) {
        if (other === node || !other.titleWidth || Math.abs(other.y - node.y) >= band) continue;
        share = Math.min(share, Math.abs(other.x - node.x) - TITLE_MARGIN);
      }
    }
    // Where circles sit too close for every title to say something, the busier ones show instead.
    if (share < MIN_SHARED_WIDTH) share = Infinity;
    const cap = Math.min(node.maxWidth ?? Infinity, share);
    const maxLines = Math.max(1, node.keep ? Math.max(KEPT_TITLE_LINES, node.maxLines ?? 1) : node.maxLines ?? 1);
    // Half the room beside the circle's center for a title this many lines tall.
    const room = (lines: number) => {
      if (node.keep) return Infinity;
      const bottom = top + lines * node.titleHeight + TITLE_MARGIN_BELOW;
      let half = Infinity;
      boxes.forEach((box, index) => {
        if (index === ownCircle.get(node.id) || box.y1 <= top || box.y0 >= bottom) return;
        if (box.x0 >= node.x) half = Math.min(half, box.x0 - node.x - TITLE_MARGIN);
        else if (box.x1 <= node.x) half = Math.min(half, node.x - box.x1 - TITLE_MARGIN);
        else half = 0;
      });
      return half;
    };
    const longest = Math.max(0, ...words);
    let fit: MapDotTitleFit | null = null;
    // The fewest lines at which the whole title fits.
    for (let lines = 1; lines <= maxLines && !fit; lines++) {
      const width = widthForLines(words, space, node.titleWidth, cap, lines, longest <= (node.maxWidth ?? Infinity) ? longest : 0);
      if (width !== null && width <= room(lines) * 2) fit = { width, lines };
    }
    if (!fit) {
      // Cut: the lines and width that show the most of it.
      let best: MapDotTitleFit = { width: 0, lines: 1 };
      for (let lines = 1; lines <= maxLines; lines++) {
        const width = Math.floor(Math.min(cap, node.titleWidth, room(lines) * 2));
        // A second line only once the first word fits whole on the first, so a word isn't split to fill it.
        if (lines > 1 && width < words[0]) break;
        if (width >= Math.min(node.titleWidth, MIN_TITLE_WIDTH) && width * lines > best.width * best.lines) best = { width, lines };
      }
      fit = best;
    }
    if (fit.width < node.titleWidth || fit.lines > 1) fits.set(node.id, fit);
    if (fit.width) boxes.push({ x0: node.x - fit.width / 2, y0: top, x1: node.x + fit.width / 2, y1: top + fit.lines * node.titleHeight });
  }
  return fits;
}

/** Titles of the larger circles are bold. */
export function mapDotTitleIsBold(diameter: number) {
  return diameter >= 28;
}

let measureContext: CanvasRenderingContext2D | null | undefined;
let measureFont = "system-ui, sans-serif";

/** Widths of a map title's words and of a space at its drawn size, in card pixels, so it can wrap. */
export function measureMapDotTitleWords(title: string, bold: boolean) {
  const words = title.trim().split(/\s+/).filter(Boolean);
  return { words: words.map((word) => measureMapDotTitle(word, bold)), space: measureMapDotTitle(" ", bold) || 3.5 };
}

/** Width of a map title at its drawn size (13px), in card pixels. */
export function measureMapDotTitle(title: string, bold: boolean) {
  if (measureContext === undefined) {
    try {
      measureContext = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
      const family = typeof document === "undefined" ? "" : getComputedStyle(document.documentElement).fontFamily;
      if (family) measureFont = family;
    } catch {
      measureContext = null;
    }
  }
  if (!measureContext) return title.length * (bold ? 7.6 : 7.1);
  measureContext.font = `${bold ? 650 : 500} 13px ${measureFont}`;
  return measureContext.measureText(title).width;
}
