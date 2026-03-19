import type { Conversation, GraphNodeLayout } from "../types";
import { getRootConversations } from "./tree";

export const GRAPH_NODE_DEFAULT_WIDTH = 520;
export const GRAPH_NODE_DEFAULT_HEIGHT = 640;
export const GRAPH_NODE_MIN_WIDTH = 360;
export const GRAPH_NODE_MIN_HEIGHT = 320;
export const GRAPH_NODE_MAX_WIDTH = 960;
export const GRAPH_NODE_MAX_HEIGHT = 1200;
export const GRAPH_NODE_GAP_X = 180;
export const GRAPH_NODE_GAP_Y = 120;
export const GRAPH_ROOT_GAP_Y = 220;
export const GRAPH_BRANCH_OFFSET_Y = 64;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

function normalizeCoordinate(value: unknown, fallback: number) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return Math.max(0, Math.round(fallback));
  }

  return Math.max(0, Math.round(parsed));
}

function normalizeDimension(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return clamp(Math.round(fallback), minimum, maximum);
  }

  return clamp(Math.round(parsed), minimum, maximum);
}

function sortConversationIdsByCreatedAt(
  conversations: Record<string, Conversation>,
  conversationIds: string[],
) {
  return [...conversationIds].sort((leftId, rightId) =>
    conversations[leftId].createdAt.localeCompare(conversations[rightId].createdAt),
  );
}

function measureSubtreeHeight(
  conversations: Record<string, Conversation>,
  conversationId: string,
  memo: Map<string, number>,
): number {
  const cached = memo.get(conversationId);

  if (cached) {
    return cached;
  }

  const conversation = conversations[conversationId];

  if (!conversation) {
    memo.set(conversationId, GRAPH_NODE_DEFAULT_HEIGHT);
    return GRAPH_NODE_DEFAULT_HEIGHT;
  }

  const children = sortConversationIdsByCreatedAt(
    conversations,
    conversation.childIds.filter((childId) => Boolean(conversations[childId])),
  );

  if (!children.length) {
    memo.set(conversationId, GRAPH_NODE_DEFAULT_HEIGHT);
    return GRAPH_NODE_DEFAULT_HEIGHT;
  }

  const childrenHeight = children.reduce((totalHeight, childId, index) => {
    const subtreeHeight = measureSubtreeHeight(conversations, childId, memo);

    return (
      totalHeight +
      subtreeHeight +
      (index === 0 ? 0 : GRAPH_NODE_GAP_Y)
    );
  }, 0);
  const nextHeight = Math.max(GRAPH_NODE_DEFAULT_HEIGHT, childrenHeight);

  memo.set(conversationId, nextHeight);
  return nextHeight;
}

function placeSubtree(args: {
  conversations: Record<string, Conversation>;
  conversationId: string;
  depth: number;
  layouts: Record<string, GraphNodeLayout>;
  memo: Map<string, number>;
  topY: number;
}) {
  const subtreeHeight = measureSubtreeHeight(
    args.conversations,
    args.conversationId,
    args.memo,
  );
  const conversation = args.conversations[args.conversationId];

  if (!conversation) {
    return;
  }

  args.layouts[conversation.id] = createDefaultGraphNodeLayout({
    x: args.depth * (GRAPH_NODE_DEFAULT_WIDTH + GRAPH_NODE_GAP_X),
    y: args.topY + Math.max(0, (subtreeHeight - GRAPH_NODE_DEFAULT_HEIGHT) / 2),
  });

  let nextChildTopY = args.topY;
  const children = sortConversationIdsByCreatedAt(
    args.conversations,
    conversation.childIds.filter((childId) => Boolean(args.conversations[childId])),
  );

  for (const childId of children) {
    placeSubtree({
      conversationId: childId,
      conversations: args.conversations,
      depth: args.depth + 1,
      layouts: args.layouts,
      memo: args.memo,
      topY: nextChildTopY,
    });

    nextChildTopY +=
      measureSubtreeHeight(args.conversations, childId, args.memo) +
      GRAPH_NODE_GAP_Y;
  }
}

