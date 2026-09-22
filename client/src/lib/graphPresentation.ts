import type { Conversation, ConversationGroup } from "../types";
import type { ConversationGraphNodePlacement, ConversationGraphScene } from "./conversationGraph";
import type { GraphViewport } from "./graphInteractions";

export type MapScale = "groups" | "titles" | "working";

// These thresholds leave enough room for a readable label between ordinary
// nodes. The geometry of the saved map stays independent of its presentation.
export function getMapScale(scale: number): MapScale {
  return scale < 0.7 ? "groups" : scale < 1.25 ? "titles" : "working";
}

export function readableNodeSize(scale: number, selected = false) {
  return selected ? 1 / scale : Math.min(1.12, Math.max(0.9, scale)) / scale;
}

export function mapLabelsOverlap(nodes: ConversationGraphNodePlacement[], scale: number, footprint?: { width: number; height: number }, checkEveryScale = false) {
  if (scale >= 1.15 && !footprint && !checkEveryScale) return false;
  const factor = readableNodeSize(scale) * scale;
  const labels = nodes.map((node) => ({
    x: (node.x + node.width / 2) * scale, y: (node.y + node.height / 2) * scale,
    width: (footprint?.width ?? node.width * factor) + 12, height: (footprint?.height ?? node.height * factor) + 12,
  })).sort((a, b) => a.x - b.x);
  const maxWidth = Math.max(0, ...labels.map((label) => label.width));
  for (let index = 0; index < labels.length; index++) {
    const a = labels[index];
    for (let next = index + 1; next < labels.length && labels[next].x - a.x < maxWidth; next++) {
      const b = labels[next];
      if (Math.abs(a.x - b.x) < (a.width + b.width) / 2 && Math.abs(a.y - b.y) < (a.height + b.height) / 2) return true;
    }
  }
  return false;
}

export function centerNodeInCanvas(
  node: Pick<ConversationGraphNodePlacement, "x" | "y" | "width" | "height">,
  canvas: { width: number; height: number },
  scale: number,
): GraphViewport {
  // A sidebar or dock can occupy most of the window. Center in the usable
  // canvas so the topic remains visible while its sources are open.
  return {
    scale,
    x: canvas.width / 2 - (node.x + node.width / 2) * scale,
    y: canvas.height / 2 - (node.y + node.height / 2) * scale,
  };
}

export interface MapTerritory {
  id: string;
  label: string;
  color: string;
  nodes: ConversationGraphNodePlacement[];
  x: number;
  y: number;
}

export interface MapTerritoryBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const TERRITORY_PADDING = 22;
const TERRITORY_HEADING = 44;
export const OVERVIEW_NODE_FOOTPRINT = { width: 120, height: 60 };

const OVERVIEW_BOX = { minWidth: 160, minHeight: 120, gap: 20 };
const OVERVIEW_CARD = { width: 180, height: 96, gap: 24, padding: 24, heading: 64 };
const MIN_READABLE_TITLE_SIZE = 8;

function overviewWeight(territory: MapTerritory) {
  // A readable one-document label sets the floor. Log growth communicates
  // relative document counts without letting one large collection dominate.
  const count = Math.min(5, Math.log2(Math.max(1, territory.nodes.length)));
  return { width: 1 + count * 0.1, height: 1 + count * 0.075 };
}

function overviewCardGrid(territory: MapTerritory) {
  const columns = Math.max(1, Math.ceil(Math.sqrt(territory.nodes.length)));
  const rows = Math.ceil(territory.nodes.length / columns);
  const contentWidth = columns * OVERVIEW_CARD.width + (columns - 1) * OVERVIEW_CARD.gap;
  const contentHeight = rows * OVERVIEW_CARD.height + Math.max(0, rows - 1) * OVERVIEW_CARD.gap;
  return { columns, contentWidth, contentHeight,
    width: contentWidth + OVERVIEW_CARD.padding * 2,
    height: contentHeight + OVERVIEW_CARD.padding * 2 + OVERVIEW_CARD.heading };
}

