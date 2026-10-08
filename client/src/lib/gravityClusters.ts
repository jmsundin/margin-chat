import type { ConversationGraphNodePlacement } from "./conversationGraph";
import { getDocumentNodeFootprint } from "./documentMapLayout";
import type { GraphViewport } from "./graphInteractions";
import { fitNetworkMapViewport } from "./networkMapLayout";

const CARD = getDocumentNodeFootprint(1);
// Members of one cluster sit a card gap apart; clusters keep a much wider gap so
// a hub's exclusive neighbors read as one island, not part of the next one.
const CELL_WIDTH = CARD.width + 28;
const CELL_HEIGHT = CARD.height + 28;
const CLUSTER_GAP = 260;
const HUB_MIN_DEGREE = 3;
const HUB_MIN_FOLLOWERS = 2;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export const UNLINKED_CLUSTER_ID = "cluster:__unlinked__";

type Connection = { sourceId: string; targetId: string };
type Point = { x: number; y: number };

export interface GravityCluster {
  id: string;
  /** The most connected document, or null for the bucket of unlinked documents. */
  hubId: string | null;
  /** Hub first, then members by distance from the hub and their own connections. */
  memberIds: string[];
  /** Fingerprint of the membership; a label only needs regenerating when it changes. */
  fingerprint: string;
  center: Point;
  radius: number;
}

export interface GravityClusterLayout {
  nodes: ConversationGraphNodePlacement[];
  viewport: GraphViewport;
  clusters: GravityCluster[];
  clusterByDocumentId: Map<string, string>;
}

function hash(value: string) {
  let result = 2166136261;
  for (let index = 0; index < value.length; index++) result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  result = Math.imul(result ^ (result >>> 16), 0x85ebca6b);
  result = Math.imul(result ^ (result >>> 13), 0xc2b2ae35);
  result ^= result >>> 16;
  return result >>> 0;
}

export function clusterFingerprint(memberIds: string[]) {
  const sorted = [...memberIds].sort();
  return `${sorted.length}:${hash(sorted.join("\n")).toString(36)}:${hash(sorted.join("\t") + "~").toString(36)}`;
}

/**
 * Groups documents by gravity: every document climbs toward its most connected
 * neighbor until it reaches a hub, a document that is a local maximum of
 * connections or that holds at least two followers of its own. A hub's
 * exclusive neighbors therefore share its cluster, while two well-connected
 * hubs linked to each other keep separate clusters. Runs in O(documents + links).
 */
export function findGravityClusters(ids: string[], connections: Connection[]) {
  const known = new Set(ids);
  const neighbors = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]));
  for (const { sourceId, targetId } of connections) {
    if (sourceId === targetId || !known.has(sourceId) || !known.has(targetId)) continue;
    neighbors.get(sourceId)!.add(targetId);
    neighbors.get(targetId)!.add(sourceId);
  }
  const degree = (id: string) => neighbors.get(id)!.size;
  const outranks = (a: string, b: string) => degree(a) > degree(b) || (degree(a) === degree(b) && a < b);
  const parent = new Map<string, string>();
  const followers = new Map<string, number>();
  for (const id of ids) {
    let best: string | null = null;
    for (const neighbor of neighbors.get(id)!) if (outranks(neighbor, id) && (!best || outranks(neighbor, best))) best = neighbor;
    if (best) { parent.set(id, best); followers.set(best, (followers.get(best) ?? 0) + 1); }
  }
  const isHub = (id: string) => degree(id) > 0 && (!parent.has(id)
    || (degree(id) >= HUB_MIN_DEGREE && (followers.get(id) ?? 0) >= HUB_MIN_FOLLOWERS));
  const hubOf = new Map<string, string>();
  const climb = (id: string) => {
    const path: string[] = [];
    let current = id;
    while (!hubOf.has(current) && !isHub(current)) { path.push(current); current = parent.get(current)!; }
    const hub = hubOf.get(current) ?? current;
    hubOf.set(current, hub);
    for (const step of path) hubOf.set(step, hub);
    return hub;
  };
  const members = new Map<string, string[]>();
  const unlinked: string[] = [];
  for (const id of ids) {
    if (!degree(id)) { unlinked.push(id); continue; }
    const hub = climb(id);
    const list = members.get(hub);
    if (list) list.push(id); else members.set(hub, [id]);
  }
  const clusters = [...members].map(([hubId, memberIds]) => ({ hubId: hubId as string | null, memberIds: orderMembers(hubId, memberIds, neighbors) }));
  if (unlinked.length) clusters.push({ hubId: null, memberIds: unlinked.sort() });
  clusters.sort((a, b) => (a.hubId === null ? 1 : 0) - (b.hubId === null ? 1 : 0) || b.memberIds.length - a.memberIds.length
    || (a.hubId! < b.hubId! ? -1 : 1));
  return { clusters, neighbors };
}

