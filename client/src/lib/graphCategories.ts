import type {
  Conversation,
  GraphNodeLayout,
  ThreadCategoryId,
  ThreadSummary,
} from "../types";
import {
  GRAPH_NODE_DEFAULT_HEIGHT,
  GRAPH_NODE_DEFAULT_WIDTH,
  createDefaultGraphNodeLayout,
} from "./graphLayout";
import {
  THREAD_CATEGORY_DEFINITIONS,
  getThreadCategoryDescription,
  getThreadCategoryLabel,
} from "./threadCategories";

const GRAPH_CATEGORY_HEADER_HEIGHT = 118;
const GRAPH_CATEGORY_HUB_HEIGHT = 108;
const GRAPH_CATEGORY_HUB_INSET = 28;
const GRAPH_CATEGORY_PADDING_X = 56;
const GRAPH_CATEGORY_PADDING_BOTTOM = 60;
const GRAPH_CATEGORY_THREAD_GAP = 96;
const GRAPH_CATEGORY_COLUMN_GAP = 164;
const GRAPH_CATEGORY_ROW_GAP = 152;
const GRAPH_CATEGORY_MIN_HEIGHT =
  GRAPH_CATEGORY_HEADER_HEIGHT +
  GRAPH_NODE_DEFAULT_HEIGHT +
  GRAPH_CATEGORY_PADDING_BOTTOM;
const GRAPH_CATEGORY_MIN_WIDTH =
  GRAPH_NODE_DEFAULT_WIDTH + GRAPH_CATEGORY_PADDING_X * 2 + 140;

interface GraphRect {
  height: number;
  width: number;
  x: number;
  y: number;
}

export interface GraphCategoryPalette {
  accent: string;
  border: string;
  glow: string;
  surface: string;
  surfaceStrong: string;
}

export interface GraphCategoryRegionRoot {
  conversationId: string;
  height: number;
  width: number;
  x: number;
  y: number;
}

export interface GraphCategoryRegion {
  bounds: GraphRect;
  categoryId: ThreadCategoryId;
  description: string;
  hub: GraphRect;
  label: string;
  palette: GraphCategoryPalette;
  panelCount: number;
  roots: GraphCategoryRegionRoot[];
  threadCount: number;
}

interface ThreadSubtreeLayout {
  conversationIds: string[];
  height: number;
  maxX: number;
  maxY: number;
  minX: number;
  minY: number;
  width: number;
}

const GRAPH_CATEGORY_PALETTES: Record<ThreadCategoryId, GraphCategoryPalette> = {
  coding: {
    accent: "rgba(109, 226, 170, 0.96)",
    border: "rgba(109, 226, 170, 0.3)",
    glow: "rgba(109, 226, 170, 0.18)",
    surface: "rgba(43, 92, 72, 0.18)",
    surfaceStrong: "rgba(63, 126, 99, 0.28)",
  },
  data: {
    accent: "rgba(116, 205, 255, 0.96)",
    border: "rgba(116, 205, 255, 0.28)",
    glow: "rgba(116, 205, 255, 0.16)",
    surface: "rgba(39, 74, 112, 0.2)",
    surfaceStrong: "rgba(49, 96, 144, 0.3)",
  },
  design: {
    accent: "rgba(255, 171, 122, 0.98)",
    border: "rgba(255, 171, 122, 0.3)",
    glow: "rgba(255, 171, 122, 0.18)",
    surface: "rgba(109, 61, 39, 0.2)",
    surfaceStrong: "rgba(148, 84, 54, 0.3)",
  },
  general: {
    accent: "rgba(197, 205, 214, 0.96)",
    border: "rgba(197, 205, 214, 0.24)",
    glow: "rgba(197, 205, 214, 0.14)",
    surface: "rgba(73, 84, 94, 0.18)",
    surfaceStrong: "rgba(94, 107, 118, 0.26)",
  },
  personal: {
    accent: "rgba(255, 142, 183, 0.96)",
    border: "rgba(255, 142, 183, 0.28)",
    glow: "rgba(255, 142, 183, 0.16)",
    surface: "rgba(107, 45, 78, 0.2)",
    surfaceStrong: "rgba(143, 58, 104, 0.28)",
  },
  planning: {
    accent: "rgba(241, 202, 119, 0.98)",
    border: "rgba(241, 202, 119, 0.28)",
    glow: "rgba(241, 202, 119, 0.16)",
    surface: "rgba(111, 91, 39, 0.2)",
    surfaceStrong: "rgba(145, 118, 49, 0.3)",
  },
  research: {
    accent: "rgba(147, 173, 255, 0.98)",
    border: "rgba(147, 173, 255, 0.3)",
    glow: "rgba(147, 173, 255, 0.18)",
    surface: "rgba(54, 60, 114, 0.2)",
    surfaceStrong: "rgba(71, 81, 151, 0.3)",
  },
  writing: {
    accent: "rgba(190, 153, 255, 0.98)",
    border: "rgba(190, 153, 255, 0.28)",
    glow: "rgba(190, 153, 255, 0.16)",
    surface: "rgba(80, 54, 116, 0.2)",
    surfaceStrong: "rgba(104, 70, 149, 0.3)",
  },
};

