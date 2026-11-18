/**
 * Explore as a library (thread "Build Explore layouts: Tiles and Clusters"): the vault as sections
 * inside sections, the way a library has Science › Biology › Aging, so a person can browse without
 * knowing what to search for. The sections are the Map's own: themes hold topics, topics hold
 * blocks of alike notes, and blocks hold notes. Explore draws the same sections in several layouts
 * (Tiles, Clusters, and the free Canvas), and every layout shares one path through them.
 */
import { writeSyncedSetting } from "./interfaceSettings";

export type ExploreLayout = "tiles" | "clusters" | "canvas";
export const EXPLORE_LAYOUTS: readonly ExploreLayout[] = ["tiles", "clusters", "canvas"];
export const EXPLORE_LAYOUT_LABELS: Record<ExploreLayout, { name: string; description: string }> = {
  tiles: { name: "Tiles", description: "Sections as rooms, sized by what's inside" },
  clusters: { name: "Clusters", description: "A graph that splits into sections as you zoom" },
  canvas: { name: "Canvas", description: "Every note on one board you can arrange" },
};
const LAYOUT_SETTING = "margin-chat:explore-layout" as const;

/** Tiles is the simplest to read, so it is where Explore starts. */
export function readExploreLayout(): ExploreLayout {
  let value: string | null = null;
  try { value = localStorage.getItem(LAYOUT_SETTING); } catch { /* Private windows start on Tiles. */ }
  return value && (EXPLORE_LAYOUTS as readonly string[]).includes(value) ? value as ExploreLayout : "tiles";
}

export function writeExploreLayout(layout: ExploreLayout) {
  writeSyncedSetting(LAYOUT_SETTING, layout);
}

export interface LibrarySection {
  id: string;
  label: string;
  /** One sentence on what is inside, when AI wrote one. */
  summary?: string;
  color: string;
  /** Sections inside this one. A section holds sections or notes, never both. */
  sections: LibrarySection[];
  /** Notes on this shelf, when it has no sections. */
  noteIds: string[];
  /** Every note anywhere inside. */
  allIds: string[];
}

export interface LibraryInput {
  themes: Array<{ id: string; label: string; color: string; boxIds: string[] }>;
  boxes: Array<{ id: string; label: string; color: string; kind: "group" | "none"; conversationIds: string[];
    blocks?: Array<{ id: string; kind: "alike" | "family"; conversationIds: string[] }> }>;
  /** Names for blocks of alike notes. */
  blockNames: ReadonlyMap<string, string>;
  summaries?: ReadonlyMap<string, string>;
  titleOf: (id: string) => string;
}

export const LIBRARY_ROOT_ID = "library";

function section(id: string, label: string, color: string, sections: LibrarySection[], noteIds: string[], summary?: string): LibrarySection {
  const allIds = sections.length ? sections.flatMap((child) => child.allIds) : noteIds;
  return { id, label, color, sections, noteIds: sections.length ? [] : noteIds, allIds, ...(summary ? { summary } : {}) };
}

/** A section holding a single section says nothing on its own: its child takes its place, under the outer name. */
function collapse(node: LibrarySection): LibrarySection {
  const sections = node.sections.map(collapse);
  if (sections.length === 1) {
    const only = sections[0];
    return { ...node, sections: only.sections, noteIds: only.noteIds, allIds: only.allIds };
  }
  return { ...node, sections };
}

/**
 * The library from the Map's themes, topic boxes and blocks. A topic with several blocks gets a
 * section per block, named like the Map names them (a family block after its main note); the notes
 * outside every block go on a shelf of their own. Biggest sections first, so the eye lands on them.
 */
