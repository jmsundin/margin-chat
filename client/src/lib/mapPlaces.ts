import { CLUSTER_CARD, clusterCells, type GravityCluster, type GravityClusterGroup, type GravityClusterLayout } from "./gravityClusters";
import { fitNetworkMapViewport } from "./networkMapLayout";

/**
 * Where the Clusters view put things last time, so the map keeps its places as
 * the vault grows: clusters stay where they were, members keep their spots in
 * them, and only new documents and new clusters find new ones.
 */
export interface MapPlaces {
  islands: Array<{ id: string; x: number; y: number; members?: string[] }>;
}

/** Member order is remembered for up to this many documents; past it, only where each cluster sits. */
const MAX_REMEMBERED_MEMBERS = 20_000;
/** When fewer documents than this share land in a remembered cluster, the map is laid out afresh. */
const MIN_KEPT_SHARE = 0.3;
const GAP = 120;

type Connection = { sourceId: string; targetId: string };
type Point = { x: number; y: number };

export function readMapPlaces(value: unknown): MapPlaces | null {
  const islands = (value as MapPlaces | null)?.islands;
  if (!Array.isArray(islands)) return null;
  return { islands: islands.filter((island) => island && typeof island.id === "string" && Number.isFinite(island.x) && Number.isFinite(island.y)
    && (island.members === undefined || (Array.isArray(island.members) && island.members.every((id) => typeof id === "string")))) };
}

export function rememberMapPlaces(layout: GravityClusterLayout): MapPlaces {
  let budget = MAX_REMEMBERED_MEMBERS;
  return { islands: layout.clusters.map((cluster) => {
    const keep = cluster.memberIds.length <= budget;
    if (keep) budget -= cluster.memberIds.length;
    return { id: cluster.id, x: Math.round(cluster.center.x), y: Math.round(cluster.center.y), ...(keep ? { members: cluster.memberIds } : {}) };
  }) };
}

function islandRadius(count: number) {
  return clusterCells(count).at(-1)!.distance + Math.hypot(CLUSTER_CARD.width, CLUSTER_CARD.height) / 2;
}

/**
 * Moves a fresh Clusters layout back onto remembered places. Each new cluster
 * is matched to the remembered one holding most of its documents; matched
 * clusters return to their old spot with their members in their old order,
 * new ones settle beside the clusters they link to, and overlaps are pushed
 * apart with remembered clusters barely moving.
 */
