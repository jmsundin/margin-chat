/**
 * Map documents drawn as a circle with the title below it. The circle grows
 * with the document's connections; a title that would run into a neighbor is
 * cut short (the CSS adds the "…") so it never covers another circle or title.
 */

const MIN_DIAMETER = 14;
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
  titleHeight: number;
  /** Higher claims space first. */
  priority: number;
}

export interface MapBox { x0: number; y0: number; x1: number; y1: number }

/** Space kept clear between a title and whatever is beside it. */
const TITLE_MARGIN = 6;
/** A cut title still shows a few letters before the "…"; with less room it hides. */
const MIN_TITLE_WIDTH = 48;

/**
 * Widths for the titles that must be cut, keyed by id; 0 hides a title with no room. Titles are centered
 * under their circle; each one may grow until it meets another circle, a
 * title already placed, or one of `obstacles` (such as an open preview card).
 * More connected documents are placed first, so they keep their full title.
 */
export function fitMapDotTitles(nodes: MapDotTitle[], obstacles: MapBox[] = []) {
  const boxes: MapBox[] = [...obstacles, ...nodes.map((node) => ({
    x0: node.x - node.radius, y0: node.y - node.radius, x1: node.x + node.radius, y1: node.y + node.radius,
  }))];
  const ownCircle = new Map(nodes.map((node, index) => [node.id, obstacles.length + index]));
  const widths = new Map<string, number>();
  const order = [...nodes].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  for (const node of order) {
    const top = node.y + node.radius + node.gap, bottom = top + node.titleHeight;
    let half = node.titleWidth / 2;
    boxes.forEach((box, index) => {
      if (index === ownCircle.get(node.id) || box.y1 <= top || box.y0 >= bottom) return;
      if (box.x0 >= node.x) half = Math.min(half, box.x0 - node.x - TITLE_MARGIN);
      else if (box.x1 <= node.x) half = Math.min(half, node.x - box.x1 - TITLE_MARGIN);
      else half = 0;
    });
    const width = half * 2 >= Math.min(node.titleWidth, MIN_TITLE_WIDTH) ? Math.min(node.titleWidth, half * 2) : 0;
    if (width < node.titleWidth) widths.set(node.id, width);
    if (width) boxes.push({ x0: node.x - width / 2, y0: top, x1: node.x + width / 2, y1: bottom });
  }
  return widths;
}

/** Titles of the larger circles are bold. */
export function mapDotTitleIsBold(diameter: number) {
  return diameter >= 28;
}

let measureContext: CanvasRenderingContext2D | null | undefined;
let measureFont = "system-ui, sans-serif";

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