export function buildLibrary({ themes, boxes, blockNames, summaries, titleOf }: LibraryInput): LibrarySection {
  const boxSection = (box: LibraryInput["boxes"][number]): LibrarySection | null => {
    if (!box.conversationIds.length) return null;
    const blocks = (box.blocks ?? []).filter((block) => block.conversationIds.length);
    if (blocks.length < 2) return section(box.id, box.label, box.color, [], box.conversationIds, summaries?.get(box.id));
    const inBlocks = new Set(blocks.flatMap((block) => block.conversationIds));
    const loose = box.conversationIds.filter((id) => !inBlocks.has(id));
    const children = blocks.map((block) => section(block.id,
      block.kind === "alike" ? blockNames.get(block.id) ?? titleOf(block.conversationIds[0]) : titleOf(block.conversationIds[0]),
      box.color, [], block.conversationIds, summaries?.get(block.id)));
    if (loose.length) children.push(section(`${box.id}:more`, "More notes", box.color, [], loose));
    return section(box.id, box.label, box.color, bySize(children), [], summaries?.get(box.id));
  };
  const byId = new Map(boxes.map((box) => [box.id, box]));
  const placed = new Set<string>();
  const top: LibrarySection[] = [];
  for (const theme of themes) {
    const children = theme.boxIds.flatMap((id) => { placed.add(id); const box = byId.get(id); const made = box ? boxSection(box) : null; return made ? [made] : []; });
    if (children.length) top.push(section(theme.id, theme.label, theme.color, bySize(children), [], summaries?.get(theme.id)));
  }
  for (const box of boxes) {
    if (placed.has(box.id)) continue;
    const made = boxSection(box);
    if (made) top.push(made);
  }
  // Notes nobody could file (no links, no meaning yet) still belong in the library, at the end.
  const sorted = bySize(top.filter((item) => item.id !== "__no-group__"));
  const unfiled = top.find((item) => item.id === "__no-group__");
  const root = section(LIBRARY_ROOT_ID, "All notes", "var(--muted)", unfiled ? [...sorted, unfiled] : sorted, []);
  return { ...root, sections: root.sections.map(collapse) };
}

function bySize(sections: LibrarySection[]) {
  return [...sections].sort((a, b) => b.allIds.length - a.allIds.length || a.label.localeCompare(b.label));
}

/** The sections from the root down to the one with this id; just the root when it is gone. */
export function libraryPath(root: LibrarySection, ids: readonly string[]): LibrarySection[] {
  const path = [root];
  for (const id of ids) {
    const next = path[path.length - 1].sections.find((child) => child.id === id);
    if (!next) break;
    path.push(next);
  }
  return path;
}

/** The path to the section holding a note, so a note opened elsewhere can be found on its shelf. */
export function pathToNote(root: LibrarySection, noteId: string): string[] {
  const walk = (node: LibrarySection, trail: string[]): string[] | null => {
    if (node.noteIds.includes(noteId)) return trail;
    for (const child of node.sections) {
      if (!child.allIds.includes(noteId)) continue;
      const found = walk(child, [...trail, child.id]);
      if (found) return found;
    }
    return null;
  };
  return walk(root, []) ?? [];
}

/* ---------- Tiles: a squarified treemap ---------- */

export interface TileRect { index: number; x: number; y: number; width: number; height: number }

/**
 * Rooms for the sections, sized by how many notes each holds, as close to square as the space
 * allows (squarified treemap, Bruls et al.). Values below `minShare` of the total are raised to it,
 * so a one-note section still gets a room you can read.
 */
