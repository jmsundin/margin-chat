import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import forceAtlas2 from "graphology-layout-forceatlas2";

/**
 * The landscape: every document placed on one plane so documents close in
 * meaning sit close together, computed on the server from the 12 nearest
 * neighbours each document keeps (topicRepository.mjs). The Map draws it as
 * points far out and as cards up close.
 *
 * A layout starts from the previous one and is turned back onto it, so a
 * document stays where the reader last saw it unless its neighbours moved.
 */

/** Median distance from a document to its nearest neighbour, in map pixels. */
export const LANDSCAPE_SPACING = 240;
/** Above this many documents a layout no longer fits one request; new documents are still placed beside their neighbours. */
export const LANDSCAPE_MAX_LAYOUT_DOCUMENTS = 60_000;
/** Regions smaller than this are not named. */
const MIN_REGION_SIZE = 3;
/** Recompute when this share of documents has no place yet. */
const STALE_SHARE = 0.1;
/** Never lay out the same vault twice within this long. */
export const LANDSCAPE_MIN_INTERVAL_MS = 10 * 60 * 1000;

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** A small number from an id, so the same document always gets the same nudge. */
function idHash(id) {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) hash = Math.imul(hash ^ id.charCodeAt(index), 16777619);
  return hash >>> 0;
}

/** Similarity-weighted mean of the placed neighbours, nudged so two documents never share a point. */
export function placeBesideNeighbours(id, neighbours, positions) {
  let x = 0, y = 0, total = 0;
  const regions = new Map();
  for (const near of neighbours ?? []) {
    const at = positions.get(near.id);
    if (!at) continue;
    const weight = Math.max(0.01, near.similarity);
    x += at.x * weight; y += at.y * weight; total += weight;
    if (at.region >= 0) regions.set(at.region, (regions.get(at.region) ?? 0) + weight);
  }
  if (!total) return null;
  const hash = idHash(id), angle = (hash % 3600) / 3600 * Math.PI * 2, radius = LANDSCAPE_SPACING * (0.3 + (hash >>> 12) % 100 / 200);
  const region = [...regions].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? -1;
  return { x: x / total + Math.cos(angle) * radius, y: y / total + Math.sin(angle) * radius, region };
}

function medianNearestDistance(graph) {
  const distances = [];
  graph.forEachNode((id, at) => {
    let nearest = Infinity;
    graph.forEachNeighbor(id, (_other, to) => { nearest = Math.min(nearest, Math.hypot(at.x - to.x, at.y - to.y)); });
    if (Number.isFinite(nearest) && nearest > 0) distances.push(nearest);
  });
  distances.sort((a, b) => a - b);
  return distances.length ? distances[Math.floor(distances.length / 2)] : 0;
}

/** Rotation and shift (no scaling) that best lays `points` over `targets` (orthogonal Procrustes in 2D). */
export function alignTo(points, targets) {
  const n = points.length;
  if (n < 3) return (p) => p;
  let px = 0, py = 0, tx = 0, ty = 0;
  for (let index = 0; index < n; index += 1) { px += points[index].x; py += points[index].y; tx += targets[index].x; ty += targets[index].y; }
  px /= n; py /= n; tx /= n; ty /= n;
  let a = 0, b = 0;
  for (let index = 0; index < n; index += 1) {
    const x = points[index].x - px, y = points[index].y - py, u = targets[index].x - tx, v = targets[index].y - ty;
    a += x * u + y * v; b += x * v - y * u;
  }
  const angle = Math.atan2(b, a), cos = Math.cos(angle), sin = Math.sin(angle);
  return (p) => ({ x: (p.x - px) * cos - (p.y - py) * sin + tx, y: (p.x - px) * sin + (p.y - py) * cos + ty });
}

/**
 * Lays out documents from their neighbour lists. `previous` holds the last
 * positions; documents in it start there, new ones beside their neighbours.
 * Returns positions in map pixels and a region per document (-1 for none),
 * regions numbered largest first.
 */