/** Breadth-first from the hub inside the cluster, so direct neighbors sit closest. */
function orderMembers(hubId: string, memberIds: string[], neighbors: Map<string, Set<string>>) {
  const inside = new Set(memberIds);
  const depth = new Map([[hubId, 0]]);
  const queue = [hubId];
  for (let index = 0; index < queue.length; index++) {
    for (const next of neighbors.get(queue[index])!) {
      if (!inside.has(next) || depth.has(next)) continue;
      depth.set(next, depth.get(queue[index])! + 1);
      queue.push(next);
    }
  }
  const rank = (id: string) => depth.get(id) ?? Number.MAX_SAFE_INTEGER;
  return [...memberIds].sort((a, b) => a === hubId ? -1 : b === hubId ? 1
    : rank(a) - rank(b) || neighbors.get(b)!.size - neighbors.get(a)!.size || (a < b ? -1 : 1));
}

/** Grid cells nearest the center first, so a cluster forms a compact round island. */
function clusterCells(count: number) {
  const radius = Math.ceil(Math.sqrt(count)) + 1;
  const rows = Math.ceil(radius * CELL_WIDTH / CELL_HEIGHT);
  const cells: Array<Point & { distance: number; angle: number }> = [];
  for (let column = -radius; column <= radius; column++) for (let row = -rows; row <= rows; row++) {
    const x = column * CELL_WIDTH, y = row * CELL_HEIGHT;
    cells.push({ x, y, distance: Math.hypot(x, y), angle: Math.atan2(y, x) });
  }
  cells.sort((a, b) => a.distance - b.distance || a.angle - b.angle);
  return cells.slice(0, count);
}

/**
 * Lays each cluster out as an island around its hub, then settles the islands
 * so linked clusters drift together and none overlap. Deterministic for the
 * same documents and links; viewport changes never move it.
 */
export function layoutGravityClusters(
  nodes: ConversationGraphNodePlacement[],
  canvas: { width: number; height: number },
  connections: Connection[],
): GravityClusterLayout {
  const ids = nodes.map((node) => node.conversationId);
  const { clusters: groups } = findGravityClusters(ids, connections);
  const offsets = new Map<string, Point>();
  const clusterByDocumentId = new Map<string, string>();
  const islands = groups.map((group) => {
    const id = group.hubId === null ? UNLINKED_CLUSTER_ID : `cluster:${group.hubId}`;
    const cells = clusterCells(group.memberIds.length);
    let radius = 0;
    group.memberIds.forEach((memberId, index) => {
      offsets.set(memberId, cells[index]);
      clusterByDocumentId.set(memberId, id);
      radius = Math.max(radius, cells[index].distance);
    });
    return { ...group, id, fingerprint: clusterFingerprint(group.memberIds), radius: radius + Math.hypot(CARD.width, CARD.height) / 2 };
  });
  const centers = settleIslands(islands, connections, clusterByDocumentId);
  const placed = nodes.map((node) => {
    const center = centers.get(clusterByDocumentId.get(node.conversationId)!)!;
    const offset = offsets.get(node.conversationId)!;
    return { ...node, x: center.x + offset.x - CARD.width / 2, y: center.y + offset.y - CARD.height / 2, width: CARD.width, height: CARD.height };
  });
  return {
    nodes: placed,
    viewport: fitNetworkMapViewport(placed, canvas),
    clusters: islands.map((island) => ({ id: island.id, hubId: island.hubId, memberIds: island.memberIds,
      fingerprint: island.fingerprint, center: centers.get(island.id)!, radius: island.radius })),
    clusterByDocumentId,
  };
}