function overviewColumns(territories: MapTerritory[], canvasWidth: number) {
  const count = territories.length;
  const gutter = Math.max(0, Math.min(24, canvasWidth / 10));
  const availableWidth = Math.max(0, canvasWidth - gutter * 2);
  let columns = Math.max(1, Math.min(count, Math.ceil(Math.sqrt(count)),
    Math.floor((Math.max(0, canvasWidth - gutter * 2) + OVERVIEW_BOX.gap) / (OVERVIEW_BOX.minWidth + OVERVIEW_BOX.gap))));
  // Choose rows from minimum readable widths, never from the live zoom. This
  // keeps the semantic ordering stable while the camera zooms in or out.
  while (columns > 1) {
    let fits = true;
    for (let index = 0; index < count; index += columns) {
      const row = territories.slice(index, index + columns);
      const width = row.reduce((sum, territory) => sum + OVERVIEW_BOX.minWidth * overviewWeight(territory).width, 0)
        + (row.length - 1) * OVERVIEW_BOX.gap;
      if (width > availableWidth) { fits = false; break; }
    }
    if (fits) break;
    columns--;
  }
  return columns;
}

/** Overview boxes summarize groups; their layout never changes saved card positions. */
export function layoutMapTerritoryOverview(territories: MapTerritory[], viewport: GraphViewport, canvasWidth: number) {
  const columns = overviewColumns(territories, canvasWidth);
  const sizes = territories.map((territory) => {
    const weight = overviewWeight(territory);
    const grid = overviewCardGrid(territory);
    return { width: Math.max(OVERVIEW_BOX.minWidth * weight.width, grid.width * viewport.scale),
      height: Math.max(OVERVIEW_BOX.minHeight * weight.height, grid.height * viewport.scale), grid };
  });
  const rows = Array.from({ length: Math.ceil(territories.length / columns) }, (_, index) => {
    const row = sizes.slice(index * columns, (index + 1) * columns);
    return { width: row.reduce((sum, size) => sum + size.width, 0) + (row.length - 1) * OVERVIEW_BOX.gap,
      height: Math.max(...row.map((size) => size.height)) };
  });
  const gridWidth = Math.max(0, ...rows.map((row) => row.width));
  const gridHeight = rows.reduce((sum, row) => sum + row.height, 0) + Math.max(0, rows.length - 1) * OVERVIEW_BOX.gap;
  let top = -gridHeight / 2;
  return rows.flatMap((row, rowIndex) => {
    // Alternate direction so adjacent semantic groups also stay adjacent at
    // row boundaries. The caller's order and the returned order are preserved.
    const reverse = rowIndex % 2 === 1;
    let left = reverse ? gridWidth / 2 : -gridWidth / 2;
    const placements = territories.slice(rowIndex * columns, (rowIndex + 1) * columns).map((territory, column) => {
      const { width, height, grid } = sizes[rowIndex * columns + column];
      const x = reverse ? left - width : left;
      const y = top + (row.height - height) / 2;
      const bounds = { x: x + viewport.x, y: y + viewport.y, width, height };
      const scale = Math.max(Number.EPSILON, viewport.scale);
      const titleFontSize = Math.min(13, 20 * scale);
      const nodeFootprint = { width: OVERVIEW_CARD.width * scale, height: OVERVIEW_CARD.height * scale,
        titleFontSize, titleLines: Math.max(1, Math.min(4, Math.floor((OVERVIEW_CARD.height * scale - titleFontSize * 0.8 - 2) / (titleFontSize * 1.3)))) };
      // Keep titles until their actual on-screen text or available line width
      // becomes unreadable, instead of switching at an unrelated map scale.
      const contentsVisible = territory.nodes.length > 0 && titleFontSize >= MIN_READABLE_TITLE_SIZE
        && nodeFootprint.width - titleFontSize * 1.2 - 2 >= 56;
      const headerBounds = { x: bounds.x + 12, y: bounds.y + Math.min(10, 12 * scale), width: bounds.width - 24,
        height: Math.min(44, OVERVIEW_CARD.heading * scale) };
      // These are temporary world coordinates for the grouped browsing stage.
      // Camera pan is applied by that stage, so it must not enter this layout.
      const displayNodes = contentsVisible ? territory.nodes.map((node, index) => ({ ...node,
        x: (x + (width - grid.contentWidth * scale) / 2) / scale
          + (index % grid.columns) * (OVERVIEW_CARD.width + OVERVIEW_CARD.gap) + OVERVIEW_CARD.width / 2 - node.width / 2,
        y: y / scale + OVERVIEW_CARD.padding + OVERVIEW_CARD.heading
          + Math.floor(index / grid.columns) * (OVERVIEW_CARD.height + OVERVIEW_CARD.gap) + OVERVIEW_CARD.height / 2 - node.height / 2,
      })) : [];
      left += (width + OVERVIEW_BOX.gap) * (reverse ? -1 : 1);
      return { ...territory, bounds, screenX: bounds.x + width / 2, screenY: bounds.y + height / 2,
        displayNodes, nodeFootprint, contentsVisible, headerBounds };
    });
    top += row.height + OVERVIEW_BOX.gap;
    return placements;
  });
}