export function layoutLandscape({ neighbours, previous = new Map(), seed = 7, iterations }) {
  const graph = new Graph({ type: "undirected", allowSelfLoops: false });
  const ids = [...neighbours.keys()].sort();
  for (const id of ids) graph.addNode(id);
  for (const id of ids) for (const near of neighbours.get(id)) {
    if (near.id === id || !graph.hasNode(near.id)) continue;
    // Pairs only a little alike pull only a little.
    const weight = Math.max(0.01, near.similarity - 0.15);
    if (graph.hasEdge(id, near.id)) graph.updateEdgeAttribute(id, near.id, "weight", (value) => Math.max(value, weight));
    else graph.addEdge(id, near.id, { weight });
  }
  if (!graph.order) return { positions: new Map(), regions: 0 };

  const random = seededRandom(seed);
  const spread = LANDSCAPE_SPACING * Math.sqrt(graph.order);
  const start = new Map();
  for (const id of ids) if (previous.has(id)) start.set(id, previous.get(id));
  for (const id of ids) {
    if (start.has(id)) continue;
    start.set(id, placeBesideNeighbours(id, neighbours.get(id), start)
      ?? { x: (random() - 0.5) * spread, y: (random() - 0.5) * spread });
  }
  graph.forEachNode((id) => { const at = start.get(id); graph.mergeNodeAttributes(id, { x: at.x, y: at.y }); });

  const warm = previous.size > graph.order / 2;
  const steps = iterations ?? (warm ? 40 : graph.order > 20_000 ? 60 : 100);
  if (graph.size) forceAtlas2.assign(graph, { iterations: steps, getEdgeWeight: "weight",
    settings: { ...forceAtlas2.inferSettings(graph), barnesHutOptimize: graph.order > 1000, linLogMode: true, adjustSizes: false } });

  // Fixed spacing: the nearest neighbour sits about one card away whatever the vault's size.
  const median = medianNearestDistance(graph);
  const factor = median > 0 ? LANDSCAPE_SPACING / median : 1;
  let placed = new Map();
  graph.forEachNode((id, at) => { placed.set(id, { x: at.x * factor, y: at.y * factor }); });
  const shared = ids.filter((id) => previous.has(id));
  const turn = alignTo(shared.map((id) => placed.get(id)), shared.map((id) => previous.get(id)));
  placed = new Map([...placed].map(([id, at]) => [id, turn(at)]));

  const regionOf = new Map();
  let regions = 0;
  if (graph.size) {
    const assignment = louvain(graph, { getEdgeWeight: "weight", rng: seededRandom(seed) });
    const members = new Map();
    for (const [id, community] of Object.entries(assignment)) (members.get(community) ?? members.set(community, []).get(community)).push(id);
    const ordered = [...members.values()].filter((list) => list.length >= MIN_REGION_SIZE)
      .map((list) => list.sort()).sort((a, b) => b.length - a.length || (a[0] < b[0] ? -1 : 1));
    ordered.forEach((list, index) => { for (const id of list) regionOf.set(id, index); });
    regions = ordered.length;
  }
  const positions = new Map(ids.map((id) => {
    const at = placed.get(id);
    return [id, { x: Math.round(at.x), y: Math.round(at.y), region: regionOf.get(id) ?? -1 }];
  }));
  return { positions, regions };
}

export function createLandscapeService({ database, now = () => Date.now() }) {
  async function neighbourLists(userId) {
    const { neighbours } = await database.readTopicNeighbours({ userId, since: null });
    return new Map(neighbours.map((entry) => [entry.id, entry.neighbours]));
  }

  /**
   * The stored landscape, with documents added since it was computed placed
   * beside their neighbours. `stale` asks the client to request a fresh layout.
   */
  async function read({ userId }) {
    if (!database?.readLandscape || !database.readTopicNeighbours) return { positions: [], regions: 0, computedAt: null, stale: false, unplaced: 0 };
    const [stored, lists] = await Promise.all([database.readLandscape({ userId }), neighbourLists(userId)]);
    const positions = new Map(stored.positions.filter((entry) => lists.has(entry.id)).map((entry) => [entry.id, entry]));
    const removed = stored.positions.length - positions.size;
    let unplaced = 0;
    for (const [id, near] of lists) {
      if (positions.has(id)) continue;
      const at = placeBesideNeighbours(id, near, positions);
      if (at) positions.set(id, { id, x: Math.round(at.x), y: Math.round(at.y), region: at.region });
      unplaced += 1;
    }
    const tooLarge = lists.size > LANDSCAPE_MAX_LAYOUT_DOCUMENTS;
    const recent = stored.computedAt && now() - Date.parse(stored.computedAt) < LANDSCAPE_MIN_INTERVAL_MS;
    // Many documents added or removed since the layout: their neighbours deserve to move too.
    const stale = !tooLarge && !recent && lists.size > 0 && (!stored.computedAt || unplaced + removed > lists.size * STALE_SHARE);
    return { positions: [...positions.values()].map(({ id, x, y, region }) => ({ id, x, y, region })),
      regions: stored.regions, computedAt: stored.computedAt, stale, unplaced, tooLarge };
  }

  /** Lays the vault out again from its neighbours, starting from the stored landscape. */
  async function relayout({ userId }) {
    if (!database?.writeLandscape) return read({ userId });
    const [stored, lists] = await Promise.all([database.readLandscape({ userId }), neighbourLists(userId)]);
    if (lists.size > LANDSCAPE_MAX_LAYOUT_DOCUMENTS) return read({ userId });
    if (stored.computedAt && now() - Date.parse(stored.computedAt) < LANDSCAPE_MIN_INTERVAL_MS) return read({ userId });
    const previous = new Map(stored.positions.map((entry) => [entry.id, entry]));
    const { positions, regions } = layoutLandscape({ neighbours: lists, previous });
    await database.writeLandscape({ userId, regions, positions: [...positions].map(([id, at]) => ({ id, ...at })) });
    return read({ userId });
  }

  return { read, relayout };
}
