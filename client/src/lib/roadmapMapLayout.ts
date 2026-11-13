/**
 * The Map layout of a roadmap: each stage is a box of steps, stages run left to
 * right and wrap onto a new row when a row gets too wide. A step whose document
 * is a roadmap of its own can open that roadmap in a box right beside it; the
 * stages after it move aside (or down a row) to make room. Sub-roadmaps nest
 * the same way, to any depth.
 *
 * Pure geometry: the view decides which sub-roadmaps are open and what is drawn.
 */

export const MAP_STEP_WIDTH = 216;
export const MAP_STEP_HEIGHT = 38;
const STEP_GAP = 10;
const STAGE_PAD = 14;
const STAGE_HEAD = 44;
const STAGE_GAP = 64;
const ROW_GAP = 70;
const SUB_OFFSET = 48;
const SUB_HEAD = 46;
const SUB_PAD = 16;
const SUB_GAP = 18;
export const MAP_STAGE_WIDTH = MAP_STEP_WIDTH + STAGE_PAD * 2;
export const MAP_SUB_HEAD = SUB_HEAD;

export interface MapLayoutStage { id: string; title: string; nodeIds: string[] }
export interface MapLayoutRoadmap {
  id: string;
  stages: MapLayoutStage[];
  /** The open roadmap of one of this roadmap's steps, or null when it has none or it is closed. */
  sub: (nodeId: string) => MapLayoutRoadmap | null;
}

export type MapItemKind = "stage" | "step" | "sub";
export interface MapItem {
  /** Unique across nested roadmaps: `<roadmapId>/<stage or node id>`, prefixed by kind. */
  key: string;
  kind: MapItemKind;
  /** Roadmap the stage or step belongs to; for a sub box, the roadmap it shows. */
  roadmapId: string;
  /** Stage id, node id, or (for a sub box) the parent step's node id. */
  id: string;
  /** For a sub box, the roadmap holding the parent step. */
  parentRoadmapId?: string;
  x: number; y: number; w: number; h: number;
  depth: number;
}

export const mapStepKey = (roadmapId: string, nodeId: string) => `step:${roadmapId}/${nodeId}`;
export const mapStageKey = (roadmapId: string, stageId: string) => `stage:${roadmapId}/${stageId}`;
export const mapSubKey = (roadmapId: string, nodeId: string) => `sub:${roadmapId}/${nodeId}`;

function placeStage(roadmap: MapLayoutRoadmap, stage: MapLayoutStage, x: number, top: number, out: MapItem[], depth: number) {
  const h = STAGE_HEAD + Math.max(1, stage.nodeIds.length) * (MAP_STEP_HEIGHT + STEP_GAP) - STEP_GAP + STAGE_PAD;
  out.push({ key: mapStageKey(roadmap.id, stage.id), kind: "stage", roadmapId: roadmap.id, id: stage.id, x, y: top, w: MAP_STAGE_WIDTH, h, depth });
  let right = x + MAP_STAGE_WIDTH, bottom = top + h, subTop = top;
  stage.nodeIds.forEach((nodeId, index) => {
    const y = top + STAGE_HEAD + index * (MAP_STEP_HEIGHT + STEP_GAP);
    out.push({ key: mapStepKey(roadmap.id, nodeId), kind: "step", roadmapId: roadmap.id, id: nodeId, x: x + STAGE_PAD, y, w: MAP_STEP_WIDTH, h: MAP_STEP_HEIGHT, depth });
    const sub = roadmap.sub(nodeId);
    if (!sub) return;
    const bx = x + MAP_STAGE_WIDTH + SUB_OFFSET, by = Math.max(y - 10, subTop);
    const slot = out.length;
    out.push(null as unknown as MapItem);
    const size = layoutRoadmap(sub, bx + SUB_PAD, by + SUB_HEAD, out, depth + 1, Infinity);
    const box: MapItem = { key: mapSubKey(roadmap.id, nodeId), kind: "sub", roadmapId: sub.id, parentRoadmapId: roadmap.id, id: nodeId,
      x: bx, y: by, w: Math.max(size.w, MAP_STAGE_WIDTH) + SUB_PAD * 2, h: size.h + SUB_HEAD + SUB_PAD, depth: depth + 1 };
    out[slot] = box;
    subTop = by + box.h + SUB_GAP;
    right = Math.max(right, box.x + box.w);
    bottom = Math.max(bottom, box.y + box.h);
  });
  return { w: right - x, h: bottom - top };
}

