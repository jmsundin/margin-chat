import type { ElkNode } from "elkjs/lib/elk-api";
import type { ConversationGraphNodePlacement } from "./conversationGraph";
import type { Conversation, GraphNodeLayout } from "../types";

export const GRAPH_REFLOW_GAP_X = 42;
export const GRAPH_REFLOW_GAP_Y = 30;

const ELK_PEER_SPACING = 34;
const ELK_LAYER_SPACING = 76;
const ELK_COMPONENT_SPACING = 72;

type PositionedGraphNode = ConversationGraphNodePlacement;

function sortPlacements(
  placements: ConversationGraphNodePlacement[],
  conversations: Record<string, Conversation>,
) {
  return [...placements].sort((left, right) => {
    const leftConversation = conversations[left.conversationId];
    const rightConversation = conversations[right.conversationId];

    return (
      (leftConversation?.createdAt ?? "").localeCompare(
        rightConversation?.createdAt ?? "",
      ) || left.conversationId.localeCompare(right.conversationId)
    );
  });
}

export async function buildElkConversationLayout(args: {
  conversations: Record<string, Conversation>;
  placements: ConversationGraphNodePlacement[];
}): Promise<Record<string, Partial<GraphNodeLayout>>> {
  if (!args.placements.length) {
    return {};
  }

  const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
  const elk = new ELK();
  const graph = buildElkConversationGraph(args);

  const arrangedGraph = await elk.layout(graph);

  try {
    elk.terminateWorker();
  } catch {
    // The bundled browser fallback runs inline and does not expose terminate().
  }

  return mapElkGraphToLayouts(arrangedGraph);
}

export function buildElkConversationGraph(args: {
  conversations: Record<string, Conversation>;
  placements: ConversationGraphNodePlacement[];
}): ElkNode {
  const orderedPlacements = sortPlacements(
    args.placements,
    args.conversations,
  );
  const placementIds = new Set(
    orderedPlacements.map((placement) => placement.conversationId),
  );
  return {
    id: "conversation-workspace",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "SPLINES",
      "elk.padding": "[top=48,left=48,bottom=48,right=48]",
      "elk.spacing.componentComponent": `${ELK_COMPONENT_SPACING}`,
      "elk.spacing.nodeNode": `${ELK_PEER_SPACING}`,
      "elk.layered.spacing.nodeNodeBetweenLayers": `${ELK_LAYER_SPACING}`,
      "elk.layered.spacing.edgeNodeBetweenLayers": "32",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.crossingMinimization.semiInteractive": "true",
      "elk.layered.nodePlacement.favorStraightEdges": "true",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.separateConnectedComponents": "true",
    },
    children: orderedPlacements.map((placement) => ({
      height: placement.height,
      id: placement.conversationId,
      width: placement.width,
      x: placement.x,
      y: placement.y,
    })),
    edges: orderedPlacements.flatMap((placement) => {
      const conversation = args.conversations[placement.conversationId];

      if (!conversation?.parentId || !placementIds.has(conversation.parentId)) {
        return [];
      }

      return [
        {
          id: `edge-${conversation.parentId}-${conversation.id}`,
          sources: [conversation.parentId],
          targets: [conversation.id],
        },
      ];
    }),
  };
}

export function mapElkGraphToLayouts(
  arrangedGraph: ElkNode,
): Record<string, Partial<GraphNodeLayout>> {
  return Object.fromEntries(
    (arrangedGraph.children ?? []).map((node) => [
      node.id,
      {
        positioned: true,
        x: Math.round(node.x ?? 0),
        y: Math.round(node.y ?? 0),
      },
    ]),
  );
}

function getInflatedOverlap(
  left: PositionedGraphNode,
  right: PositionedGraphNode,
  gapX: number,
  gapY: number,
) {
  const overlapX =
    Math.min(
      left.x + left.width + gapX / 2,
      right.x + right.width + gapX / 2,
    ) - Math.max(left.x - gapX / 2, right.x - gapX / 2);
  const overlapY =
    Math.min(
      left.y + left.height + gapY / 2,
      right.y + right.height + gapY / 2,
    ) - Math.max(left.y - gapY / 2, right.y - gapY / 2);

  return { overlapX, overlapY };
}

function getCenter(node: PositionedGraphNode) {
  return {
    x: node.x + node.width / 2,
    y: node.y + node.height / 2,
  };
}

export function hasGraphNodeSpacing(
  left: PositionedGraphNode,
  right: PositionedGraphNode,
  gapX = GRAPH_REFLOW_GAP_X,
  gapY = GRAPH_REFLOW_GAP_Y,
) {
  const { overlapX, overlapY } = getInflatedOverlap(
    left,
    right,
    gapX,
    gapY,
  );

  return overlapX <= 0 || overlapY <= 0;
}