export function createDefaultGraphNodeLayout(
  partial: Partial<GraphNodeLayout> = {},
): GraphNodeLayout {
  return {
    height: normalizeDimension(
      partial.height,
      GRAPH_NODE_DEFAULT_HEIGHT,
      GRAPH_NODE_MIN_HEIGHT,
      GRAPH_NODE_MAX_HEIGHT,
    ),
    width: normalizeDimension(
      partial.width,
      GRAPH_NODE_DEFAULT_WIDTH,
      GRAPH_NODE_MIN_WIDTH,
      GRAPH_NODE_MAX_WIDTH,
    ),
    x: normalizeCoordinate(partial.x, 0),
    y: normalizeCoordinate(partial.y, 0),
  };
}

export function buildDefaultGraphLayouts(
  conversations: Record<string, Conversation>,
): Record<string, GraphNodeLayout> {
  const layouts: Record<string, GraphNodeLayout> = {};
  const memo = new Map<string, number>();
  let topY = 0;

  for (const rootConversation of getRootConversations(conversations).sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  )) {
    placeSubtree({
      conversationId: rootConversation.id,
      conversations,
      depth: 0,
      layouts,
      memo,
      topY,
    });

    topY +=
      measureSubtreeHeight(conversations, rootConversation.id, memo) +
      GRAPH_ROOT_GAP_Y;
  }

  return layouts;
}

export function normalizeGraphLayouts(
  conversations: Record<string, Conversation>,
  input: unknown,
): Record<string, GraphNodeLayout> {
  const defaults = buildDefaultGraphLayouts(conversations);
  const source =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};

  return Object.fromEntries(
    Object.keys(conversations).map((conversationId) => {
      const candidate = source[conversationId];
      const fallback = defaults[conversationId] ?? createDefaultGraphNodeLayout();

      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        return [conversationId, fallback];
      }

      const candidateLayout = candidate as Partial<GraphNodeLayout>;

      return [
        conversationId,
        createDefaultGraphNodeLayout({
          height: candidateLayout.height ?? fallback.height,
          width: candidateLayout.width ?? fallback.width,
          x: candidateLayout.x ?? fallback.x,
          y: candidateLayout.y ?? fallback.y,
        }),
      ];
    }),
  );
}

export function buildRootGraphNodeLayout(
  conversations: Record<string, Conversation>,
  graphLayouts: Record<string, GraphNodeLayout>,
) {
  const maxBottom = Object.values(conversations).reduce((currentBottom, conversation) => {
    const layout = graphLayouts[conversation.id];

    if (!layout) {
      return currentBottom;
    }

    return Math.max(currentBottom, layout.y + layout.height);
  }, 0);

  return createDefaultGraphNodeLayout({
    x: 0,
    y: maxBottom === 0 ? 0 : maxBottom + GRAPH_ROOT_GAP_Y,
  });
}

export function buildBranchGraphNodeLayout(args: {
  conversations: Record<string, Conversation>;
  graphLayouts: Record<string, GraphNodeLayout>;
  parentConversationId: string;
}) {
  const parentConversation = args.conversations[args.parentConversationId];
  const parentLayout =
    args.graphLayouts[args.parentConversationId] ?? createDefaultGraphNodeLayout();
  const siblingBottom = (parentConversation?.childIds ?? []).reduce(
    (currentBottom, childId) => {
      const layout = args.graphLayouts[childId];

      if (!layout) {
        return currentBottom;
      }

      return Math.max(currentBottom, layout.y + layout.height);
    },
    parentLayout.y,
  );

  return createDefaultGraphNodeLayout({
    x: parentLayout.x + parentLayout.width + GRAPH_NODE_GAP_X,
    y:
      siblingBottom > parentLayout.y
        ? siblingBottom + GRAPH_NODE_GAP_Y
        : parentLayout.y + GRAPH_BRANCH_OFFSET_Y,
  });
}