function normalizeLayoutMap(
  conversations: Record<string, Conversation>,
  graphLayouts: Record<string, GraphNodeLayout>,
) {
  return Object.fromEntries(
    Object.keys(conversations).map((conversationId) => [
      conversationId,
      createDefaultGraphNodeLayout(graphLayouts[conversationId]),
    ]),
  ) as Record<string, GraphNodeLayout>;
}

function collectSubtreeConversationIds(
  conversations: Record<string, Conversation>,
  rootConversationId: string,
) {
  const visited = new Set<string>();
  const orderedConversationIds: string[] = [];
  const stack = [rootConversationId];

  while (stack.length) {
    const conversationId = stack.pop();

    if (!conversationId || visited.has(conversationId) || !conversations[conversationId]) {
      continue;
    }

    visited.add(conversationId);
    orderedConversationIds.push(conversationId);

    for (const childConversationId of [...conversations[conversationId].childIds].reverse()) {
      stack.push(childConversationId);
    }
  }

  return orderedConversationIds;
}

function measureThreadSubtreeLayout(args: {
  conversations: Record<string, Conversation>;
  graphLayouts: Record<string, GraphNodeLayout>;
  rootConversationId: string;
}): ThreadSubtreeLayout {
  const conversationIds = collectSubtreeConversationIds(
    args.conversations,
    args.rootConversationId,
  );
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const conversationId of conversationIds) {
    const layout =
      args.graphLayouts[conversationId] ?? createDefaultGraphNodeLayout();

    minX = Math.min(minX, layout.x);
    minY = Math.min(minY, layout.y);
    maxX = Math.max(maxX, layout.x + layout.width);
    maxY = Math.max(maxY, layout.y + layout.height);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    const fallbackLayout =
      args.graphLayouts[args.rootConversationId] ?? createDefaultGraphNodeLayout();

    return {
      conversationIds: [args.rootConversationId],
      height: fallbackLayout.height,
      maxX: fallbackLayout.x + fallbackLayout.width,
      maxY: fallbackLayout.y + fallbackLayout.height,
      minX: fallbackLayout.x,
      minY: fallbackLayout.y,
      width: fallbackLayout.width,
    };
  }

  return {
    conversationIds,
    height: maxY - minY,
    maxX,
    maxY,
    minX,
    minY,
    width: maxX - minX,
  };
}

function buildCategoryBuckets(
  conversations: Record<string, Conversation>,
  threads: ThreadSummary[],
) {
  return THREAD_CATEGORY_DEFINITIONS.map((category) => ({
    categoryId: category.id,
    threads: threads.filter(
      (thread) => thread.categoryId === category.id && Boolean(conversations[thread.id]),
    ),
  })).filter((bucket) => bucket.threads.length > 0);
}

