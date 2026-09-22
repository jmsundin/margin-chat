import { PUBLIC_FOCUSED_HEIGHT, PUBLIC_FOCUSED_WIDTH, publicGraphPlacements, visiblePublicGraph, type PublicGraphState, type PublicGraphViewOptions } from "./publicGraphScene";
import type { MapConnections, MapTerritory } from "./graphPresentation";

/** Selection enlarges a card around its existing center without moving its neighbors. */
export function publicMapNodePlacements(graph: PublicGraphState, options: PublicGraphViewOptions = {}) {
  return publicGraphPlacements(graph, null, options).map((node) => node.conversationId === options.selectedId ? {
    ...node,
    x: node.x + (node.width - PUBLIC_FOCUSED_WIDTH) / 2,
    y: node.y + (node.height - PUBLIC_FOCUSED_HEIGHT) / 2,
    width: PUBLIC_FOCUSED_WIDTH,
    height: PUBLIC_FOCUSED_HEIGHT,
  } : node);
}

/** Neighborhoods record exploration paths, not inferred topic categories. */
export function publicMapNeighborhoods(graph: PublicGraphState, options: PublicGraphViewOptions = {}) {
  const visible = visiblePublicGraph(graph, options);
  const placements = new Map(publicMapNodePlacements(graph, options).map((node) => [node.conversationId, node]));
  const neighbors = new Map<string, string[]>();
  for (const relation of visible.relations) {
    const children = neighbors.get(relation.sourceId) ?? [];
    children.push(relation.targetId);
    neighbors.set(relation.sourceId, children);
  }
  const assigned = new Set<string>();
  const territories: MapTerritory[] = [];
  const anchors = options.selectedId && !graph.roots.includes(options.selectedId)
    ? [...graph.roots, options.selectedId] : graph.roots;
  for (const rootId of anchors) {
    const queue = [rootId];
    const seen = new Set<string>();
    const nodes = [];
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index];
      if (seen.has(id)) continue;
      seen.add(id);
      const node = placements.get(id);
      if (node && !assigned.has(id)) { nodes.push(node); assigned.add(id); }
      queue.push(...(neighbors.get(id) ?? []).filter((child) => !graph.roots.includes(child)));
    }
    if (!nodes.length) continue;
    territories.push({ id: rootId, label: graph.topics[rootId].label, color: "var(--sage, var(--accent))", nodes,
      x: nodes.reduce((sum, node) => sum + node.x + node.width / 2, 0) / nodes.length,
      y: nodes.reduce((sum, node) => sum + node.y + node.height / 2, 0) / nodes.length });
  }
  const connections: MapConnections = Object.fromEntries(visible.topics.map((topic) => [topic.id, {
    parentId: null, linkedConversationIds: visible.relations.filter((relation) => relation.sourceId === topic.id).map((relation) => relation.targetId),
  }]));
  return { territories, connections };
}
