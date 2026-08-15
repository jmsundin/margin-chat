import type {
  Conversation,
  ConversationGroup,
  GraphNodeLayout,
} from "../types";
import {
  getConversationPath,
  getConversationRootId,
  getRootConversations,
} from "./tree";

export type ConversationGraphMode = "focus" | "overview";
export type ConversationGraphDetail = "compact" | "preview" | "reader";
export type ConversationGraphSemanticLevel =
  | "territory"
  | "compact"
  | "summary"
  | "detail";

export interface ConversationGraphNodePlacement {
  conversationId: string;
  depth: number;
  height: number;
  width: number;
  x: number;
  y: number;
}

export interface ConversationGraphEdgePlacement {
  childConversationId: string;
  endX: number;
  endY: number;
  isSelectedPath: boolean;
  parentConversationId: string;
  startX: number;
  startY: number;
}

export interface ConversationGraphGroupPlacement {
  conversationIds: string[];
  groupId: string;
  height: number;
  width: number;
  x: number;
  y: number;
}

export interface ConversationGraphScene {
  edges: ConversationGraphEdgePlacement[];
  groups: ConversationGraphGroupPlacement[];
  height: number;
  nodes: ConversationGraphNodePlacement[];
  width: number;
}

export interface ConversationGraphBounds {
  bottom: number;
  left: number;
  right: number;
  top: number;
}

export interface ConversationGraphNodeSpatialIndex {
  cellSize: number;
  cells: Map<string, ConversationGraphNodePlacement[]>;
}

const FOCUS_COMPACT_HEIGHT = 88;
const FOCUS_COMPACT_WIDTH = 210;
const OVERVIEW_NODE_HEIGHT = 96;
const OVERVIEW_NODE_WIDTH = 200;
const PREVIEW_NODE_BASE_HEIGHT = 168;
const PREVIEW_NODE_WIDTH = 330;
const READER_NODE_BASE_HEIGHT = 430;
const READER_NODE_WIDTH = 430;
const GRAPH_SPATIAL_INDEX_CELL_SIZE = 640;
const GRAPH_VIEWPORT_FALLBACK_HEIGHT = 720;
const GRAPH_VIEWPORT_FALLBACK_WIDTH = 1280;

const SEMANTIC_NODE_DIMENSIONS: Record<
  ConversationGraphSemanticLevel,
  { height: number; width: number }
> = {
  compact: { height: 96, width: 200 },
  detail: { height: 160, width: 286 },
  summary: { height: 124, width: 244 },
  territory: { height: 84, width: 220 },
};

function sortConversationIds(
  conversations: Record<string, Conversation>,
  conversationIds: string[],
) {
  return [...conversationIds]
    .filter((conversationId) => Boolean(conversations[conversationId]))
    .sort((leftId, rightId) =>
      conversations[leftId].createdAt.localeCompare(
        conversations[rightId].createdAt,
      ),
    );
}

function getConversationGraphThreadEntries(
  conversations: Record<string, Conversation>,
  conversationId: string,
) {
  const rootConversationId = getConversationRootId(conversations, conversationId);

  if (!rootConversationId) {
    return [];
  }

  const orderedEntries: Array<{ conversationId: string; depth: number }> = [];
  const visited = new Set<string>();
  const queue = [{ conversationId: rootConversationId, depth: 0 }];

  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const entry = queue[queueIndex];

    if (
      visited.has(entry.conversationId) ||
      !conversations[entry.conversationId]
    ) {
      continue;
    }

    visited.add(entry.conversationId);
    orderedEntries.push(entry);
    for (const childConversationId of sortConversationIds(
      conversations,
      conversations[entry.conversationId].childIds,
    )) {
      queue.push({
        conversationId: childConversationId,
        depth: entry.depth + 1,
      });
    }
  }

  return orderedEntries;
}

export function getConversationGraphThreadIds(
  conversations: Record<string, Conversation>,
  conversationId: string,
) {
  return getConversationGraphThreadEntries(conversations, conversationId).map(
    (entry) => entry.conversationId,
  );
}

export function getFocusedConversationGraphIds(
  conversations: Record<string, Conversation>,
  selectedConversationId: string,
) {
  const selectedPath = getConversationPath(conversations, selectedConversationId);
  const focusedIds = new Set<string>();

  for (const conversation of selectedPath) {
    focusedIds.add(conversation.id);

    for (const childConversationId of conversation.childIds) {
      if (conversations[childConversationId]) {
        focusedIds.add(childConversationId);
      }
    }
  }

  return focusedIds;
}