/** Fit the same packed summary boxes that the overview renders. */
export function fitMapTerritoryOverview(territories: MapTerritory[], canvas: { width: number; height: number },
  options: Pick<FitMapTerritoryOptions, "padding" | "maxScale"> = {}): GraphViewport {
  const width = Math.max(0, canvas.width);
  const height = Math.max(0, canvas.height);
  const maxScale = Math.max(0.00001, Math.min(0.69, options.maxScale ?? 0.65));
  if (!territories.length) return { x: width / 2, y: height / 2, scale: maxScale };
  // The horizontal gutter matches layoutMapTerritoryOverview. Extra padding
  // reserves vertical room for controls without making phone labels narrower.
  const paddingX = Math.min(24, width / 10);
  const paddingY = Math.max(0, Math.min(options.padding ?? 24, height / 4));
  const boundsAtScale = (scale: number) => enclosingBounds(layoutMapTerritoryOverview(territories, { x: 0, y: 0, scale }, width).map((placement) => placement.bounds));
  const fits = (bounds: MapTerritoryBounds) => bounds.width <= width - paddingX * 2 && bounds.height <= height - paddingY * 2;
  // When all boxes cannot fit, retain readable dimensions and allow vertical
  // pan. Shrinking below this scale would not reveal any additional content.
  let scale = Math.min(maxScale, 0.5, ...territories.flatMap((territory) => {
    const weight = overviewWeight(territory), grid = overviewCardGrid(territory);
    return [OVERVIEW_BOX.minWidth * weight.width / grid.width, OVERVIEW_BOX.minHeight * weight.height / grid.height];
  }));
  if (fits(boundsAtScale(maxScale))) scale = maxScale;
  else if (fits(boundsAtScale(scale))) {
    let high = maxScale;
    // Weighted row bounds grow monotonically because their membership stays
    // fixed during zoom; fit exactly what the renderer will display.
    for (let step = 0; step < 40; step++) {
      const candidate = (scale + high) / 2;
      if (fits(boundsAtScale(candidate))) scale = candidate;
      else high = candidate;
    }
  }
  const bounds = boundsAtScale(scale);
  return { scale, x: (width - bounds.width) / 2 - bounds.x,
    y: bounds.height <= height - paddingY * 2 ? (height - bounds.height) / 2 - bounds.y : paddingY - bounds.y };
}

/** Leave room for map controls while keeping heading rows within narrow maps. */
export function mapTerritoryHeadingWidth(canvasWidth: number) {
  return Math.max(80, canvasWidth - Math.min(64, canvasWidth / 10) * 2);
}

