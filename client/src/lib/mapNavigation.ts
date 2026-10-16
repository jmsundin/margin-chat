import type { GraphViewport } from "./graphInteractions";

/** Helpers for finding your way around a large map: camera trail, keyboard travel, signposts, landmarks and bundled lines. */

type Point = { x: number; y: number };
type Size = { width: number; height: number };
type Rect = { x: number; y: number; width: number; height: number };

/**
 * Whether the camera went somewhere new enough to remember for Back: the view's
 * center moved most of a screen, or the zoom changed about threefold.
 */
export function isBigCameraMove(from: GraphViewport, to: GraphViewport, size: Size) {
  if (!size.width || !size.height) return false;
  if (Math.abs(Math.log2(to.scale / from.scale)) >= 1.5) return true;
  const center = (viewport: GraphViewport) => ({ x: (size.width / 2 - viewport.x) / viewport.scale, y: (size.height / 2 - viewport.y) / viewport.scale });
  const a = center(from), b = center(to);
  return Math.hypot(a.x - b.x, a.y - b.y) * Math.min(from.scale, to.scale) > 0.75 * Math.min(size.width, size.height);
}

export type TravelDirection = "left" | "right" | "up" | "down";

/**
 * The candidate an arrow key leads to from `origin`: the nearest one in that
 * direction, where straying sideways counts double, within a 60° cone each way.
 */
export function nextInDirection(origin: Point, candidates: Iterable<{ id: string } & Point>, direction: TravelDirection): string | null {
  const [ax, ay] = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[direction];
  let best: string | null = null, bestScore = Infinity;
  for (const candidate of candidates) {
    const dx = candidate.x - origin.x, dy = candidate.y - origin.y;
    const along = dx * ax + dy * ay, across = Math.abs(dx * ay - dy * ax);
    if (along <= 1 || across > along * Math.sqrt(3)) continue;
    const score = along + 2 * across;
    if (score < bestScore) { bestScore = score; best = candidate.id; }
  }
  return best;
}

/** Reading order (rows, then left to right) for stepping through filter matches. */
export function readingOrder<T extends { id: string } & Point>(items: T[], rowHeight: number) {
  return [...items].sort((a, b) => Math.floor(a.y / rowHeight) - Math.floor(b.y / rowHeight) || a.x - b.x || (a.id < b.id ? -1 : 1));
}

export interface Signpost {
  ids: string[];
  /** Where the signpost sits, in screen pixels, on the edge of the visible map. */
  x: number;
  y: number;
  /** Direction toward its documents, in radians. */
  angle: number;
}

/**
 * Signposts at the edge of the screen for documents outside it. Each points
 * from the screen's center toward its document; ones close together along the
 * edge merge into one, so a crowd off screen reads as "5 more →".
 */
export function edgeSignposts(targets: Array<{ id: string } & Point>, size: Size,
  inset: { top: number; right: number; bottom: number; left: number }, mergeDistance = 64): Signpost[] {
  const box = { left: inset.left, top: inset.top, right: size.width - inset.right, bottom: size.height - inset.bottom };
  if (box.right <= box.left || box.bottom <= box.top) return [];
  const center = { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
  const width = box.right - box.left, height = box.bottom - box.top;
  const placed: Array<{ id: string; x: number; y: number; angle: number; along: number }> = [];
  for (const target of targets) {
    if (target.x >= 0 && target.x <= size.width && target.y >= 0 && target.y <= size.height) continue;
    const dx = target.x - center.x, dy = target.y - center.y;
    if (!dx && !dy) continue;
    // Scale the ray until it meets the inset box.
    const reach = Math.min(dx ? (width / 2) / Math.abs(dx) : Infinity, dy ? (height / 2) / Math.abs(dy) : Infinity);
    const x = center.x + dx * reach, y = center.y + dy * reach;
    // Distance clockwise around the box from its top-left corner, for merging neighbors.
    const along = y <= box.top + 0.5 ? x - box.left
      : x >= box.right - 0.5 ? width + (y - box.top)
      : y >= box.bottom - 0.5 ? width + height + (box.right - x)
      : 2 * width + height + (box.bottom - y);
    placed.push({ id: target.id, x, y, angle: Math.atan2(dy, dx), along });
  }
  placed.sort((a, b) => a.along - b.along);
  const signposts: Array<Signpost & { along: number }> = [];
  for (const item of placed) {
    const last = signposts.at(-1);
    if (last && item.along - last.along < mergeDistance) { last.ids.push(item.id); continue; }
    signposts.push({ ids: [item.id], x: item.x, y: item.y, angle: item.angle, along: item.along });
  }
  // The perimeter wraps: the last group may touch the first.
  const perimeter = 2 * (width + height);
  if (signposts.length > 1 && signposts[0].along + perimeter - signposts.at(-1)!.along < mergeDistance) {
    signposts[0].ids.push(...signposts.pop()!.ids);
  }
  return signposts.map(({ along: _along, ...signpost }) => signpost);
}

export interface Landmark {
  id: string;
  /** Map position the label names. */
  x: number;
  y: number;
  label: string;
  detail?: string;
  /** Higher claims space first. */
  priority: number;
  /** Regions get larger type than single documents. */
  region?: boolean;
}

export interface PlacedLandmark extends Landmark {
  rect: Rect;
}

/**
 * Labels to show over a zoomed-out map, most important first; a label that
 * would overlap one already placed waits until zooming in makes room.
 */
export function placeLandmarks(landmarks: Landmark[], viewport: GraphViewport, size: Size, maximum = 48, avoid: Rect[] = []): PlacedLandmark[] {
  const taken = [...avoid];
  const placed: PlacedLandmark[] = [];
  for (const landmark of [...landmarks].sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : 1))) {
    if (placed.length >= maximum) break;
    const x = viewport.x + landmark.x * viewport.scale, y = viewport.y + landmark.y * viewport.scale;
    const fontSize = landmark.region ? 15 : 12.5;
    const width = Math.min(240, Math.max(landmark.label.length, (landmark.detail?.length ?? 0) * 0.85) * fontSize * 0.62 + 24);
    const height = landmark.detail ? fontSize * 2.6 + 8 : fontSize * 1.4 + 10;
    const rect = { x: x - width / 2, y: y - height / 2, width, height };
    if (rect.x + width < 0 || rect.y + height < 0 || rect.x > size.width || rect.y > size.height) continue;
    if (taken.some((other) => rect.x < other.x + other.width + 6 && other.x < rect.x + width + 6 && rect.y < other.y + other.height + 4 && other.y < rect.y + height + 4)) continue;
    taken.push(rect);
    placed.push({ ...landmark, rect });
  }
  return placed;
}