function getNodeDimensions(args: {
  conversation: Conversation;
  detailLevel: ConversationGraphDetail;
  isSelected: boolean;
  mode: ConversationGraphMode;
  semanticLevel: ConversationGraphSemanticLevel;
}) {
  if (args.isSelected && args.detailLevel === "reader") {
    return {
      height: READER_NODE_BASE_HEIGHT,
      width: READER_NODE_WIDTH,
    };
  }

  if (args.isSelected && args.detailLevel === "preview") {
    return {
      height: PREVIEW_NODE_BASE_HEIGHT,
      width: PREVIEW_NODE_WIDTH,
    };
  }

  if (args.mode === "overview") {
    return SEMANTIC_NODE_DIMENSIONS[args.semanticLevel] ?? {
      height: OVERVIEW_NODE_HEIGHT,
      width: OVERVIEW_NODE_WIDTH,
    };
  }

  return {
    height: FOCUS_COMPACT_HEIGHT,
    width: FOCUS_COMPACT_WIDTH,
  };
}

function getSpatialCellKey(column: number, row: number) {
  return `${column}:${row}`;
}

export function getConversationGraphViewportBounds(args: {
  overscan?: number;
  viewport: { scale: number; x: number; y: number };
  viewportSize: { height: number; width: number };
}): ConversationGraphBounds {
  const viewportHeight =
    args.viewportSize.height || GRAPH_VIEWPORT_FALLBACK_HEIGHT;
  const viewportWidth =
    args.viewportSize.width || GRAPH_VIEWPORT_FALLBACK_WIDTH;
  const overscan =
    args.overscan ??
    Math.max(360, Math.min(760, Math.max(viewportWidth, viewportHeight) * 0.65));
  const scale = Math.max(args.viewport.scale, 0.001);

  return {
    bottom: (viewportHeight - args.viewport.y + overscan) / scale,
    left: (-args.viewport.x - overscan) / scale,
    right: (viewportWidth - args.viewport.x + overscan) / scale,
    top: (-args.viewport.y - overscan) / scale,
  };
}

export function graphPlacementIntersectsBounds(
  placement: Pick<
    ConversationGraphNodePlacement,
    "height" | "width" | "x" | "y"
  >,
  bounds: ConversationGraphBounds,
) {
  return (
    placement.x + placement.width >= bounds.left &&
    placement.x <= bounds.right &&
    placement.y + placement.height >= bounds.top &&
    placement.y <= bounds.bottom
  );
}

export function buildConversationGraphNodeSpatialIndex(
  nodes: ConversationGraphNodePlacement[],
  cellSize = GRAPH_SPATIAL_INDEX_CELL_SIZE,
): ConversationGraphNodeSpatialIndex {
  const cells = new Map<string, ConversationGraphNodePlacement[]>();

  for (const node of nodes) {
    const firstColumn = Math.floor(node.x / cellSize);
    const lastColumn = Math.floor((node.x + node.width) / cellSize);
    const firstRow = Math.floor(node.y / cellSize);
    const lastRow = Math.floor((node.y + node.height) / cellSize);

    for (let column = firstColumn; column <= lastColumn; column += 1) {
      for (let row = firstRow; row <= lastRow; row += 1) {
        const key = getSpatialCellKey(column, row);
        const cell = cells.get(key) ?? [];

        cell.push(node);
        cells.set(key, cell);
      }
    }
  }

  return { cellSize, cells };
}

export function queryConversationGraphNodeSpatialIndex(
  index: ConversationGraphNodeSpatialIndex,
  bounds: ConversationGraphBounds,
) {
  const firstColumn = Math.floor(bounds.left / index.cellSize);
  const lastColumn = Math.floor(bounds.right / index.cellSize);
  const firstRow = Math.floor(bounds.top / index.cellSize);
  const lastRow = Math.floor(bounds.bottom / index.cellSize);
  const visited = new Set<string>();
  const placements: ConversationGraphNodePlacement[] = [];

  for (let column = firstColumn; column <= lastColumn; column += 1) {
    for (let row = firstRow; row <= lastRow; row += 1) {
      for (const placement of
        index.cells.get(getSpatialCellKey(column, row)) ?? []) {
        if (
          visited.has(placement.conversationId) ||
          !graphPlacementIntersectsBounds(placement, bounds)
        ) {
          continue;
        }

        visited.add(placement.conversationId);
        placements.push(placement);
      }
    }
  }

  return placements.sort(
    (left, right) =>
      left.depth - right.depth || left.y - right.y || left.x - right.x,
  );
}

