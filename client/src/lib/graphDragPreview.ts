import {
  buildConversationGraphNodeSpatialIndex,
  type ConversationGraphNodePlacement,
  type ConversationGraphNodeSpatialIndex,
} from "./conversationGraph";
import {
  GRAPH_REFLOW_GAP_X,
  GRAPH_REFLOW_GAP_Y,
  resolveGraphSelectionReflow,
} from "./graphAutoLayout";
import type { GraphNodeMove } from "./graphInteractions";

export const GRAPH_PREVIEW_LIMITS = {
  candidateNodes: 96,
  indexEntries: 512,
  indexCells: 128,
  iterations: 8,
  pairChecks: 20_000,
} as const;

export function buildGraphDragPreviewIndex(nodes: ConversationGraphNodePlacement[]) {
  return {
    spatialIndex: buildConversationGraphNodeSpatialIndex(nodes),
    placementsById: new Map(nodes.map((node) => [node.conversationId, node])),
    orderById: new Map(nodes.map((node, index) => [node.conversationId, index])),
  };
}

export function resolveGraphDragPreview(args: {
  move: GraphNodeMove;
  placementsById: ReadonlyMap<string, ConversationGraphNodePlacement>;
  orderById: ReadonlyMap<string, number>;
  spatialIndex: ConversationGraphNodeSpatialIndex;
}) {
  const { move, placementsById, spatialIndex } = args;
  const selected = new Set(move.conversationIds);
  const candidates = new Map<string, ConversationGraphNodePlacement>();
  const anchors: ConversationGraphNodePlacement[] = [];
  const visitedCells = new Set<string>();
  const visitedNodes = new Set<string>();
  const work = {
    candidateNodes: 0,
    indexEntries: 0,
    indexCells: 0,
    iterations: 0,
    pairChecks: 0,
  };

  // Every selected node is included, even when the neighborhood budget is
  // exhausted. A large selection must always retain its exact shape.
  for (const id of selected) {
    const placement = placementsById.get(id);
    if (placement) anchors.push(placement);
  }

  search: for (const anchor of anchors) {
    const left = anchor.x + move.deltaX - GRAPH_REFLOW_GAP_X - 256;
    const top = anchor.y + move.deltaY - GRAPH_REFLOW_GAP_Y - 192;
    const right = left + anchor.width + 2 * (GRAPH_REFLOW_GAP_X + 256);
    const bottom = top + anchor.height + 2 * (GRAPH_REFLOW_GAP_Y + 192);
    const firstColumn = Math.floor(left / spatialIndex.cellSize);
    const lastColumn = Math.floor(right / spatialIndex.cellSize);
    const firstRow = Math.floor(top / spatialIndex.cellSize);
    const lastRow = Math.floor(bottom / spatialIndex.cellSize);
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      for (let row = firstRow; row <= lastRow; row += 1) {
        const key = `${column}:${row}`;
        if (visitedCells.has(key)) continue;
        if (work.indexCells >= GRAPH_PREVIEW_LIMITS.indexCells) break search;
        visitedCells.add(key);
        work.indexCells += 1;
        for (const placement of spatialIndex.cells.get(key) ?? []) {
          if (work.indexEntries >= GRAPH_PREVIEW_LIMITS.indexEntries) break search;
          work.indexEntries += 1;
          if (visitedNodes.has(placement.conversationId)) continue;
          visitedNodes.add(placement.conversationId);
          if (selected.has(placement.conversationId)) continue;
          // Keep the whole occupied cell as a small halo for neighbors that
          // yield during the preview; release settles the complete scene.
          candidates.set(placement.conversationId, placement);
          if (candidates.size >= GRAPH_PREVIEW_LIMITS.candidateNodes) break search;
        }
      }
    }
  }

  work.candidateNodes = candidates.size;
  // Keep the complete solver's tie-breaking order so equal-center neighbors
  // yield in the same direction during preview and on release.
  const localPlacements = [...anchors, ...candidates.values()].sort(
    (left, right) => args.orderById.get(left.conversationId)! - args.orderById.get(right.conversationId)!,
  );
  const placements = resolveGraphSelectionReflow({
    conversationIds: selected,
    deltaX: move.deltaX,
    deltaY: move.deltaY,
    placements: localPlacements,
    maxIterations: GRAPH_PREVIEW_LIMITS.iterations,
    maxPairChecks: GRAPH_PREVIEW_LIMITS.pairChecks,
    work,
  });
  return {
    placements: new Map(placements.map((placement) => [placement.conversationId, placement])),
    work,
  };
}