function layoutRoadmap(roadmap: MapLayoutRoadmap, x0: number, y0: number, out: MapItem[], depth: number, rowMax: number) {
  let x = x0, rowTop = y0, rowBottom = y0, maxRight = x0;
  for (const stage of roadmap.stages) {
    let items: MapItem[] = [];
    let size = placeStage(roadmap, stage, x, rowTop, items, depth);
    // Too wide for this row: start the next row with this stage.
    if (x > x0 && x + size.w > x0 + rowMax) {
      x = x0; rowTop = rowBottom + ROW_GAP; items = [];
      size = placeStage(roadmap, stage, x, rowTop, items, depth);
    }
    out.push(...items);
    rowBottom = Math.max(rowBottom, rowTop + size.h);
    maxRight = Math.max(maxRight, x + size.w);
    x += size.w + STAGE_GAP;
  }
  return { w: maxRight - x0, h: rowBottom - y0 };
}

/**
 * Lay out a roadmap and its open sub-roadmaps. With a `view` size, rows wrap where the whole
 * roadmap fits that view largest (up to full size), preferring rows near `rowWidth`; without
 * one they wrap at `rowWidth`.
 */
export function layoutRoadmapMap(roadmap: MapLayoutRoadmap, rowWidth: number, view?: { width: number; height: number }): { items: MapItem[]; width: number; height: number } {
  const run = (rowMax: number) => {
    const items: MapItem[] = [];
    const size = layoutRoadmap(roadmap, 0, 0, items, 0, Math.max(MAP_STAGE_WIDTH, rowMax));
    return { items, width: size.w, height: size.h, rowMax };
  };
  if (!view || roadmap.stages.length < 2) return run(rowWidth);
  // Each place a row could end: after the first stage, the first two, and so on.
  const widths = roadmap.stages.map((stage) => placeStage(roadmap, stage, 0, 0, [], 0).w);
  const candidates = new Set<number>();
  let sum = -STAGE_GAP;
  for (const width of widths) { sum += width + STAGE_GAP; candidates.add(Math.max(sum, ...widths)); }
  const scale = (layout: ReturnType<typeof run>) => Math.min(1, view.width / Math.max(1, layout.width), view.height / Math.max(1, layout.height));
  let best: ReturnType<typeof run> | null = null, bestScale = -1;
  for (const rowMax of candidates) {
    const layout = run(rowMax), k = scale(layout);
    if (k > bestScale + 1e-3 || (Math.abs(k - bestScale) <= 1e-3 && best && Math.abs(rowMax - rowWidth) < Math.abs(best.rowMax - rowWidth))) { best = layout; bestScale = k; }
  }
  return best!;
}

type Box = { x: number; y: number; w: number; h: number };
/**
 * A prerequisite line from the step needed first (`from`) to the step that needs it (`to`).
 * Steps stacked next to each other in a stage get a short straight line; steps further
 * apart in one stage curve around its left side; anything else curves across.
 */
export function mapEdgePath(from: Box, to: Box, sameStage: boolean, adjacent: boolean): string {
  if (sameStage) {
    const down = to.y > from.y;
    if (adjacent) {
      const x1 = from.x + from.w / 2, x2 = to.x + to.w / 2;
      return down ? `M${x1},${from.y + from.h}L${x2},${to.y}` : `M${x1},${from.y}L${x2},${to.y + to.h}`;
    }
    const y1 = from.y + from.h / 2, y2 = to.y + to.h / 2, bend = Math.min(28, 10 + Math.abs(y2 - y1) / 8);
    return `M${from.x},${y1}C${from.x - bend},${y1} ${to.x - bend},${y2} ${to.x},${y2}`;
  }
  // The next row down: leave from the bottom, arrive at the top.
  if (to.y > from.y + from.h + 20 && to.x < from.x + from.w) {
    const x1 = from.x + from.w / 2, y1 = from.y + from.h, x2 = to.x + to.w / 2, y2 = to.y, dy = Math.max(40, (y2 - y1) / 2);
    return `M${x1},${y1}C${x1},${y1 + dy} ${x2},${y2 - dy} ${x2},${y2}`;
  }
  let sx = from.x + from.w, ex = to.x;
  const sy = from.y + from.h / 2, ey = to.y + to.h / 2;
  if (ex < sx) {
    sx = from.x; ex = to.x + to.w;
    const dx = Math.max(40, (sx - ex) / 2);
    return `M${sx},${sy}C${sx - dx},${sy} ${ex + dx},${ey} ${ex},${ey}`;
  }
  const dx = Math.max(30, (ex - sx) / 2);
  return `M${sx},${sy}C${sx + dx},${sy} ${ex - dx},${ey} ${ex},${ey}`;
}

/** The dashed line from a step to its open sub-roadmap. */
export function mapSubPath(step: Box, sub: Box): string {
  const sx = step.x + step.w, sy = step.y + step.h / 2, ex = sub.x, ey = sub.y + SUB_HEAD / 2;
  const dx = Math.max(20, (ex - sx) / 2);
  return `M${sx},${sy}C${sx + dx},${sy} ${ex - dx},${ey} ${ex},${ey}`;
}

/** Stable tint per stage, like the topic boxes on the Map. */
export function mapStageHue(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index++) hash = (hash * 31 + id.charCodeAt(index)) | 0;
  return Math.abs(hash) % 360;
}
