import type { ConversationGraphNodePlacement } from "./conversationGraph";
import { clusterFingerprint } from "./gravityClusters";

/** Card size on the landscape; the server spaces nearest neighbours about this far apart. */
const CARD = { width: 180, height: 96 };
const ROW_GAP = 40;

export interface LandscapeRegion {
  id: string;
  /** Index from the server, largest region first. */
  index: number;
  /** The member nearest the region's middle first, then the rest by distance from it. */
  memberIds: string[];
  hubId: string;
  fingerprint: string;
  center: { x: number; y: number };
  /** Distance from the middle within which most members sit. */
  radius: number;
}

export interface LandscapeScene {
  nodes: ConversationGraphNodePlacement[];
  regions: LandscapeRegion[];
  regionOf: Map<string, number>;
  /** Documents with no place yet (no embedding), in a row under the landscape. */
  unplacedIds: string[];
}

/**
 * Cards at the server's positions, centred on each point, plus a row below for
 * documents the server has not placed. Regions get a middle, a radius and a
 * representative member for their label.
 */
export function buildLandscapeScene(ids: string[], positions: ReadonlyArray<{ id: string; x: number; y: number; region: number }>,
  { unplacedRow = true }: { unplacedRow?: boolean } = {}): LandscapeScene {
  const shown = new Set(ids);
  const at = new Map(positions.filter((entry) => shown.has(entry.id)).map((entry) => [entry.id, entry]));
  const nodes: ConversationGraphNodePlacement[] = [];
  const regionOf = new Map<string, number>();
  const groups = new Map<number, string[]>();
  let minX = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const id of ids) {
    const point = at.get(id);
    if (!point) continue;
    nodes.push({ conversationId: id, depth: 0, x: point.x - CARD.width / 2, y: point.y - CARD.height / 2, ...CARD });
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
    if (point.region >= 0) {
      regionOf.set(id, point.region);
      (groups.get(point.region) ?? groups.set(point.region, []).get(point.region)!).push(id);
    }
  }
  const unplacedIds = unplacedRow ? ids.filter((id) => !at.has(id)) : [];
  if (unplacedIds.length) {
    const left = Number.isFinite(minX) ? minX : 0, top = Number.isFinite(maxY) ? maxY + CARD.height * 3 : 0;
    const columns = Math.max(4, Math.floor((Number.isFinite(maxX) ? maxX - left : 0) / (CARD.width + ROW_GAP)) + 1);
    unplacedIds.forEach((id, index) => nodes.push({ conversationId: id, depth: 0, ...CARD,
      x: left + (index % columns) * (CARD.width + ROW_GAP), y: top + Math.floor(index / columns) * (CARD.height + ROW_GAP) }));
  }
  const regions = [...groups].sort((a, b) => a[0] - b[0]).map(([index, members]) => {
    let x = 0, y = 0;
    for (const id of members) { const point = at.get(id)!; x += point.x; y += point.y; }
    const center = { x: x / members.length, y: y / members.length };
    const byDistance = members.map((id) => { const point = at.get(id)!; return { id, distance: Math.hypot(point.x - center.x, point.y - center.y) }; })
      .sort((a, b) => a.distance - b.distance || (a.id < b.id ? -1 : 1));
    const radius = byDistance[Math.min(byDistance.length - 1, Math.floor(byDistance.length * 0.8))].distance + CARD.width / 2;
    const memberIds = byDistance.map((item) => item.id);
    return { id: `landscape-region-${index}`, index, memberIds, hubId: memberIds[0], fingerprint: clusterFingerprint(memberIds), center, radius };
  });
  return { nodes, regions, regionOf, unplacedIds };
}

/** A hue per region, spread by the golden angle so neighbouring numbers differ. */
export function landscapeRegionHue(index: number) {
  return index < 0 ? null : Math.round((index * 137.508 + 150) % 360);
}

/** Region names of a PubMed field, each at the middle of its papers. */
export function libraryFieldLabels(map: { field: { regions: Array<{ index: number; label: string | null }> }; works: Array<{ x: number; y: number; region: number }> }) {
  const byRegion = new Map<number, Array<{ x: number; y: number }>>();
  for (const work of map.works) if (work.region >= 0) (byRegion.get(work.region) ?? byRegion.set(work.region, []).get(work.region)!).push(work);
  return map.field.regions.flatMap((region) => {
    const points = byRegion.get(region.index);
    if (!region.label || !points?.length) return [];
    const x = points.reduce((sum, point) => sum + point.x, 0) / points.length, y = points.reduce((sum, point) => sum + point.y, 0) / points.length;
    const distances = points.map((point) => Math.hypot(point.x - x, point.y - y)).sort((a, b) => a - b);
    return [{ id: `library-region-${region.index}`, label: region.label, x, y, radius: distances[Math.floor((distances.length - 1) * 0.8)] + CARD.width / 2, count: points.length }];
  });
}
