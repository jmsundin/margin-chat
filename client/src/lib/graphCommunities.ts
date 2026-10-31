import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import pagerank from "graphology-metrics/centrality/pagerank";

/**
 * Community detection and ranking over the vault's link graph (graphology).
 * Both are deterministic for the same input: nodes go in sorted and the
 * random walk takes a seeded generator, so the map keeps its regions between
 * visits.
 */

export type WeightedPair = { a: string; b: string; weight: number };

/** A small seeded generator (mulberry32), so community detection repeats itself. */
function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function buildGraph(ids: Iterable<string>, pairs: Iterable<WeightedPair>) {
  const graph = new Graph({ type: "undirected", multi: false, allowSelfLoops: false });
  for (const id of [...ids].sort()) graph.addNode(id);
  for (const { a, b, weight } of pairs) {
    if (a === b || !graph.hasNode(a) || !graph.hasNode(b) || !(weight > 0)) continue;
    if (graph.hasEdge(a, b)) graph.updateEdgeAttribute(a, b, "weight", (current: number) => current + weight);
    else graph.addEdge(a, b, { weight });
  }
  return graph;
}

/**
 * Louvain communities over a weighted graph, largest first and each sorted by
 * id. `resolution` below 1 makes broader communities, above 1 finer ones.
 * Nodes with no edges come back as communities of one.
 */
export function findCommunities(ids: Iterable<string>, pairs: Iterable<WeightedPair>, options: { resolution?: number; seed?: number } = {}): string[][] {
  const graph = buildGraph(ids, pairs);
  if (!graph.order) return [];
  const members = new Map<number, string[]>();
  if (graph.size) {
    const assignment = louvain(graph, { getEdgeWeight: "weight", resolution: options.resolution ?? 1, rng: seededRandom(options.seed ?? 7) });
    for (const [id, community] of Object.entries(assignment)) (members.get(community) ?? members.set(community, []).get(community)!).push(id);
  } else graph.nodes().forEach((id, index) => { members.set(index, [id]); });
  return [...members.values()].map((list) => list.sort())
    .sort((x, y) => y.length - x.length || (x[0] < y[0] ? -1 : 1));
}

/**
 * PageRank over links: how much of the graph leads to each document. A hub
 * that many documents point at ranks above one with the same number of links
 * to documents nobody else links.
 */
export function rankByLinks(ids: Iterable<string>, pairs: Iterable<WeightedPair>): Map<string, number> {
  const graph = buildGraph(ids, pairs);
  if (!graph.order) return new Map();
  if (!graph.size) return new Map(graph.nodes().map((id) => [id, 1 / graph.order]));
  return new Map(Object.entries(pagerank(graph, { getEdgeWeight: "weight" })));
}