export function getGraphCategoryPalette(categoryId: ThreadCategoryId) {
  return GRAPH_CATEGORY_PALETTES[categoryId];
}

export function buildGraphCategoryRegions(args: {
  conversations: Record<string, Conversation>;
  graphLayouts: Record<string, GraphNodeLayout>;
  threads: ThreadSummary[];
}): GraphCategoryRegion[] {
  const normalizedLayouts = normalizeLayoutMap(args.conversations, args.graphLayouts);

  return buildCategoryBuckets(args.conversations, args.threads).map((bucket) => {
    const subtreeLayouts = bucket.threads.map((thread) =>
      measureThreadSubtreeLayout({
        conversations: args.conversations,
        graphLayouts: normalizedLayouts,
        rootConversationId: thread.id,
      }),
    );
    const minX = subtreeLayouts.reduce(
      (currentMin, layout) => Math.min(currentMin, layout.minX),
      Number.POSITIVE_INFINITY,
    );
    const minY = subtreeLayouts.reduce(
      (currentMin, layout) => Math.min(currentMin, layout.minY),
      Number.POSITIVE_INFINITY,
    );
    const maxX = subtreeLayouts.reduce(
      (currentMax, layout) => Math.max(currentMax, layout.maxX),
      Number.NEGATIVE_INFINITY,
    );
    const maxY = subtreeLayouts.reduce(
      (currentMax, layout) => Math.max(currentMax, layout.maxY),
      Number.NEGATIVE_INFINITY,
    );
    const bounds = {
      height: Math.max(
        GRAPH_CATEGORY_MIN_HEIGHT,
        maxY - minY + GRAPH_CATEGORY_HEADER_HEIGHT + GRAPH_CATEGORY_PADDING_BOTTOM,
      ),
      width: Math.max(
        GRAPH_CATEGORY_MIN_WIDTH,
        maxX - minX + GRAPH_CATEGORY_PADDING_X * 2,
      ),
      x: minX - GRAPH_CATEGORY_PADDING_X,
      y: minY - GRAPH_CATEGORY_HEADER_HEIGHT,
    };
    const hubWidth = Math.min(360, Math.max(244, bounds.width * 0.42));

    return {
      bounds,
      categoryId: bucket.categoryId,
      description: getThreadCategoryDescription(bucket.categoryId),
      hub: {
        height: GRAPH_CATEGORY_HUB_HEIGHT,
        width: hubWidth,
        x: bounds.x + GRAPH_CATEGORY_HUB_INSET,
        y: bounds.y + GRAPH_CATEGORY_HUB_INSET,
      },
      label: getThreadCategoryLabel(bucket.categoryId),
      palette: getGraphCategoryPalette(bucket.categoryId),
      panelCount: bucket.threads.reduce(
        (totalPanels, thread) => totalPanels + thread.conversationCount,
        0,
      ),
      roots: bucket.threads
        .map((thread) => {
          const layout = normalizedLayouts[thread.id];

          if (!layout) {
            return null;
          }

          return {
            conversationId: thread.id,
            height: layout.height,
            width: layout.width,
            x: layout.x,
            y: layout.y,
          };
        })
        .filter((root): root is GraphCategoryRegionRoot => Boolean(root)),
      threadCount: bucket.threads.length,
    };
  });
}