function enclosingBounds(bounds: MapTerritoryBounds[], fallback = { x: 0, y: 0 }): MapTerritoryBounds {
  if (!bounds.length) return { ...fallback, width: 0, height: 0 };
  const x = Math.min(...bounds.map((item) => item.x));
  const y = Math.min(...bounds.map((item) => item.y));
  return { x, y, width: Math.max(...bounds.map((item) => item.x + item.width)) - x,
    height: Math.max(...bounds.map((item) => item.y + item.height)) - y };
}

/** The actual saved geometry, independent of the camera and group summaries. */
export function getMapTerritoryBounds(territory: MapTerritory): MapTerritoryBounds {
  return enclosingBounds(territory.nodes, { x: territory.x, y: territory.y });
}

/** Screen bounds include readable cards and room for the group's heading. */
export function getMapTerritoryScreenBounds(
  territory: MapTerritory,
  viewport: GraphViewport,
  selectedNodeId?: string | null,
  nodeFootprint?: { width: number; height: number },
): MapTerritoryBounds {
  const factor = (selected: boolean) => selected ? 1 : Math.min(1.12, Math.max(0.9, viewport.scale));
  const bounds = enclosingBounds(territory.nodes.map((node) => {
    const size = factor(node.conversationId === selectedNodeId);
    const width = nodeFootprint?.width ?? node.width * size;
    const height = nodeFootprint?.height ?? node.height * size;
    return { x: viewport.x + (node.x + node.width / 2) * viewport.scale - width / 2,
      y: viewport.y + (node.y + node.height / 2) * viewport.scale - height / 2, width, height };
  }), { x: viewport.x + territory.x * viewport.scale, y: viewport.y + territory.y * viewport.scale });
  return { x: bounds.x - TERRITORY_PADDING, y: bounds.y - TERRITORY_PADDING - TERRITORY_HEADING,
    width: bounds.width + TERRITORY_PADDING * 2, height: bounds.height + TERRITORY_PADDING * 2 + TERRITORY_HEADING };
}

export interface FitMapTerritoryOptions {
  /** Space outside the territory, in screen pixels. */
  padding?: number;
  maxScale?: number;
  selectedNodeId?: string | null;
  /** Optional compact cards measured in screen pixels, centered on saved nodes. */
  nodeFootprint?: { width: number; height: number };
}

/** Fit the visible regions without imposing a zoom floor that crops mobile maps. */
export function fitMapTerritories(
  territories: MapTerritory[],
  canvas: { width: number; height: number },
  options: FitMapTerritoryOptions = {},
): GraphViewport {
  const width = Math.max(0, canvas.width);
  const height = Math.max(0, canvas.height);
  const padding = Math.max(0, Math.min(options.padding ?? 24, width / 10, height / 10));
  const maxScale = Math.max(Number.EPSILON, options.maxScale ?? 1.15);
  const populated = territories.filter((territory) => territory.nodes.length);
  if (!populated.length) return { x: width / 2, y: height / 2, scale: maxScale };
  const regionsAtScale = (scale: number) => populated.map((territory) =>
    getMapTerritoryScreenBounds(territory, { x: 0, y: 0, scale }, options.selectedNodeId, options.nodeFootprint));
  const fits = (bounds: MapTerritoryBounds) => bounds.width <= width - padding * 2 && bounds.height <= height - padding * 2;
  let low = 0;
  let high = maxScale;
  // Screen card footprints stop shrinking at 90%, so a raw-world bounding-box
  // division would crop outer cards. Solve against their displayed rectangles.
  for (let step = 0; step < 52; step++) {
    const candidate = (low + high) / 2;
    const bounds = enclosingBounds(regionsAtScale(candidate));
    if (fits(bounds)) low = candidate;
    else high = candidate;
  }
  // Fixed-size cards cannot shrink into a canvas shorter than a single card.
  // Preserve a useful spatial camera in that case, instead of collapsing every
  // node onto one pixel with an epsilon zoom. A later resize can fit normally.
  const world = enclosingBounds(populated.map(getMapTerritoryBounds));
  const fallbackScale = width && height ? Math.min(maxScale,
    Math.max(1, width - padding * 2 - TERRITORY_PADDING * 2) / Math.max(1, world.width),
    Math.max(1, height - padding * 2 - TERRITORY_PADDING * 2 - TERRITORY_HEADING) / Math.max(1, world.height)) : maxScale;
  let scale = low > 0 ? low : fallbackScale;
  let bounds = enclosingBounds(regionsAtScale(scale));
  // Heading placement changes discretely as labels collide, so it is not a
  // monotonic input to binary search. Try a bounded series of smaller spatial
  // fits; if fixed-size labels cannot all fit, keep the healthy region camera.
  for (let step = 0; step < 20; step++) {
    const candidate = scale * 0.8 ** step;
    const regions = regionsAtScale(candidate);
    const combined = enclosingBounds([...regions, ...placeMapTerritoryHeadings(regions, "overview", { maxWidth: mapTerritoryHeadingWidth(width) })]);
    // If there are more labels than the screen can hold, center their width
    // while keeping the actual map vertically centered and available to pan.
    if (step === 0) bounds = { ...bounds, x: combined.x, width: combined.width };
    if (fits(combined)) { scale = candidate; bounds = combined; break; }
  }
  return { scale, x: (width - bounds.width) / 2 - bounds.x, y: (height - bounds.height) / 2 - bounds.y };
}