export function squarify(values: number[], width: number, height: number, gap = 12, minShare = 0.035): TileRect[] {
  if (!values.length || width <= 0 || height <= 0) return [];
  const total0 = values.reduce((sum, value) => sum + Math.max(0, value), 0) || values.length;
  const floor = total0 * minShare;
  const items = values.map((value, index) => ({ index, value: Math.max(floor, value || 0) }))
    .sort((a, b) => b.value - a.value);
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const scale = (width * height) / total;
  const rects: TileRect[] = [];
  let x = 0, y = 0, w = width, h = height;
  let row: typeof items = [];
  const worst = (candidate: typeof items, side: number) => {
    const areas = candidate.map((item) => item.value * scale);
    const sum = areas.reduce((a, b) => a + b, 0);
    const max = Math.max(...areas), min = Math.min(...areas);
    return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
  };
  const layRow = (cells: typeof items) => {
    const area = cells.reduce((sum, item) => sum + item.value * scale, 0);
    if (w >= h) {
      const rowWidth = area / h;
      let cy = y;
      for (const cell of cells) { const cellHeight = (cell.value * scale) / rowWidth; rects.push({ index: cell.index, x, y: cy, width: rowWidth, height: cellHeight }); cy += cellHeight; }
      x += rowWidth; w -= rowWidth;
    } else {
      const rowHeight = area / w;
      let cx = x;
      for (const cell of cells) { const cellWidth = (cell.value * scale) / rowHeight; rects.push({ index: cell.index, x: cx, y, width: cellWidth, height: rowHeight }); cx += cellWidth; }
      y += rowHeight; h -= rowHeight;
    }
  };
  for (const item of items) {
    const side = Math.min(w, h);
    if (!row.length || worst([...row, item], side) <= worst(row, side)) row.push(item);
    else { layRow(row); row = [item]; }
  }
  if (row.length) layRow(row);
  // Gaps between rooms: each room gives up half the gap on every inner side.
  const half = gap / 2;
  return rects.map((rect) => {
    const left = rect.x > 0.5 ? half : 0, top = rect.y > 0.5 ? half : 0;
    const right = rect.x + rect.width < width - 0.5 ? half : 0, bottom = rect.y + rect.height < height - 0.5 ? half : 0;
    return { index: rect.index, x: rect.x + left, y: rect.y + top, width: Math.max(0, rect.width - left - right), height: Math.max(0, rect.height - top - bottom) };
  }).sort((a, b) => a.index - b.index);
}

/** Below this width rooms stack as full-width tiles (a phone), instead of a treemap of slivers. */
export const STACK_ROOMS_BELOW = 560;

/**
 * Lays rooms out for the space they get: a treemap when there is room, or on a phone a list of
 * full-width tiles, biggest first, taller for bigger rooms, that scrolls. `height` is how tall
 * the whole layout is (for a stack, more than the space it scrolls in).
 */
export function layRooms(values: number[], width: number, height: number, gap = 12): { rects: TileRect[]; height: number; stacked: boolean } {
  if (width >= STACK_ROOMS_BELOW) return { rects: squarify(values, width, height, gap), height, stacked: false };
  if (!values.length || width <= 0) return { rects: [], height: 0, stacked: true };
  const max = Math.max(1, ...values);
  const order = values.map((value, index) => ({ index, value })).sort((a, b) => b.value - a.value);
  const rects: TileRect[] = [];
  let y = 0;
  for (const item of order) {
    const tall = Math.round(76 + 84 * Math.sqrt(Math.max(0, item.value) / max));
    rects.push({ index: item.index, x: 0, y, width, height: tall });
    y += tall + gap;
  }
  return { rects: rects.sort((a, b) => a.index - b.index), height: Math.max(0, y - gap), stacked: true };
}

/* ---------- Clusters: circles inside circles ---------- */

export interface PackedCircle {
  id: string;
  /** "section" circles open into what they hold; "note" circles are single notes. */
  kind: "section" | "note";
  section?: LibrarySection;
  noteId?: string;
  x: number;
  y: number;
  r: number;
  depth: number;
  parentId: string | null;
  color: string;
}

const NOTE_RADIUS = 10;

/**
 * Places circles of the given radii without overlap, as close to their middle as they fit: the
 * biggest first, each next one at the free spot nearest the centre. Returns centres relative to
 * the middle and the radius of the circle around them all.
 */