export function buildCategoryOrganizedGraphLayouts(args: {
  conversations: Record<string, Conversation>;
  graphLayouts: Record<string, GraphNodeLayout>;
  threads: ThreadSummary[];
}) {
  const normalizedLayouts = normalizeLayoutMap(args.conversations, args.graphLayouts);
  const buckets = buildCategoryBuckets(args.conversations, args.threads).map((bucket) => {
    const subtreeLayouts = bucket.threads.map((thread) => ({
      rootConversationId: thread.id,
      subtree: measureThreadSubtreeLayout({
        conversations: args.conversations,
        graphLayouts: normalizedLayouts,
        rootConversationId: thread.id,
      }),
    }));
    const width = Math.max(
      GRAPH_CATEGORY_MIN_WIDTH,
      subtreeLayouts.reduce(
        (currentMax, entry) => Math.max(currentMax, entry.subtree.width),
        0,
      ) +
        GRAPH_CATEGORY_PADDING_X * 2,
    );
    const height = Math.max(
      GRAPH_CATEGORY_MIN_HEIGHT,
      GRAPH_CATEGORY_HEADER_HEIGHT +
        GRAPH_CATEGORY_PADDING_BOTTOM +
        subtreeLayouts.reduce(
          (totalHeight, entry, index) =>
            totalHeight +
            entry.subtree.height +
            (index === 0 ? 0 : GRAPH_CATEGORY_THREAD_GAP),
          0,
        ),
    );

    return {
      categoryId: bucket.categoryId,
      height,
      subtreeLayouts,
      width,
    };
  });

  if (!buckets.length) {
    return normalizedLayouts;
  }

  const columnCount = buckets.length >= 5 ? 3 : Math.min(2, buckets.length);
  const rowCount = Math.ceil(buckets.length / columnCount);
  const columnWidths = Array.from({ length: columnCount }, () => 0);
  const rowHeights = Array.from({ length: rowCount }, () => 0);

  for (const [index, bucket] of buckets.entries()) {
    const columnIndex = index % columnCount;
    const rowIndex = Math.floor(index / columnCount);

    columnWidths[columnIndex] = Math.max(columnWidths[columnIndex], bucket.width);
    rowHeights[rowIndex] = Math.max(rowHeights[rowIndex], bucket.height);
  }

  const totalWidth =
    columnWidths.reduce((sum, width) => sum + width, 0) +
    GRAPH_CATEGORY_COLUMN_GAP * Math.max(0, columnCount - 1);
  const totalHeight =
    rowHeights.reduce((sum, height) => sum + height, 0) +
    GRAPH_CATEGORY_ROW_GAP * Math.max(0, rowCount - 1);
  const columnStarts: number[] = [];
  const rowStarts: number[] = [];
  let nextColumnX = -Math.round(totalWidth / 2);
  let nextRowY = -Math.round(totalHeight / 2);

  for (const width of columnWidths) {
    columnStarts.push(nextColumnX);
    nextColumnX += width + GRAPH_CATEGORY_COLUMN_GAP;
  }

  for (const height of rowHeights) {
    rowStarts.push(nextRowY);
    nextRowY += height + GRAPH_CATEGORY_ROW_GAP;
  }

  const nextLayouts = { ...normalizedLayouts };

  for (const [index, bucket] of buckets.entries()) {
    const columnIndex = index % columnCount;
    const rowIndex = Math.floor(index / columnCount);
    const categoryX = columnStarts[columnIndex];
    const categoryY = rowStarts[rowIndex];
    let nextThreadY = categoryY + GRAPH_CATEGORY_HEADER_HEIGHT;

    for (const entry of bucket.subtreeLayouts) {
      const deltaX = categoryX + GRAPH_CATEGORY_PADDING_X - entry.subtree.minX;
      const deltaY = nextThreadY - entry.subtree.minY;

      for (const conversationId of entry.subtree.conversationIds) {
        const currentLayout =
          nextLayouts[conversationId] ?? createDefaultGraphNodeLayout();

        nextLayouts[conversationId] = createDefaultGraphNodeLayout({
          ...currentLayout,
          x: currentLayout.x + deltaX,
          y: currentLayout.y + deltaY,
        });
      }

      nextThreadY += entry.subtree.height + GRAPH_CATEGORY_THREAD_GAP;
    }
  }

  return nextLayouts;
}