export function fitMapTerritory(
  territory: MapTerritory,
  canvas: { width: number; height: number },
  options: FitMapTerritoryOptions = {},
): GraphViewport {
  return fitMapTerritories([territory], canvas, options);
}

/** Dense groups temporarily space their real cards; saved positions stay intact. */
export function layoutFocusedMapTerritory(territory: MapTerritory, canvas: { width: number; height: number }, options: FitMapTerritoryOptions = {}) {
  const standard = fitMapTerritory(territory, canvas, options);
  if (standard.scale >= 0.7 && !mapLabelsOverlap(territory.nodes, standard.scale, undefined, true)) {
    return { territory, viewport: standard, nodeFootprint: undefined, arranged: false };
  }
  const compactOptions = { ...options, nodeFootprint: OVERVIEW_NODE_FOOTPRINT, maxScale: 0.69 };
  const compact = fitMapTerritory(territory, canvas, compactOptions);
  if (!mapLabelsOverlap(territory.nodes, compact.scale, OVERVIEW_NODE_FOOTPRINT)) {
    return { territory, viewport: compact, nodeFootprint: OVERVIEW_NODE_FOOTPRINT, arranged: false };
  }
  const scale = 0.69;
  const padding = Math.max(0, Math.min(options.padding ?? 24, canvas.width / 10, canvas.height / 10));
  const usableWidth = Math.max(140, canvas.width - padding * 2 - TERRITORY_PADDING * 2);
  const usableHeight = Math.max(88, canvas.height - padding * 2 - TERRITORY_PADDING * 2 - TERRITORY_HEADING);
  const columns = Math.max(1, Math.min(territory.nodes.length,
    Math.floor((usableWidth + 40) / 180),
    Math.ceil(Math.sqrt(territory.nodes.length * usableWidth / usableHeight * 88 / 180))));
  const nodeFootprint = { width: Math.max(140, Math.min(200, Math.floor((usableWidth - (columns - 1) * 56) / columns))), height: 88 };
  const gapX = Math.ceil(nodeFootprint.width * 0.28);
  const gapY = 26;
  const rows = Math.ceil(territory.nodes.length / columns);
  const gridWidth = columns * nodeFootprint.width + (columns - 1) * gapX;
  const gridHeight = rows * nodeFootprint.height + (rows - 1) * gapY;
  const authored = getMapTerritoryBounds(territory);
  const center = { x: authored.x + authored.width / 2, y: authored.y + authored.height / 2 };
  const nodes = territory.nodes.map((node, index) => ({ ...node,
    x: center.x + ((index % columns) * (nodeFootprint.width + gapX) + nodeFootprint.width / 2 - gridWidth / 2) / scale - node.width / 2,
    y: center.y + (Math.floor(index / columns) * (nodeFootprint.height + gapY) + nodeFootprint.height / 2 - gridHeight / 2) / scale - node.height / 2,
  }));
  const displayed = { ...territory, nodes, x: center.x, y: center.y };
  const bounds = getMapTerritoryScreenBounds(displayed, { x: 0, y: 0, scale }, null, nodeFootprint);
  // Large phone groups remain readable and pannable rather than reducing cards
  // to symbols. Start at the first row whenever the full grid is taller.
  const viewport = { scale, x: (canvas.width - bounds.width) / 2 - bounds.x,
    y: bounds.height <= canvas.height - padding * 2 ? (canvas.height - bounds.height) / 2 - bounds.y : padding - bounds.y };
  return { territory: displayed, viewport, nodeFootprint, arranged: true };
}