export function stabilizeClusterLayout(layout: GravityClusterLayout, places: MapPlaces | null, connections: Connection[],
  canvas: { width: number; height: number }): GravityClusterLayout {
  if (!places?.islands.length || !layout.clusters.length) return layout;
  const oldIndexOf = new Map<string, number>();
  places.islands.forEach((island, index) => { for (const id of island.members ?? []) oldIndexOf.set(id, index); });
  const oldById = new Map(places.islands.map((island, index) => [island.id, index]));

  // Match greedily by shared documents; a cluster keeping its id counts as a match too.
  const pairs: Array<{ cluster: number; island: number; shared: number }> = [];
  layout.clusters.forEach((cluster, clusterIndex) => {
    const votes = new Map<number, number>();
    for (const id of cluster.memberIds) {
      const index = oldIndexOf.get(id);
      if (index !== undefined) votes.set(index, (votes.get(index) ?? 0) + 1);
    }
    const sameId = oldById.get(cluster.id);
    if (sameId !== undefined && !places.islands[sameId].members) votes.set(sameId, Math.max(votes.get(sameId) ?? 0, cluster.memberIds.length));
    for (const [island, shared] of votes) if (shared >= Math.max(1, cluster.memberIds.length / 3)) pairs.push({ cluster: clusterIndex, island, shared });
  });
  pairs.sort((a, b) => b.shared - a.shared || a.cluster - b.cluster);
  const matchOf = new Map<number, number>(), usedIslands = new Set<number>();
  let kept = 0;
  for (const pair of pairs) {
    if (matchOf.has(pair.cluster) || usedIslands.has(pair.island)) continue;
    matchOf.set(pair.cluster, pair.island);
    usedIslands.add(pair.island);
    kept += layout.clusters[pair.cluster].memberIds.length;
  }
  const total = layout.clusters.reduce((sum, cluster) => sum + cluster.memberIds.length, 0);
  if (kept < total * MIN_KEPT_SHARE) return layout;

  // Member order: remembered members keep their order (the hub stays in the middle), newcomers follow.
  const clusters = layout.clusters.map((cluster, index): GravityCluster => {
    const island = matchOf.has(index) ? places.islands[matchOf.get(index)!] : null;
    let memberIds = cluster.memberIds;
    if (island?.members) {
      const present = new Set(cluster.memberIds);
      const remembered = island.members.filter((id) => present.has(id));
      const known = new Set(remembered);
      memberIds = [...remembered, ...cluster.memberIds.filter((id) => !known.has(id))];
      if (cluster.hubId && memberIds[0] !== cluster.hubId) {
        const hubAt = memberIds.indexOf(cluster.hubId);
        memberIds = [...memberIds];
        [memberIds[0], memberIds[hubAt]] = [memberIds[hubAt], memberIds[0]];
      }
    }
    return { ...cluster, memberIds, radius: islandRadius(memberIds.length), center: island ? { x: island.x, y: island.y } : cluster.center };
  });

  // New clusters start beside the remembered clusters they link to, or outside everything.
  const clusterIndexOf = new Map<string, number>();
  clusters.forEach((cluster, index) => { for (const id of cluster.memberIds) clusterIndexOf.set(id, index); });
  const linked = new Map<number, Map<number, number>>();
  for (const { sourceId, targetId } of connections) {
    const a = clusterIndexOf.get(sourceId), b = clusterIndexOf.get(targetId);
    if (a === undefined || b === undefined || a === b) continue;
    for (const [from, to] of [[a, b], [b, a]]) {
      if (matchOf.has(from) || !matchOf.has(to)) continue;
      const counts = linked.get(from) ?? new Map<number, number>();
      counts.set(to, (counts.get(to) ?? 0) + 1);
      linked.set(from, counts);
    }
  }
  let bounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  clusters.forEach((cluster, index) => {
    if (!matchOf.has(index)) return;
    bounds = { left: Math.min(bounds.left, cluster.center.x - cluster.radius), top: Math.min(bounds.top, cluster.center.y - cluster.radius),
      right: Math.max(bounds.right, cluster.center.x + cluster.radius), bottom: Math.max(bounds.bottom, cluster.center.y + cluster.radius) };
  });
  const middle = { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 };
  const reach = Math.hypot(bounds.right - bounds.left, bounds.bottom - bounds.top) / 2;
  let newcomer = 0;
  const centers: Point[] = clusters.map((cluster, index) => {
    if (matchOf.has(index)) return { ...cluster.center };
    const neighbors = linked.get(index);
    if (neighbors?.size) {
      let x = 0, y = 0, weight = 0;
      for (const [other, count] of neighbors) { x += clusters[other].center.x * count; y += clusters[other].center.y * count; weight += count; }
      // A nudge off the exact centroid keeps two newcomers from starting on one spot.
      const angle = index * 2.399963;
      return { x: x / weight + Math.cos(angle) * cluster.radius, y: y / weight + Math.sin(angle) * cluster.radius };
    }
    const angle = newcomer++ * 2.399963;
    return { x: middle.x + Math.cos(angle) * (reach + cluster.radius + GAP), y: middle.y + Math.sin(angle) * (reach + cluster.radius + GAP) };
  });
  separateWeighted(centers, clusters.map((cluster) => cluster.radius), clusters.map((_, index) => matchOf.has(index) ? 12 : 1));

  const placedClusters = clusters.map((cluster, index) => ({ ...cluster, center: centers[index] }));
  const offsetOf = new Map<string, Point>(), centerOf = new Map<string, Point>();
  for (const cluster of placedClusters) {
    const cells = clusterCells(cluster.memberIds.length);
    cluster.memberIds.forEach((id, index) => { offsetOf.set(id, cells[index]); centerOf.set(id, cluster.center); });
  }
  const nodes = layout.nodes.map((node) => {
    const center = centerOf.get(node.conversationId), offset = offsetOf.get(node.conversationId);
    return center && offset ? { ...node, x: center.x + offset.x - CLUSTER_CARD.width / 2, y: center.y + offset.y - CLUSTER_CARD.height / 2 } : node;
  });

  // Groups of clusters wrap their members again.
  const circles = new Map<string, GravityCluster | GravityClusterGroup>(placedClusters.map((cluster) => [cluster.id, cluster]));
  const levels = layout.levels.map((level) => ({ ...level, groups: level.groups.map((group) => {
    const children = group.childIds.flatMap((id) => circles.get(id) ?? []);
    let x = 0, y = 0, weight = 0;
    for (const child of children) { const area = child.radius ** 2; x += child.center.x * area; y += child.center.y * area; weight += area; }
    const center = weight ? { x: x / weight, y: y / weight } : group.center;
    const radius = children.reduce((maximum, child) => Math.max(maximum, Math.hypot(child.center.x - center.x, child.center.y - center.y) + child.radius), 0) + GAP / 2;
    const placed = { ...group, center, radius };
    circles.set(group.id, placed);
    return placed;
  }) }));
  return { ...layout, nodes, clusters: placedClusters, levels, viewport: fitNetworkMapViewport(nodes, canvas) };
}

/** Pushes overlapping circles apart; heavier ones give way less. */
function separateWeighted(centers: Point[], radii: number[], mass: number[]) {
  const order = centers.map((_, index) => index);
  for (let round = 0; round < 80; round++) {
    order.sort((a, b) => (centers[a].x - radii[a]) - (centers[b].x - radii[b]) || a - b);
    let moved = false;
    for (let i = 0; i < order.length; i++) {
      const a = order[i];
      for (let j = i + 1; j < order.length; j++) {
        const b = order[j];
        if (centers[b].x - radii[b] > centers[a].x + radii[a] + GAP) break;
        let vx = centers[b].x - centers[a].x, vy = centers[b].y - centers[a].y;
        const minimum = radii[a] + radii[b] + GAP;
        const distanceSquared = vx * vx + vy * vy;
        if (distanceSquared >= minimum * minimum) continue;
        let distance = Math.sqrt(distanceSquared);
        if (distance < 1e-6) { const angle = (a * 7 + b * 13) % 360 * Math.PI / 180; vx = Math.cos(angle); vy = Math.sin(angle); distance = 1; }
        const push = (minimum - distance) / distance;
        const shareA = mass[b] / (mass[a] + mass[b]), shareB = 1 - shareA;
        centers[a].x -= vx * push * shareA; centers[a].y -= vy * push * shareA;
        centers[b].x += vx * push * shareB; centers[b].y += vy * push * shareB;
        moved = true;
      }
    }
    if (!moved) return;
  }
}
