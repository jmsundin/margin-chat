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
  /** Set on date runs of unlinked documents. */
  period?: { start: number; end: number };
}

export interface GravityClusterLayout {
  nodes: ConversationGraphNodePlacement[];
  viewport: GraphViewport;
  clusters: GravityCluster[];
  clusterByDocumentId: Map<string, string>;
  /** Groups of clusters, smallest first; empty for maps with few clusters. */
  levels: GravityClusterLevel[];
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

const cellCache = new Map<number, ReturnType<typeof computeClusterCells>>();

/** Grid cells nearest the center first, so a cluster forms a compact round island. */
function clusterCells(count: number) {
  let cells = cellCache.get(count);
  if (!cells) {
    if (cellCache.size > 512) cellCache.clear();
    cells = computeClusterCells(count);
    cellCache.set(count, cells);
  }
  return cells;
}

function computeClusterCells(count: number) {
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

type WeightedLink = { a: string; b: string; weight: number };

/** Sums document links into links between the groups that hold them. */
function groupLinks(connections: Connection[], groupOf: (documentId: string) => string | undefined): WeightedLink[] {
  const weights = new Map<string, number>();
  for (const { sourceId, targetId } of connections) {
    const a = groupOf(sourceId), b = groupOf(targetId);
    if (a === undefined || b === undefined || a === b) continue;
    const key = a < b ? `${a}\n${b}` : `${b}\n${a}`;
    weights.set(key, (weights.get(key) ?? 0) + 1);
  }
  return [...weights].map(([key, weight]) => {
    const [a, b] = key.split("\n");
    return { a, b, weight };
  });
}

const MONTH_FORMAT = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

function formatMonth(time: number) {
  return MONTH_FORMAT.format(time);
}

/** "Mar 2024" or "Mar 2024 – Jun 2024", for groups made by date rather than by links. */
export function formatClusterPeriod(period: { start: number; end: number }) {
  const start = formatMonth(period.start), end = formatMonth(period.end);
  return start === end ? start : `${start} – ${end}`;
}

/** Splits items into date-ordered runs of about `size`, so unlinked material is grouped by when it was made. */
function splitByTime<T extends { time?: number; id: string }>(items: T[], size: number) {
  const ordered = [...items].sort((a, b) => (a.time ?? 0) - (b.time ?? 0) || (a.id < b.id ? -1 : 1));
  const count = Math.max(1, Math.round(ordered.length / size));
  return Array.from({ length: count }, (_, index) => ordered.slice(Math.floor(index * ordered.length / count), Math.floor((index + 1) * ordered.length / count)));
}

function median(values: number[]) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** A group of clusters, or of groups; level 1 groups clusters, level 2 groups level 1, and so on. */
export interface GravityClusterGroup extends GravityCluster {
  level: number;
  childIds: string[];
  /** Groups of unlinked material are made by date; their span names them. */
  period?: { start: number; end: number };
}

export interface GravityClusterLevel {
  level: number;
  groups: GravityClusterGroup[];
  /** Link counts between this level's groups, for drawing bundled links. */
  links: WeightedLink[];
}

/** Unlinked documents are split into date runs of about this many once they outgrow one island. */
const UNLINKED_RUN_SIZE = 48;
/** Above this many clusters, clusters are grouped into regions, and regions into larger regions. */
export const CLUSTER_GROUPING_THRESHOLD = 36;
const TOP_LEVEL_TARGET = 12;
const MAX_GROUP_LEVELS = 4;

/**
 * Lays each cluster out as an island around its hub, then settles the islands
 * so linked clusters drift together and none overlap. Deterministic for the
 * same documents and links; viewport changes never move it.
 *
 * Large maps are grouped further: clusters into regions by the links between
 * them, regions into larger regions, until about a dozen remain. Each group is
 * settled inside its parent, so a group's members always sit together.
 */
export function layoutGravityClusters(
  nodes: ConversationGraphNodePlacement[],
  canvas: { width: number; height: number },
  connections: Connection[],
  options: { createdAt?: (id: string) => number | undefined } = {},
): GravityClusterLayout {
  const ids = nodes.map((node) => node.conversationId);
  const { clusters: found } = findGravityClusters(ids, connections);
  const groups: Array<{ hubId: string | null; memberIds: string[]; id: string; period?: { start: number; end: number } }> = [];
  for (const group of found) {
    if (group.hubId !== null) { groups.push({ ...group, id: `cluster:${group.hubId}` }); continue; }
    const times = options.createdAt;
    if (!times || group.memberIds.length <= UNLINKED_RUN_SIZE * 1.5) { groups.push({ ...group, id: UNLINKED_CLUSTER_ID }); continue; }
    for (const run of splitByTime(group.memberIds.map((id) => ({ id, time: times(id) })), UNLINKED_RUN_SIZE)) {
      const runTimes = run.map((item) => item.time ?? 0);
      groups.push({ hubId: null, memberIds: run.map((item) => item.id), id: `${UNLINKED_CLUSTER_ID}:${run[0].id}`,
        period: { start: Math.min(...runTimes), end: Math.max(...runTimes) } });
    }
  }
  const offsets = new Map<string, Point>();
  const clusterByDocumentId = new Map<string, string>();
  const islands = groups.map((group) => {
    const cells = clusterCells(group.memberIds.length);
    let radius = 0;
    group.memberIds.forEach((memberId, index) => {
      offsets.set(memberId, cells[index]);
      clusterByDocumentId.set(memberId, group.id);
      radius = Math.max(radius, cells[index].distance);
    });
    return { ...group, fingerprint: clusterFingerprint(group.memberIds), radius: radius + Math.hypot(CARD.width, CARD.height) / 2 };
  });
  const islandLinks = groupLinks(connections, (id) => clusterByDocumentId.get(id));
  const centers = new Map<string, Point>();
  const levels: GravityClusterLevel[] = [];
  if (islands.length <= CLUSTER_GROUPING_THRESHOLD) {
    for (const [id, center] of settleIslands(islands, islandLinks, CLUSTER_GAP)) centers.set(id, center);
  } else {
    layoutGroupedIslands(islands, islandLinks, connections, clusterByDocumentId, options.createdAt, centers, levels);
  }
  const placed = nodes.map((node) => {
    const center = centers.get(clusterByDocumentId.get(node.conversationId)!)!;
    const offset = offsets.get(node.conversationId)!;
    return { ...node, x: center.x + offset.x - CARD.width / 2, y: center.y + offset.y - CARD.height / 2, width: CARD.width, height: CARD.height };
  });
  return {
    nodes: placed,
    viewport: fitNetworkMapViewport(placed, canvas),
    clusters: islands.map((island) => ({ id: island.id, hubId: island.hubId, memberIds: island.memberIds,
      fingerprint: island.fingerprint, center: centers.get(island.id)!, radius: island.radius,
      ...(island.period ? { period: island.period } : {}) })),
    clusterByDocumentId,
    levels,
  };
}

type Item = { id: string; radius: number; memberIds: string[]; hubId: string | null; time?: number; period?: { start: number; end: number } };

/**
 * Builds the group levels bottom-up, then places them top-down: each group's
 * children are settled around its center, so positions nest.
 */
function layoutGroupedIslands(islands: Item[], islandLinks: WeightedLink[], connections: Connection[],
  clusterOf: Map<string, string>, createdAt: ((id: string) => number | undefined) | undefined,
  centers: Map<string, Point>, levels: GravityClusterLevel[]) {
  const timeOf = (memberIds: string[]) => createdAt ? median(memberIds.flatMap((id) => createdAt(id) ?? [])) : undefined;
  let items: Item[] = islands.map((island) => ({ ...island, time: island.period ? island.period.start : timeOf(island.memberIds) }));
  let links = islandLinks;
  let gap = CLUSTER_GAP;
  // Children's centers relative to their group's center, filled as each level is built.
  const relative = new Map<string, Point>();
  // The current level's item holding each document.
  const itemOfDocument = new Map(clusterOf);
  const parentOf = new Map<string, string>();
  for (let level = 1; level <= MAX_GROUP_LEVELS && items.length > TOP_LEVEL_TARGET; level++) {
    const byId = new Map(items.map((item) => [item.id, item]));
    const { clusters } = findGravityClusters(items.map((item) => item.id), links.map(({ a, b }) => ({ sourceId: a, targetId: b })));
    const made: Array<{ childIds: string[]; hubChild: string | null; period?: { start: number; end: number } }> = [];
    for (const cluster of clusters) {
      if (cluster.hubId !== null) { made.push({ childIds: cluster.memberIds, hubChild: cluster.hubId }); continue; }
      // Items with no links to other items are grouped by date instead.
      const size = Math.max(4, Math.ceil(Math.sqrt(items.length)));
      for (const run of splitByTime(cluster.memberIds.map((id) => byId.get(id)!), size)) {
        const times = run.flatMap((item) => item.time === undefined ? [] : [item.period?.start ?? item.time, item.period?.end ?? item.time]);
        made.push({ childIds: run.map((item) => item.id), hubChild: null, period: times.length ? { start: Math.min(...times), end: Math.max(...times) } : undefined });
      }
    }
    if (made.length >= items.length * 0.9) break;
    const madeOf = new Map(made.flatMap((group, position) => group.childIds.map((id) => [id, position] as const)));
    const innerLinks = made.map(() => [] as WeightedLink[]);
    for (const link of links) if (madeOf.get(link.a) === madeOf.get(link.b)) innerLinks[madeOf.get(link.a)!].push(link);
    gap *= 1.6;
    const groups: GravityClusterGroup[] = [];
    const nextItems: Item[] = [];
    for (const [position, group] of made.entries()) {
      const children = group.childIds.map((id) => byId.get(id)!).sort((a, b) => b.memberIds.length - a.memberIds.length || (a.id < b.id ? -1 : 1));
      const largestLinked = children.find((child) => child.hubId !== null);
      const hubId = group.hubChild ? byId.get(group.hubChild)!.hubId : largestLinked?.hubId ?? null;
      const id = `group${level}:${group.hubChild ?? children[0].id}`;
      const local = settleIslands(children, innerLinks[position], gap / 1.6);
      let radius = 0;
      for (const child of children) {
        const center = local.get(child.id)!;
        relative.set(child.id, center);
        parentOf.set(child.id, id);
        radius = Math.max(radius, Math.hypot(center.x, center.y) + child.radius);
      }
      // Hubs of the biggest children lead, so labeling prompts see them first.
      const hubs = children.flatMap((child) => child.hubId ? [child.hubId] : []);
      const hubSet = new Set(hubs);
      const memberIds = [...hubs, ...children.flatMap((child) => child.memberIds.filter((memberId) => !hubSet.has(memberId)))];
      const period = group.period;
      groups.push({ id, level, hubId, childIds: children.map((child) => child.id), memberIds, fingerprint: clusterFingerprint(memberIds),
        center: { x: 0, y: 0 }, radius: radius + gap / 4, ...(period ? { period } : {}) });
      nextItems.push({ id, radius: radius + gap / 4, memberIds, hubId, time: period?.start ?? timeOf(hubs.length ? hubs : memberIds.slice(0, 50)), period });
    }
    for (const [documentId, itemId] of itemOfDocument) itemOfDocument.set(documentId, parentOf.get(itemId)!);
    links = groupLinks(connections, (documentId) => itemOfDocument.get(documentId));
    levels.push({ level, groups, links });
    items = nextItems;
  }
  // Top level: settle the remaining items, then resolve absolute centers downward.
  const top = settleIslands(items, links, gap * 1.6);
  const absolute = (id: string): Point => {
    const known = centers.get(id);
    if (known) return known;
    const parent = parentOf.get(id);
    const offset = parent ? relative.get(id)! : top.get(id)!;
    const base = parent ? absolute(parent) : { x: 0, y: 0 };
    const point = { x: base.x + offset.x, y: base.y + offset.y };
    centers.set(id, point);
    return point;
  };
  for (const level of levels) for (const group of level.groups) group.center = absolute(group.id);
  for (const island of islands) absolute(island.id);
}

function settleIslands(islands: Array<{ id: string; radius: number }>, links: WeightedLink[], gap: number) {
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
    area += (radius[position] * 2 + gap) ** 2;
  }
  const springs = links.flatMap(({ a, b, weight }) => {
    const first = index.get(a), second = index.get(b);
    return first === undefined || second === undefined ? [] : [{ a: first, b: second, strength: Math.log2(1 + weight) }];
  });
  const rounds = count > 2000 ? 24 : count > 300 ? 60 : 120;
  for (let round = 0; round < rounds; round++) {
    const cooling = 1 - round / rounds;
    for (const { a, b, strength } of springs) {
      const vx = x[b] - x[a], vy = y[b] - y[a];
      const distance = Math.max(1, Math.hypot(vx, vy));
      const rest = radius[a] + radius[b] + gap;
      if (distance <= rest) continue;
      const pull = (distance - rest) / distance * 0.05 * strength * cooling;
      const shareA = radius[b] / (radius[a] + radius[b]), shareB = 1 - shareA;
      x[a] += vx * pull * shareA; y[a] += vy * pull * shareA;
      x[b] -= vx * pull * shareB; y[b] -= vy * pull * shareB;
    }
    for (let position = 0; position < count; position++) {
      x[position] -= x[position] * 0.01 * cooling; y[position] -= y[position] * 0.01 * cooling;
    }
    separate(x, y, radius, gap);
  }
  for (let round = 0; round < 40; round++) if (!separate(x, y, radius, gap)) break;
  return new Map(islands.map((island, position) => [island.id, { x: x[position], y: y[position] }]));
}

/** Sweep-and-prune circle separation; returns whether anything moved. */
function separate(x: Float64Array, y: Float64Array, radius: Float64Array, gap: number) {
  const order = Array.from(x, (_, position) => position).sort((a, b) => (x[a] - radius[a]) - (x[b] - radius[b]) || a - b);
  let moved = false;
  for (let i = 0; i < order.length; i++) {
    const a = order[i];
    for (let j = i + 1; j < order.length; j++) {
      const b = order[j];
      if (x[b] - radius[b] > x[a] + radius[a] + gap) break;
      let vx = x[b] - x[a], vy = y[b] - y[a];
      const minimum = radius[a] + radius[b] + gap;
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