export interface LinkBundle {
  id: string;
  from: Point;
  to: Point;
  count: number;
  /** The documents at each end, for highlighting or fitting the bundle. */
  ids: string[];
}

/**
 * Sums lines into one strand per pair of regions, drawn between the average
 * positions of each end's documents. Lines inside one region are dropped, and
 * only the `maximum` heaviest strands are kept.
 */
export function bundleLinks(links: Iterable<[string, string]>, regionOf: (id: string) => string | undefined,
  pointOf: (id: string) => Point | undefined, maximum = 240): LinkBundle[] {
  const bundles = new Map<string, { sum: [number, number, number, number]; ends: [Set<string>, Set<string>]; count: number }>();
  for (const [first, second] of links) {
    const firstRegion = regionOf(first), secondRegion = regionOf(second);
    if (firstRegion === undefined || secondRegion === undefined || firstRegion === secondRegion) continue;
    const p = pointOf(first), q = pointOf(second);
    if (!p || !q) continue;
    const forward = firstRegion < secondRegion;
    const key = forward ? `${firstRegion}\n${secondRegion}` : `${secondRegion}\n${firstRegion}`;
    const [a, b] = forward ? [p, q] : [q, p];
    const [aId, bId] = forward ? [first, second] : [second, first];
    let bundle = bundles.get(key);
    if (!bundle) bundles.set(key, bundle = { sum: [0, 0, 0, 0], ends: [new Set(), new Set()], count: 0 });
    if (!bundle.ends[0].has(aId)) { bundle.ends[0].add(aId); bundle.sum[0] += a.x; bundle.sum[1] += a.y; }
    if (!bundle.ends[1].has(bId)) { bundle.ends[1].add(bId); bundle.sum[2] += b.x; bundle.sum[3] += b.y; }
    bundle.count++;
  }
  return [...bundles].sort((x, y) => y[1].count - x[1].count).slice(0, maximum).map(([key, bundle]) => ({
    id: key, count: bundle.count, ids: [...bundle.ends[0], ...bundle.ends[1]],
    from: { x: bundle.sum[0] / bundle.ends[0].size, y: bundle.sum[1] / bundle.ends[0].size },
    to: { x: bundle.sum[2] / bundle.ends[1].size, y: bundle.sum[3] / bundle.ends[1].size },
  }));
}

/** Square regions about `screenSize` pixels across at the current zoom, for bundling lines on maps without clusters. */
export function screenGridRegion(scale: number, screenSize = 280) {
  const size = screenSize / scale;
  return (point: Point) => `${Math.floor(point.x / size)},${Math.floor(point.y / size)}`;
}

/** Camera positions for a smooth flight, zooming geometrically so far jumps don't blur. */
export function interpolateViewport(from: GraphViewport, to: GraphViewport, size: Size, t: number): GraphViewport {
  const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
  const scale = from.scale * (to.scale / from.scale) ** eased;
  const centerOf = (viewport: GraphViewport) => ({ x: (size.width / 2 - viewport.x) / viewport.scale, y: (size.height / 2 - viewport.y) / viewport.scale });
  const a = centerOf(from), b = centerOf(to);
  const center = { x: a.x + (b.x - a.x) * eased, y: a.y + (b.y - a.y) * eased };
  return { scale, x: size.width / 2 - center.x * scale, y: size.height / 2 - center.y * scale };
}