function settleIslands(islands: Array<{ id: string; radius: number }>, connections: Connection[], clusterOf: Map<string, string>) {
  const count = islands.length;
  const index = new Map(islands.map((island, position) => [island.id, position]));
  const x = new Float64Array(count), y = new Float64Array(count);
  const radius = Float64Array.from(islands, (island) => island.radius);
  // Largest islands start in the middle; the rest spiral outward by area.
  let area = 0;
  for (let position = 0; position < count; position++) {
    const distance = position === 0 ? 0 : Math.sqrt(area) * 1.15 + radius[position];
    const angle = position * GOLDEN_ANGLE;
    x[position] = Math.cos(angle) * distance; y[position] = Math.sin(angle) * distance;
    area += (radius[position] * 2 + CLUSTER_GAP) ** 2;
  }
  const weights = new Map<string, number>();
  for (const { sourceId, targetId } of connections) {
    const a = index.get(clusterOf.get(sourceId) ?? ""), b = index.get(clusterOf.get(targetId) ?? "");
    if (a === undefined || b === undefined || a === b) continue;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    weights.set(key, (weights.get(key) ?? 0) + 1);
  }
  const links = [...weights].map(([key, weight]) => {
    const [a, b] = key.split(":").map(Number);
    return { a, b, strength: Math.log2(1 + weight) };
  });
  const rounds = count > 2000 ? 24 : count > 300 ? 60 : 120;
  for (let round = 0; round < rounds; round++) {
    const cooling = 1 - round / rounds;
    for (const { a, b, strength } of links) {
      const vx = x[b] - x[a], vy = y[b] - y[a];
      const distance = Math.max(1, Math.hypot(vx, vy));
      const rest = radius[a] + radius[b] + CLUSTER_GAP;
      if (distance <= rest) continue;
      const pull = (distance - rest) / distance * 0.05 * strength * cooling;
      const shareA = radius[b] / (radius[a] + radius[b]), shareB = 1 - shareA;
      x[a] += vx * pull * shareA; y[a] += vy * pull * shareA;
      x[b] -= vx * pull * shareB; y[b] -= vy * pull * shareB;
    }
    for (let position = 0; position < count; position++) {
      x[position] -= x[position] * 0.01 * cooling; y[position] -= y[position] * 0.01 * cooling;
    }
    separate(x, y, radius);
  }
  for (let round = 0; round < 40; round++) if (!separate(x, y, radius)) break;
  return new Map(islands.map((island, position) => [island.id, { x: x[position], y: y[position] }]));
}

/** Sweep-and-prune circle separation; returns whether anything moved. */
function separate(x: Float64Array, y: Float64Array, radius: Float64Array) {
  const order = Array.from(x, (_, position) => position).sort((a, b) => (x[a] - radius[a]) - (x[b] - radius[b]) || a - b);
  let moved = false;
  for (let i = 0; i < order.length; i++) {
    const a = order[i];
    for (let j = i + 1; j < order.length; j++) {
      const b = order[j];
      if (x[b] - radius[b] > x[a] + radius[a] + CLUSTER_GAP) break;
      let vx = x[b] - x[a], vy = y[b] - y[a];
      const minimum = radius[a] + radius[b] + CLUSTER_GAP;
      const distanceSquared = vx * vx + vy * vy;
      if (distanceSquared >= minimum * minimum) continue;
      let distance = Math.sqrt(distanceSquared);
      if (distance < 1e-6) { const angle = (a * 7 + b * 13) % 360 * Math.PI / 180; vx = Math.cos(angle); vy = Math.sin(angle); distance = 1; }
      const push = (minimum - distance) / distance;
      const shareA = radius[b] / (radius[a] + radius[b]), shareB = 1 - shareA;
      x[a] -= vx * push * shareA; y[a] -= vy * push * shareA;
      x[b] += vx * push * shareB; y[b] += vy * push * shareB;
      moved = true;
    }
  }
  return moved;
}

/** Fits a camera to one cluster's island. */
export function fitGravityCluster(cluster: GravityCluster, canvas: { width: number; height: number }, maxScale = 0.9): GraphViewport {
  const width = Math.max(1, canvas.width), height = Math.max(1, canvas.height);
  // Leaves room above the island for its heading.
  const heading = 64;
  const scale = Math.min(maxScale, width / (cluster.radius * 2 + 48), (height - heading - 48) / (cluster.radius * 2 + 48));
  return { scale, x: width / 2 - cluster.center.x * scale, y: heading + (height - heading) / 2 - cluster.center.y * scale };
}