function buildConversationGraphGroupPlacements(
  groups: Record<string, ConversationGroup>,
  nodes: ConversationGraphNodePlacement[],
) {
  const placementById = new Map<string, ConversationGraphNodePlacement>();
  const placements: ConversationGraphGroupPlacement[] = [];

  for (const node of nodes) {
    placementById.set(node.conversationId, node);
  }

  for (const group of Object.values(groups)) {
    const conversationIds: string[] = [];
    let minimumX = Number.POSITIVE_INFINITY;
    let minimumY = Number.POSITIVE_INFINITY;
    let maximumX = Number.NEGATIVE_INFINITY;
    let maximumY = Number.NEGATIVE_INFINITY;

    for (const conversationId of group.conversationIds) {
      const placement = placementById.get(conversationId);

      if (!placement) {
        continue;
      }

      conversationIds.push(conversationId);
      minimumX = Math.min(minimumX, placement.x);
      minimumY = Math.min(minimumY, placement.y);
      maximumX = Math.max(maximumX, placement.x + placement.width);
      maximumY = Math.max(maximumY, placement.y + placement.height);
    }

    if (!conversationIds.length) {
      continue;
    }

    const inset = 18;

    placements.push({
      conversationIds,
      groupId: group.id,
      height: maximumY - minimumY + inset * 2,
      width: maximumX - minimumX + inset * 2,
      x: minimumX - inset,
      y: minimumY - inset,
    });
  }

  return placements;
}

function buildConversationGraphEdges(
  conversations: Record<string, Conversation>,
  nodes: ConversationGraphNodePlacement[],
  selectedConversationId: string,
) {
  const placementById = new Map<string, ConversationGraphNodePlacement>();
  const selectedPathIds = new Set(
    getConversationPath(conversations, selectedConversationId).map(
      (conversation) => conversation.id,
    ),
  );
  const edges: ConversationGraphEdgePlacement[] = [];

  for (const node of nodes) {
    placementById.set(node.conversationId, node);
  }

  for (const childPlacement of nodes) {
    const childConversation = conversations[childPlacement.conversationId];

    if (!childConversation.parentId) {
      continue;
    }

    const parentPlacement = placementById.get(childConversation.parentId);
    const parentConversation = conversations[childConversation.parentId];

    if (!parentPlacement || !parentConversation) {
      continue;
    }

    edges.push({
      childConversationId: childConversation.id,
      endX: childPlacement.x,
      endY: childPlacement.y + Math.min(childPlacement.height / 2, 44),
      isSelectedPath: selectedPathIds.has(childConversation.id),
      parentConversationId: parentConversation.id,
      startX: parentPlacement.x + parentPlacement.width,
      startY: parentPlacement.y + parentPlacement.height / 2,
    });
  }

  return edges;
}

export function buildConversationGraphScene(args: {
  conversations: Record<string, Conversation>;
  detailLevel?: ConversationGraphDetail;
  groups?: Record<string, ConversationGroup>;
  mode: ConversationGraphMode;
  semanticLevel?: ConversationGraphSemanticLevel;
  selectedConversationId: string;
}) : ConversationGraphScene {
  const detailLevel =
    args.detailLevel ?? (args.mode === "focus" ? "preview" : "compact");
  const semanticLevel = args.semanticLevel ?? "compact";
  const threadEntries = getConversationGraphThreadEntries(
    args.conversations,
    args.selectedConversationId,
  );
  const focusedIds = getFocusedConversationGraphIds(
    args.conversations,
    args.selectedConversationId,
  );
  const nodesByDepth = new Map<number, ConversationGraphNodePlacement[]>();

  for (const { conversationId, depth } of threadEntries) {
    if (args.mode !== "overview" && !focusedIds.has(conversationId)) {
      continue;
    }

    const conversation = args.conversations[conversationId];
    const dimensions = getNodeDimensions({
      conversation,
      detailLevel,
      isSelected: conversationId === args.selectedConversationId,
      mode: args.mode,
      semanticLevel,
    });
    const depthNodes = nodesByDepth.get(depth) ?? [];

    depthNodes.push({
      conversationId,
      depth,
      ...dimensions,
      x: 0,
      y: 0,
    });
    nodesByDepth.set(depth, depthNodes);
  }

  const horizontalGap = args.mode === "focus" ? 108 : 82;
  const verticalGap = args.mode === "focus" ? 28 : 20;
  const paddingX = args.mode === "focus" ? 72 : 54;
  const paddingY = args.mode === "focus" ? 54 : 42;
  const orderedDepths = [...nodesByDepth.keys()].sort((left, right) => left - right);
  const columnWidths = new Map<number, number>();
  const columnHeights = new Map<number, number>();

  for (const depth of orderedDepths) {
    const depthNodes = nodesByDepth.get(depth) ?? [];
    columnWidths.set(
      depth,
      depthNodes.reduce((maximum, node) => Math.max(maximum, node.width), 0),
    );
    columnHeights.set(
      depth,
      depthNodes.reduce(
        (total, node, index) =>
          total + node.height + (index === 0 ? 0 : verticalGap),
        0,
      ),
    );
  }

  let maximumColumnHeight = 0;

  for (const columnHeight of columnHeights.values()) {
    maximumColumnHeight = Math.max(maximumColumnHeight, columnHeight);
  }

  let nextX = paddingX;

  for (const depth of orderedDepths) {
    const depthNodes = nodesByDepth.get(depth) ?? [];
    const columnHeight = columnHeights.get(depth) ?? 0;
    let nextY = paddingY + (maximumColumnHeight - columnHeight) / 2;

    for (const node of depthNodes) {
      node.x = nextX;
      node.y = nextY;
      nextY += node.height + verticalGap;
    }

    nextX += (columnWidths.get(depth) ?? 0) + horizontalGap;
  }

  const nodes: ConversationGraphNodePlacement[] = [];

  for (const depth of orderedDepths) {
    for (const node of nodesByDepth.get(depth) ?? []) {
      nodes.push(node);
    }
  }

  const edges = buildConversationGraphEdges(
    args.conversations,
    nodes,
    args.selectedConversationId,
  );

  const groups = buildConversationGraphGroupPlacements(
    args.groups ?? {},
    nodes,
  );

  return {
    edges,
    groups,
    height: maximumColumnHeight + paddingY * 2,
    nodes,
    width: Math.max(
      520,
      nodes.reduce((maximum, node) => Math.max(maximum, node.x + node.width), 0) +
        paddingX,
    ),
  };
}

