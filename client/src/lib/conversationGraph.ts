import type { Conversation } from "../types";
import { getConversationPath, getConversationRootId } from "./tree";

export type ConversationGraphMode = "focus" | "overview";
export type ConversationGraphDetail = "compact" | "preview" | "reader";

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

export interface ConversationGraphScene {
  edges: ConversationGraphEdgePlacement[];
  height: number;
  nodes: ConversationGraphNodePlacement[];
  width: number;
}

const FOCUS_COMPACT_HEIGHT = 88;
const FOCUS_COMPACT_WIDTH = 210;
const OVERVIEW_NODE_HEIGHT = 96;
const OVERVIEW_NODE_WIDTH = 200;
const PREVIEW_NODE_BASE_HEIGHT = 196;
const PREVIEW_NODE_WIDTH = 330;
const PREVIEW_SOURCE_ROWS_TOP = 156;
const READER_NODE_BASE_HEIGHT = 430;
const READER_NODE_WIDTH = 430;
const READER_SOURCE_ROWS_TOP = 302;
const SOURCE_ROW_GAP = 6;
const SOURCE_ROW_HEIGHT = 32;

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

export function getConversationGraphThreadIds(
  conversations: Record<string, Conversation>,
  conversationId: string,
) {
  const rootConversationId = getConversationRootId(conversations, conversationId);

  if (!rootConversationId) {
    return [];
  }

  const orderedIds: string[] = [];
  const visited = new Set<string>();
  const queue = [rootConversationId];

  while (queue.length) {
    const nextConversationId = queue.shift();

    if (
      !nextConversationId ||
      visited.has(nextConversationId) ||
      !conversations[nextConversationId]
    ) {
      continue;
    }

    visited.add(nextConversationId);
    orderedIds.push(nextConversationId);
    queue.push(
      ...sortConversationIds(
        conversations,
        conversations[nextConversationId].childIds,
      ),
    );
  }

  return orderedIds;
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

function getConversationDepth(
  conversations: Record<string, Conversation>,
  conversationId: string,
) {
  return Math.max(0, getConversationPath(conversations, conversationId).length - 1);
}

function getNodeDimensions(args: {
  conversation: Conversation;
  detailLevel: ConversationGraphDetail;
  isSelected: boolean;
  mode: ConversationGraphMode;
}) {
  if (args.isSelected && args.detailLevel === "reader") {
    return {
      height: Math.max(
        READER_NODE_BASE_HEIGHT,
        READER_SOURCE_ROWS_TOP +
          args.conversation.childIds.length * (SOURCE_ROW_HEIGHT + SOURCE_ROW_GAP) +
          12,
      ),
      width: READER_NODE_WIDTH,
    };
  }

  if (args.isSelected && args.detailLevel === "preview") {
    return {
      height: Math.max(
        PREVIEW_NODE_BASE_HEIGHT,
        PREVIEW_SOURCE_ROWS_TOP +
          args.conversation.childIds.length * (SOURCE_ROW_HEIGHT + SOURCE_ROW_GAP) +
          12,
      ),
      width: PREVIEW_NODE_WIDTH,
    };
  }

  if (args.mode === "overview") {
    return {
      height: OVERVIEW_NODE_HEIGHT,
      width: OVERVIEW_NODE_WIDTH,
    };
  }

  return {
    height: FOCUS_COMPACT_HEIGHT,
    width: FOCUS_COMPACT_WIDTH,
  };
}

export function getSelectedSourceAnchorY(
  parentPlacement: ConversationGraphNodePlacement,
  childIndex: number,
  detailLevel: Exclude<ConversationGraphDetail, "compact"> = "preview",
) {
  const sourceRowsTop =
    detailLevel === "reader"
      ? READER_SOURCE_ROWS_TOP
      : PREVIEW_SOURCE_ROWS_TOP;

  return (
    parentPlacement.y +
    sourceRowsTop +
    childIndex * (SOURCE_ROW_HEIGHT + SOURCE_ROW_GAP) +
    SOURCE_ROW_HEIGHT / 2
  );
}

export function buildConversationGraphScene(args: {
  conversations: Record<string, Conversation>;
  detailLevel?: ConversationGraphDetail;
  mode: ConversationGraphMode;
  selectedConversationId: string;
}) : ConversationGraphScene {
  const detailLevel =
    args.detailLevel ?? (args.mode === "focus" ? "preview" : "compact");
  const threadIds = getConversationGraphThreadIds(
    args.conversations,
    args.selectedConversationId,
  );
  const focusedIds = getFocusedConversationGraphIds(
    args.conversations,
    args.selectedConversationId,
  );
  const visibleIds = threadIds.filter(
    (conversationId) =>
      args.mode === "overview" || focusedIds.has(conversationId),
  );
  const selectedPathIds = new Set(
    getConversationPath(args.conversations, args.selectedConversationId).map(
      (conversation) => conversation.id,
    ),
  );
  const nodesByDepth = new Map<number, ConversationGraphNodePlacement[]>();

  for (const conversationId of visibleIds) {
    const conversation = args.conversations[conversationId];
    const depth = getConversationDepth(args.conversations, conversationId);
    const dimensions = getNodeDimensions({
      conversation,
      detailLevel,
      isSelected: conversationId === args.selectedConversationId,
      mode: args.mode,
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

  const maximumColumnHeight = Math.max(0, ...columnHeights.values());
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

  const nodes = orderedDepths.flatMap((depth) => nodesByDepth.get(depth) ?? []);
  const placementById = new Map(
    nodes.map((node) => [node.conversationId, node] as const),
  );
  const edges = nodes.flatMap((childPlacement) => {
    const childConversation = args.conversations[childPlacement.conversationId];

    if (!childConversation.parentId) {
      return [];
    }

    const parentPlacement = placementById.get(childConversation.parentId);
    const parentConversation = args.conversations[childConversation.parentId];

    if (!parentPlacement || !parentConversation) {
      return [];
    }

    const childIndex = sortConversationIds(
      args.conversations,
      parentConversation.childIds,
    ).indexOf(childConversation.id);
    const startY =
      detailLevel !== "compact" &&
      parentConversation.id === args.selectedConversationId &&
      childIndex >= 0
        ? getSelectedSourceAnchorY(parentPlacement, childIndex, detailLevel)
        : parentPlacement.y + parentPlacement.height / 2;

    return [
      {
        childConversationId: childConversation.id,
        endX: childPlacement.x,
        endY: childPlacement.y + Math.min(childPlacement.height / 2, 44),
        isSelectedPath: selectedPathIds.has(childConversation.id),
        parentConversationId: parentConversation.id,
        startX: parentPlacement.x + parentPlacement.width,
        startY,
      },
    ];
  });

  return {
    edges,
    height: maximumColumnHeight + paddingY * 2,
    nodes,
    width: Math.max(
      520,
      nodes.reduce((maximum, node) => Math.max(maximum, node.x + node.width), 0) +
        paddingX,
    ),
  };
}