export function fitFocusedMapTerritory(territory: MapTerritory, canvas: { width: number; height: number }, options: FitMapTerritoryOptions = {}) {
  return layoutFocusedMapTerritory(territory, canvas, options).viewport;
}

/** Keep overlapping groups discoverable without moving any of their nodes. */
export function placeMapTerritoryHeadings(regions: MapTerritoryBounds[], mode: "overview" | "canvas",
  options: { priorityIndex?: number; obstacles?: MapTerritoryBounds[]; maxWidth?: number } = {}) {
  const targets = regions.map((region) => ({ x: region.x + 12, y: region.y + 10,
    width: Math.max(80, Math.min(mode === "overview" ? 272 : 300, region.width - 24, options.maxWidth ?? Infinity)),
    height: mode === "overview" ? 58 : 44 }));
  const minimumX = Math.min(...targets.map((target) => target.x));
  const minimumY = Math.min(...targets.map((target) => target.y));
  const maximumX = minimumX + (options.maxWidth ?? Infinity);
  const occupied: MapTerritoryBounds[] = [];
  const results = [...targets];
  const overlaps = (a: MapTerritoryBounds, b: MapTerritoryBounds) =>
    a.x < b.x + b.width + 8 && a.x + a.width + 8 > b.x && a.y < b.y + b.height + 8 && a.y + a.height + 8 > b.y;
  for (const { target: anchor, index } of targets.map((target, index) => ({ target, index })).sort((a, b) =>
    Number(b.index === options.priorityIndex) - Number(a.index === options.priorityIndex)
      || a.target.y - b.target.y || a.target.x - b.target.x || a.index - b.index)) {
    // Keep the focused heading at its fitted anchor. Neighbor labels yield to
    // readable node cards so they cannot cover the group's selectable content.
    const active = index === options.priorityIndex;
    const target = active ? anchor : { ...anchor, x: Math.min(anchor.x, maximumX - anchor.width) };
    const blockers = active ? occupied : [...occupied, ...(options.obstacles ?? [])];
    const candidates = [target, ...blockers.flatMap((other) => [
      { ...target, x: other.x + other.width + 8 }, { ...target, x: other.x - target.width - 8 },
      { ...target, y: other.y + other.height + 8 }, { ...target, y: other.y - target.height - 8 },
      // Shared column edges avoid wasting a narrow screen on small differences
      // between neighboring groups' saved horizontal positions.
      ...(Number.isFinite(maximumX) ? [
        { ...target, x: minimumX, y: other.y + other.height + 8 },
        { ...target, x: maximumX - target.width, y: other.y },
        { ...target, x: maximumX - target.width, y: other.y + other.height + 8 },
      ] : []),
    ])].filter((candidate) => candidate.x >= minimumX && candidate.y >= minimumY && (active || candidate.x + candidate.width <= maximumX))
      .sort((a, b) => (a.x - target.x) ** 2 + (a.y - target.y) ** 2 - (b.x - target.x) ** 2 - (b.y - target.y) ** 2);
    const placement = candidates.find((candidate) => !blockers.some((other) => overlaps(candidate, other))) ?? target;
    occupied.push(placement);
    results[index] = placement;
  }
  return results;
}