export function buildConversationForestGraphScene(args: {
  conversations: Record<string, Conversation>;
  detailLevel?: ConversationGraphDetail;
  groups?: Record<string, ConversationGroup>;
  semanticLevel?: ConversationGraphSemanticLevel;
  selectedConversationId: string;
  treeLayouts?: Record<
    string,
    Pick<GraphNodeLayout, "x" | "y"> & {
      positioned?: boolean;
      treeOriginX?: number;
      treeOriginY?: number;
    }
  >;
}): ConversationGraphScene {
  const roots = getRootConversations(args.conversations).sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
  const selectedRootId = getConversationRootId(
    args.conversations,
    args.selectedConversationId,
  );
  const nodes: ConversationGraphNodePlacement[] = [];
  let nextFallbackTop = 0;

  for (const root of roots) {
    const isSelectedTree = root.id === selectedRootId;
    const treeScene = buildConversationGraphScene({
      conversations: args.conversations,
      detailLevel: isSelectedTree ? args.detailLevel : "compact",
      groups: {},
      mode: "overview",
      semanticLevel: args.semanticLevel,
      selectedConversationId: isSelectedTree
        ? args.selectedConversationId
        : root.id,
    });
    const rootPlacement = treeScene.nodes.find(
      (placement) => placement.conversationId === root.id,
    );

    if (!rootPlacement) {
      continue;
    }

    const savedRootLayout = args.treeLayouts?.[root.id];
    const offsetX = savedRootLayout
      ? (savedRootLayout.treeOriginX ?? savedRootLayout.x) - rootPlacement.x
      : 0;
    const offsetY = savedRootLayout
      ? (savedRootLayout.treeOriginY ?? savedRootLayout.y) - rootPlacement.y
      : nextFallbackTop;

    for (const placement of treeScene.nodes) {
      const savedNodeLayout = args.treeLayouts?.[placement.conversationId];
      const useSavedNodePosition = Boolean(savedNodeLayout?.positioned);

      nodes.push({
        ...placement,
        x: useSavedNodePosition
          ? savedNodeLayout!.x
          : placement.x + offsetX,
        y: useSavedNodePosition
          ? savedNodeLayout!.y
          : placement.y + offsetY,
      });
    }

    nextFallbackTop = Math.max(
      nextFallbackTop,
      offsetY + treeScene.height + 220,
    );
  }

  const edges = buildConversationGraphEdges(
    args.conversations,
    nodes,
    args.selectedConversationId,
  );

  const groups = buildConversationGraphGroupPlacements(
    args.groups ?? {},
    nodes,
  );
  const width = nodes.reduce(
    (maximum, node) => Math.max(maximum, node.x + node.width + 54),
    520,
  );
  const height = nodes.reduce(
    (maximum, node) => Math.max(maximum, node.y + node.height + 42),
    280,
  );

  return { edges, groups, height, nodes, width };
}
