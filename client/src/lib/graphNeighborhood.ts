/** Reach documents through inbound or outbound connections without changing their order. */
export function getGraphNeighborhoodIds(
  nodeIds: readonly string[],
  connections: readonly { sourceId: string; targetId: string }[],
  focusId: string,
  depth = 1,
): Set<string> {
  const neighbors = new Map(nodeIds.map((id) => [id, new Set<string>()]));
  if (!neighbors.has(focusId)) return new Set();
  const limit = Math.min(Math.max(0, neighbors.size - 1), Number.isFinite(depth) ? Math.max(0, Math.floor(depth)) : 1);
  for (const { sourceId, targetId } of connections) {
    if (sourceId === targetId || !neighbors.has(sourceId) || !neighbors.has(targetId)) continue;
    neighbors.get(sourceId)!.add(targetId);
    neighbors.get(targetId)!.add(sourceId);
  }
  const reached = new Set([focusId]);
  let frontier = [focusId];
  for (let hop = 0; hop < limit && frontier.length; hop++) {
    const next: string[] = [];
    for (const id of frontier) for (const neighbor of neighbors.get(id)!) {
      if (reached.has(neighbor)) continue;
      reached.add(neighbor); next.push(neighbor);
    }
    frontier = next;
  }
  return new Set(nodeIds.filter((id) => reached.has(id)));
}