export function buildMapTerritories(scene: ConversationGraphScene, groups: Record<string, ConversationGroup>): MapTerritory[] {
  const assigned = new Set<string>();
  const territories: MapTerritory[] = [];
  function add(id: string, label: string, color: string, nodes: ConversationGraphNodePlacement[]) {
    if (!nodes.length) return;
    nodes.forEach((node) => assigned.add(node.conversationId));
    territories.push({ id, label, color, nodes,
      x: nodes.reduce((sum, node) => sum + node.x + node.width / 2, 0) / nodes.length,
      y: nodes.reduce((sum, node) => sum + node.y + node.height / 2, 0) / nodes.length,
    });
  }
  for (const group of Object.values(groups)) {
    const ids = new Set(group.conversationIds);
    add(group.id, group.name, group.color, scene.nodes.filter((node) => ids.has(node.conversationId) && !assigned.has(node.conversationId)));
  }
  add("__ungrouped__", "Ungrouped", "var(--muted)", scene.nodes.filter((node) => !assigned.has(node.conversationId)));
  return territories;
}

// Use screen coordinates for group labels. A nearby free cell prevents labels
// from overlapping at extreme zoom without changing any saved node positions.
export function placeMapTerritories(territories: MapTerritory[], viewport: GraphViewport) {
  const occupied = new Set<string>();
  const origin = territories[0] ?? { x: 0, y: 0 };
  return territories.map((territory) => {
    const targetX = Math.round((territory.x - origin.x) * viewport.scale / 252);
    const targetY = Math.round((territory.y - origin.y) * viewport.scale / 184);
    let column = targetX;
    let row = targetY;
    for (let radius = 0; occupied.has(`${column}:${row}`); radius++) {
      const candidates = [];
      for (let dx = -radius - 1; dx <= radius + 1; dx++) {
        for (let dy = -radius - 1; dy <= radius + 1; dy++) {
          if (!occupied.has(`${targetX + dx}:${targetY + dy}`)) candidates.push({ dx, dy });
        }
      }
      candidates.sort((a, b) => a.dx * a.dx + a.dy * a.dy - b.dx * b.dx - b.dy * b.dy);
      if (candidates[0]) { column = targetX + candidates[0].dx; row = targetY + candidates[0].dy; }
    }
    occupied.add(`${column}:${row}`);
    return { ...territory, screenX: viewport.x + origin.x * viewport.scale + column * 252,
      screenY: viewport.y + origin.y * viewport.scale + row * 184 };
  });
}

export type MapConnections = Record<string, Pick<Conversation, "parentId" | "linkedConversationIds">>;
export function territoryConnections(territories: MapTerritory[], conversations: MapConnections) {
  const membership = new Map(territories.flatMap((territory) => territory.nodes.map((node) => [node.conversationId, territory.id] as const)));
  const connections = new Map<string, { from: string; to: string; count: number }>();
  const seen = new Set<string>();
  for (const [id, conversation] of Object.entries(conversations)) {
    for (const target of [conversation.parentId, ...(conversation.linkedConversationIds ?? [])]) {
      if (!target) continue;
      const from = membership.get(id);
      const to = membership.get(target);
      const pair = [id, target].sort().join(":");
      if (!from || !to || from === to || seen.has(pair)) continue;
      seen.add(pair);
      const key = [from, to].sort().join(":");
      const connection = connections.get(key);
      if (connection) connection.count++;
      else connections.set(key, { from, to, count: 1 });
    }
  }
  return [...connections.values()];
}