export function packCircles(radii: number[], padding: number): { centers: Array<{ x: number; y: number }>; radius: number } {
  const order = radii.map((r, index) => ({ r, index })).sort((a, b) => b.r - a.r);
  const placed: Array<{ x: number; y: number; r: number; index: number }> = [];
  for (const item of order) {
    if (!placed.length) { placed.push({ x: 0, y: 0, r: item.r, index: item.index }); continue; }
    let best: { x: number; y: number; d: number } | null = null;
    // Candidate spots: touching each placed circle, all the way round it.
    for (const other of placed) {
      const reach = other.r + item.r + padding;
      for (let step = 0; step < 36; step++) {
        const angle = (step / 36) * Math.PI * 2 + other.index * 0.37;
        const x = other.x + Math.cos(angle) * reach, y = other.y + Math.sin(angle) * reach;
        const d = Math.hypot(x, y);
        if (best && d >= best.d) continue;
        if (placed.every((p) => Math.hypot(p.x - x, p.y - y) >= p.r + item.r + padding - 0.01)) best = { x, y, d };
      }
    }
    const spot = best ?? { x: 0, y: placed.reduce((max, p) => Math.max(max, p.y + p.r), 0) + item.r + padding, d: 0 };
    placed.push({ x: spot.x, y: spot.y, r: item.r, index: item.index });
  }
  // Re-centre on the middle of the pack, then measure it.
  const minX = Math.min(...placed.map((p) => p.x - p.r)), maxX = Math.max(...placed.map((p) => p.x + p.r));
  const minY = Math.min(...placed.map((p) => p.y - p.r)), maxY = Math.max(...placed.map((p) => p.y + p.r));
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const centers: Array<{ x: number; y: number }> = new Array(radii.length);
  let radius = 0;
  for (const p of placed) {
    centers[p.index] = { x: p.x - cx, y: p.y - cy };
    radius = Math.max(radius, Math.hypot(p.x - cx, p.y - cy) + p.r);
  }
  return { centers, radius };
}

/** Every circle of the library, sections around what they hold, in world units around (0, 0). */
export function packLibrary(root: LibrarySection): PackedCircle[] {
  type Packed = { radius: number; place: (x: number, y: number, depth: number, parentId: string | null, out: PackedCircle[]) => void };
  const pack = (node: LibrarySection): Packed => {
    const children: Packed[] = node.sections.length ? node.sections.map(pack)
      : node.noteIds.map((noteId) => ({ radius: NOTE_RADIUS, place: (x, y, depth, parentId, out) => out.push({ id: `note:${node.id}:${noteId}`, kind: "note", noteId, x, y, r: NOTE_RADIUS, depth, parentId, color: node.color }) }));
    const padding = node.sections.length ? 14 : 8;
    const { centers, radius: inner } = packCircles(children.map((child) => child.radius), padding);
    // Room inside the edge for the section's name, which sits along the top once it opens.
    const radius = Math.max(NOTE_RADIUS * 2, inner + padding + (node.sections.length ? 18 : 10));
    return { radius, place: (x, y, depth, parentId, out) => {
      out.push({ id: node.id, kind: "section", section: node, x, y, r: radius, depth, parentId, color: node.color });
      const offset = node.sections.length ? 8 : 6; // nudged down a little, under the name
      children.forEach((child, at) => child.place(x + centers[at].x, y + centers[at].y + offset, depth + 1, node.id, out));
    } };
  };
  const out: PackedCircle[] = [];
  pack(root).place(0, 0, 0, null, out);
  return out;
}

/** Links between notes, drawn between whatever stands for each end at the current depth. */
export function groupLinks(links: Array<{ sourceId: string; targetId: string }>, standIn: (noteId: string) => string | null) {
  const counts = new Map<string, { a: string; b: string; count: number }>();
  for (const { sourceId, targetId } of links) {
    const a = standIn(sourceId), b = standIn(targetId);
    if (!a || !b || a === b) continue;
    const [first, second] = a < b ? [a, b] : [b, a];
    const key = `${first}\u0000${second}`;
    const entry = counts.get(key);
    if (entry) entry.count++;
    else counts.set(key, { a: first, b: second, count: 1 });
  }
  return [...counts.values()];
}