export function resolveGraphNodeReflow(args: {
  anchorConversationId: string;
  gapX?: number;
  gapY?: number;
  placements: ConversationGraphNodePlacement[];
  x: number;
  y: number;
}) {
  const gapX = args.gapX ?? GRAPH_REFLOW_GAP_X;
  const gapY = args.gapY ?? GRAPH_REFLOW_GAP_Y;
  const nodes = args.placements.map((placement) => ({ ...placement }));
  const anchorNode = nodes.find(
    (placement) => placement.conversationId === args.anchorConversationId,
  );

  if (!anchorNode) {
    return nodes;
  }

  anchorNode.x = args.x;
  anchorNode.y = args.y;
  const anchorCenter = getCenter(anchorNode);
  const maximumIterations = Math.min(Math.max(nodes.length * 6, 12), 1200);

  for (let iteration = 0; iteration < maximumIterations; iteration += 1) {
    let movedNode = false;

    for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < nodes.length;
        rightIndex += 1
      ) {
        const left = nodes[leftIndex];
        const right = nodes[rightIndex];
        const { overlapX, overlapY } = getInflatedOverlap(
          left,
          right,
          gapX,
          gapY,
        );

        if (overlapX <= 0 || overlapY <= 0) {
          continue;
        }

        const leftIsAnchor = left.conversationId === args.anchorConversationId;
        const rightIsAnchor = right.conversationId === args.anchorConversationId;
        const leftCenter = getCenter(left);
        const rightCenter = getCenter(right);
        const leftDistance = Math.hypot(
          leftCenter.x - anchorCenter.x,
          leftCenter.y - anchorCenter.y,
        );
        const rightDistance = Math.hypot(
          rightCenter.x - anchorCenter.x,
          rightCenter.y - anchorCenter.y,
        );
        const moveRight = leftIsAnchor
          ? true
          : rightIsAnchor
            ? false
            : rightDistance >= leftDistance;
        const nodeToMove = moveRight ? right : left;
        const stationaryNode = moveRight ? left : right;
        const movingCenter = moveRight ? rightCenter : leftCenter;
        const stationaryCenter = moveRight ? leftCenter : rightCenter;

        if (overlapX < overlapY) {
          const direction =
            movingCenter.x === stationaryCenter.x
              ? moveRight
                ? 1
                : -1
              : Math.sign(movingCenter.x - stationaryCenter.x);
          nodeToMove.x += direction * (overlapX + 0.5);
        } else {
          const direction =
            movingCenter.y === stationaryCenter.y
              ? moveRight
                ? 1
                : -1
              : Math.sign(movingCenter.y - stationaryCenter.y);
          nodeToMove.y += direction * (overlapY + 0.5);
        }

        movedNode = true;
      }
    }

    if (!movedNode) {
      break;
    }
  }

  return nodes;
}

export function resolveGraphSelectionReflow(args: {
  conversationIds: Iterable<string>;
  deltaX: number;
  deltaY: number;
  gapX?: number;
  gapY?: number;
  placements: ConversationGraphNodePlacement[];
}) {
  const selectedConversationIds = new Set(args.conversationIds);

  if (!selectedConversationIds.size) {
    return args.placements.map((placement) => ({ ...placement }));
  }

  const gapX = args.gapX ?? GRAPH_REFLOW_GAP_X;
  const gapY = args.gapY ?? GRAPH_REFLOW_GAP_Y;
  const nodes = args.placements.map((placement) => ({
    ...placement,
    x: selectedConversationIds.has(placement.conversationId)
      ? placement.x + args.deltaX
      : placement.x,
    y: selectedConversationIds.has(placement.conversationId)
      ? placement.y + args.deltaY
      : placement.y,
  }));
  const selectedNodes = nodes.filter((node) =>
    selectedConversationIds.has(node.conversationId),
  );

  if (!selectedNodes.length) {
    return nodes;
  }

  const selectionCenter = selectedNodes.reduce(
    (center, node) => ({
      x: center.x + (node.x + node.width / 2) / selectedNodes.length,
      y: center.y + (node.y + node.height / 2) / selectedNodes.length,
    }),
    { x: 0, y: 0 },
  );
  const maximumIterations = Math.min(Math.max(nodes.length * 6, 12), 1200);

  for (let iteration = 0; iteration < maximumIterations; iteration += 1) {
    let movedNode = false;

    for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < nodes.length;
        rightIndex += 1
      ) {
        const left = nodes[leftIndex];
        const right = nodes[rightIndex];
        const leftIsSelected = selectedConversationIds.has(left.conversationId);
        const rightIsSelected = selectedConversationIds.has(right.conversationId);

        // Preserve the relative positions of nodes being moved together.
        if (leftIsSelected && rightIsSelected) {
          continue;
        }

        const { overlapX, overlapY } = getInflatedOverlap(
          left,
          right,
          gapX,
          gapY,
        );

        if (overlapX <= 0 || overlapY <= 0) {
          continue;
        }

        const leftCenter = getCenter(left);
        const rightCenter = getCenter(right);
        const leftDistance = Math.hypot(
          leftCenter.x - selectionCenter.x,
          leftCenter.y - selectionCenter.y,
        );
        const rightDistance = Math.hypot(
          rightCenter.x - selectionCenter.x,
          rightCenter.y - selectionCenter.y,
        );
        const moveRight = leftIsSelected
          ? true
          : rightIsSelected
            ? false
            : rightDistance >= leftDistance;
        const nodeToMove = moveRight ? right : left;
        const movingCenter = moveRight ? rightCenter : leftCenter;
        const stationaryCenter = moveRight ? leftCenter : rightCenter;

        if (overlapX < overlapY) {
          const direction =
            movingCenter.x === stationaryCenter.x
              ? moveRight
                ? 1
                : -1
              : Math.sign(movingCenter.x - stationaryCenter.x);
          nodeToMove.x += direction * (overlapX + 0.5);
        } else {
          const direction =
            movingCenter.y === stationaryCenter.y
              ? moveRight
                ? 1
                : -1
              : Math.sign(movingCenter.y - stationaryCenter.y);
          nodeToMove.y += direction * (overlapY + 0.5);
        }

        movedNode = true;
      }
    }

    if (!movedNode) {
      break;
    }
  }

  return nodes;
}
