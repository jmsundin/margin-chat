import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import ChatPanel from "./ChatPanel";
import {
  buildDefaultGraphLayouts,
  GRAPH_NODE_DEFAULT_HEIGHT,
  GRAPH_NODE_DEFAULT_WIDTH,
  GRAPH_NODE_MAX_HEIGHT,
  GRAPH_NODE_MAX_WIDTH,
  GRAPH_NODE_MIN_HEIGHT,
  GRAPH_NODE_MIN_WIDTH,
} from "../lib/graphLayout";
import {
  buildCategoryOrganizedGraphLayouts,
  buildGraphCategoryRegions,
  getGraphCategoryPalette,
  type GraphCategoryPalette,
} from "../lib/graphCategories";
import type { RecentBackendServiceSelection } from "../lib/services";
import { excerpt, getConversationPath, getConversationRootId } from "../lib/tree";
import type {
  BackendServiceId,
  Conversation,
  GraphNodeLayout,
  MessageAnchorLink,
  SelectionDraft,
  ThreadCategoryId,
  ThreadSummary,
} from "../types";

const GRAPH_STAGE_PADDING = 240;
const GRAPH_STAGE_WORLD_BLEED = 3200;
const GRAPH_STAGE_WORLD_ORIGIN = 3200;
const GRAPH_VIEWPORT_MARGIN = 96;
const GRAPH_RESIZE_KEYBOARD_STEP = 24;
const GRAPH_SCALE_MAX = 2.2;
const GRAPH_SCALE_MIN = 0.22;
const GRAPH_BUTTON_ZOOM_FACTOR = 1.18;
const GRAPH_CATEGORY_OVERVIEW_SCALE = 0.46;
const GRAPH_CATEGORY_FOCUS_SCALE = 0.84;
const GRAPH_ZOOM_SENSITIVITY = 0.0012;

type ViewportPosition = {
  x: number;
  y: number;
};

type ActiveInteraction =
  | {
      originX: number;
      originY: number;
      startClientX: number;
      startClientY: number;
      type: "pan";
    }
  | {
      conversationId: string;
      originX: number;
      originY: number;
      startClientX: number;
      startClientY: number;
      type: "move";
    }
  | {
      conversationId: string;
      handle: "corner-bottom" | "corner-top" | "edge";
      originHeight: number;
      originWidth: number;
      originY: number;
      startClientX: number;
      startClientY: number;
      type: "resize";
    };

interface ConversationGraphViewProps {
  activeConversationId: string;
  conversations: Record<string, Conversation>;
  drafts: Record<string, string>;
  getAnchorsByMessageId: (
    conversationId: string,
  ) => Record<string, MessageAnchorLink[]>;
  graphLayouts: Record<string, GraphNodeLayout>;
  pendingConversationIds: Record<string, boolean>;
  recentModelSelections: RecentBackendServiceSelection[];
  selectionPreview: SelectionDraft | null;
  theme: "light" | "dark";
  threads: ThreadSummary[];
  typingProgressByMessageId: Record<string, number>;
  typingMessageIds: Record<string, boolean>;
  onApplyGraphLayouts: (nextLayouts: Record<string, GraphNodeLayout>) => void;
  onActivateConversation: (conversationId: string) => void;
  onDraftChange: (conversationId: string, value: string) => void;
  onModelChange: (
    conversationId: string,
    serviceId: BackendServiceId,
    modelId: string,
  ) => void;
  onStopTypewriter: (conversationId: string) => void;
  onSubmit: (conversationId: string, value: string) => void;
  onTypewriterComplete: (messageId: string) => void;
  onTypewriterProgress: (messageId: string, visibleCount: number) => void;
  onUpdateGraphNodeLayout: (
    conversationId: string,
    nextLayout: Partial<GraphNodeLayout>,
  ) => void;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

function buildConnectorPath(args: {
  endX: number;
  endY: number;
  startX: number;
  startY: number;
}) {
  const horizontalGap = args.endX - args.startX;

  if (horizontalGap <= 32) {
    return `M ${args.startX} ${args.startY} L ${args.endX} ${args.endY}`;
  }

  const controlOffset = Math.max(72, Math.min(220, horizontalGap * 0.35));

  return `M ${args.startX} ${args.startY} C ${args.startX + controlOffset} ${
    args.startY
  }, ${args.endX - controlOffset} ${args.endY}, ${args.endX} ${args.endY}`;
}

function getViewportPositionForConversation(args: {
  conversationId: string;
  graphLayouts: Record<string, GraphNodeLayout>;
  stageOriginX: number;
  stageOriginY: number;
  scale: number;
  viewportHeight: number;
  viewportWidth: number;
}) {
  const layout = args.graphLayouts[args.conversationId];

  if (!layout) {
    return {
      x: GRAPH_VIEWPORT_MARGIN,
      y: GRAPH_VIEWPORT_MARGIN,
    };
  }

  return {
    x:
      args.viewportWidth * 0.32 -
      (layout.x + args.stageOriginX + layout.width / 2) * args.scale,
    y:
      args.viewportHeight * 0.24 -
      (layout.y + args.stageOriginY + Math.min(layout.height / 2, 240)) *
        args.scale,
  };
}

function getGraphNodeScrollElement(target: HTMLElement | null) {
  if (!target) {
    return null;
  }

  return (
    target.closest<HTMLElement>(".composer-textarea") ??
    target.closest<HTMLElement>(".panel-body") ??
    target.closest<HTMLElement>(".composer-primary-scroll")
  );
}

function canScrollGraphNodeElement(element: HTMLElement, deltaY: number) {
  if (Math.abs(deltaY) < 0.5) {
    return false;
  }

  const maxScrollTop = element.scrollHeight - element.clientHeight;

  if (maxScrollTop <= 1) {
    return false;
  }

  if (deltaY < 0) {
    return element.scrollTop > 1;
  }

  return element.scrollTop < maxScrollTop - 1;
}

function normalizeWheelDelta(
  delta: number,
  deltaMode: number,
  viewportSize: number,
) {
  if (deltaMode === WheelEvent.DOM_DELTA_LINE) {
    return delta * 16;
  }

  if (deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return delta * Math.max(viewportSize, 800);
  }

  return delta;
}

function areGraphLayoutsEqual(
  left: Record<string, GraphNodeLayout>,
  right: Record<string, GraphNodeLayout>,
) {
  const leftIds = Object.keys(left);
  const rightIds = Object.keys(right);

  if (leftIds.length !== rightIds.length) {
    return false;
  }

  return leftIds.every((conversationId) => {
    const leftLayout = left[conversationId];
    const rightLayout = right[conversationId];

    return (
      Boolean(rightLayout) &&
      leftLayout.x === rightLayout.x &&
      leftLayout.y === rightLayout.y &&
      leftLayout.width === rightLayout.width &&
      leftLayout.height === rightLayout.height
    );
  });
}

function getCategoryStyleVariables(palette: GraphCategoryPalette) {
  return {
    "--graph-category-accent": palette.accent,
    "--graph-category-border": palette.border,
    "--graph-category-glow": palette.glow,
    "--graph-category-surface": palette.surface,
    "--graph-category-surface-strong": palette.surfaceStrong,
  } as CSSProperties;
}

function noopRegisterPanelRef() {}

function noopRegisterComposerSurfaceRef() {}

function noopRegisterAnchorRef() {}

export default function ConversationGraphView({
  activeConversationId,
  conversations,
  drafts,
  getAnchorsByMessageId,
  graphLayouts,
  pendingConversationIds,
  recentModelSelections,
  selectionPreview,
  theme,
  threads,
  typingProgressByMessageId,
  typingMessageIds,
  onApplyGraphLayouts,
  onActivateConversation,
  onDraftChange,
  onModelChange,
  onStopTypewriter,
  onSubmit,
  onTypewriterComplete,
  onTypewriterProgress,
  onUpdateGraphNodeLayout,
}: ConversationGraphViewProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const interactionRef = useRef<ActiveInteraction | null>(null);
  const initializedViewportRef = useRef(false);
  const autoArrangedByCategoryRef = useRef(false);
  const centeredConversationIdRef = useRef<string | null>(null);
  const suppressNextAutoCenterRef = useRef(false);
  const scaleRef = useRef(1);
  const [viewport, setViewport] = useState<ViewportPosition>({
    x: GRAPH_VIEWPORT_MARGIN,
    y: GRAPH_VIEWPORT_MARGIN,
  });
  const viewportStateRef = useRef<ViewportPosition>({
    x: GRAPH_VIEWPORT_MARGIN,
    y: GRAPH_VIEWPORT_MARGIN,
  });
  const [scale, setScale] = useState(1);
  const [isPanning, setIsPanning] = useState(false);
  const [draggingConversationId, setDraggingConversationId] = useState<
    string | null
  >(null);
  const [resizingConversationId, setResizingConversationId] = useState<
    string | null
  >(null);
  const [focusedCategoryId, setFocusedCategoryId] = useState<ThreadCategoryId | null>(
    null,
  );
  const [scrollFocusedConversationId, setScrollFocusedConversationId] =
    useState<string | null>(null);
  const threadSummaryById = useMemo(
    () => new Map(threads.map((thread) => [thread.id, thread] as const)),
    [threads],
  );
  const conversationRootIdById = useMemo(
    () =>
      Object.fromEntries(
        Object.keys(conversations).map((conversationId) => [
          conversationId,
          getConversationRootId(conversations, conversationId) ?? conversationId,
        ]),
      ) as Record<string, string>,
    [conversations],
  );
  const categoryByConversationId = useMemo(
    () =>
      Object.fromEntries(
        Object.keys(conversations).map((conversationId) => {
          const rootConversationId = conversationRootIdById[conversationId];

          return [
            conversationId,
            threadSummaryById.get(rootConversationId)?.categoryId ?? "general",
          ];
        }),
      ) as Record<string, ThreadCategoryId>,
    [conversationRootIdById, conversations, threadSummaryById],
  );
  const activeCategoryId = categoryByConversationId[activeConversationId] ?? null;
  const activePathIds = useMemo(
    () =>
      new Set(
        getConversationPath(conversations, activeConversationId).map(
          (conversation) => conversation.id,
        ),
      ),
    [activeConversationId, conversations],
  );
  const categoryRegions = useMemo(
    () =>
      buildGraphCategoryRegions({
        conversations,
        graphLayouts,
        threads,
      }),
    [conversations, graphLayouts, threads],
  );
  const categoryRegionById = useMemo(
    () =>
      new Map(
        categoryRegions.map((region) => [region.categoryId, region] as const),
      ),
    [categoryRegions],
  );
  const defaultGraphLayouts = useMemo(
    () => buildDefaultGraphLayouts(conversations),
    [conversations],
  );
  const categoryOrganizedLayouts = useMemo(
    () =>
      buildCategoryOrganizedGraphLayouts({
        conversations,
        graphLayouts,
        threads,
      }),
    [conversations, graphLayouts, threads],
  );
  const overviewCategoryNodes = useMemo(
    () =>
      categoryRegions.map((region) => {
        const width = Math.min(320, 212 + region.threadCount * 16);
        const height = 128;

        return {
          categoryId: region.categoryId,
          height,
          label: region.label,
          palette: region.palette,
          panelCount: region.panelCount,
          threadCount: region.threadCount,
          width,
          x: region.bounds.x + region.bounds.width / 2 - width / 2,
          y: region.bounds.y + region.bounds.height / 2 - height / 2,
        };
      }),
    [categoryRegions],
  );
  const isCategoryOverview = scale <= GRAPH_CATEGORY_OVERVIEW_SCALE;
  const orderedConversations = useMemo(
    () =>
      Object.values(conversations).sort((left, right) => {
        if (left.id === activeConversationId) {
          return 1;
        }

        if (right.id === activeConversationId) {
          return -1;
        }

        return left.createdAt.localeCompare(right.createdAt);
      }),
    [activeConversationId, conversations],
  );
  const stageSize = useMemo(() => {
    const layouts = Object.values(graphLayouts);
    const categoryBounds = categoryRegions.map((region) => region.bounds);

    if (!layouts.length && !categoryBounds.length) {
      return {
        height: 6400,
        originX: GRAPH_STAGE_WORLD_ORIGIN,
        originY: GRAPH_STAGE_WORLD_ORIGIN,
        width: 6400,
      };
    }

    const maxRight = [...layouts, ...categoryBounds].reduce(
      (currentMax, layout) => Math.max(currentMax, layout.x + layout.width),
      0,
    );
    const maxBottom = [...layouts, ...categoryBounds].reduce(
      (currentMax, layout) => Math.max(currentMax, layout.y + layout.height),
      0,
    );

    return {
      height: Math.max(
        6400,
        GRAPH_STAGE_WORLD_ORIGIN + maxBottom + GRAPH_STAGE_WORLD_BLEED,
      ),
      originX: GRAPH_STAGE_WORLD_ORIGIN,
      originY: GRAPH_STAGE_WORLD_ORIGIN,
      width: Math.max(
        6400,
        GRAPH_STAGE_WORLD_ORIGIN + maxRight + GRAPH_STAGE_WORLD_BLEED,
      ),
    };
  }, [categoryRegions, graphLayouts]);
  const stageStyle = {
    height: `${stageSize.height}px`,
    transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${scale})`,
    width: `${stageSize.width}px`,
  } as CSSProperties;

  useEffect(() => {
    viewportStateRef.current = viewport;
  }, [viewport]);

  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);

  useEffect(() => {
    const viewportElement = viewportRef.current;

    if (!viewportElement) {
      return;
    }

    const activeCategoryRegion =
      activeCategoryId === null ? null : categoryRegionById.get(activeCategoryId);
    const focusBounds =
      isCategoryOverview && activeCategoryRegion
        ? activeCategoryRegion.bounds
        : graphLayouts[activeConversationId]
          ? {
              height: graphLayouts[activeConversationId].height,
              width: graphLayouts[activeConversationId].width,
              x: graphLayouts[activeConversationId].x,
              y: graphLayouts[activeConversationId].y,
            }
          : null;
    const nextViewport =
      isCategoryOverview && activeCategoryRegion
        ? {
            x:
              viewportElement.clientWidth / 2 -
              (stageSize.originX +
                activeCategoryRegion.bounds.x +
                activeCategoryRegion.bounds.width / 2) *
                scale,
            y:
              viewportElement.clientHeight / 2 -
              (stageSize.originY +
                activeCategoryRegion.bounds.y +
                activeCategoryRegion.bounds.height / 2) *
                scale,
          }
        : getViewportPositionForConversation({
            conversationId: activeConversationId,
            graphLayouts,
            scale,
            stageOriginX: stageSize.originX,
            stageOriginY: stageSize.originY,
            viewportHeight: viewportElement.clientHeight,
            viewportWidth: viewportElement.clientWidth,
          });

    if (!initializedViewportRef.current) {
      initializedViewportRef.current = true;
      centeredConversationIdRef.current = activeConversationId;
      viewportStateRef.current = nextViewport;
      setViewport(nextViewport);
      return;
    }

    if (suppressNextAutoCenterRef.current) {
      suppressNextAutoCenterRef.current = false;
      centeredConversationIdRef.current = activeConversationId;
      return;
    }

    if (centeredConversationIdRef.current === activeConversationId) {
      return;
    }

    if (!focusBounds) {
      return;
    }

    const left = viewport.x + (focusBounds.x + stageSize.originX) * scale;
    const right = left + focusBounds.width * scale;
    const top = viewport.y + (focusBounds.y + stageSize.originY) * scale;
    const bottom = top + focusBounds.height * scale;
    const withinHorizontalBounds =
      left >= GRAPH_VIEWPORT_MARGIN &&
      right <= viewportElement.clientWidth - GRAPH_VIEWPORT_MARGIN;
    const withinVerticalBounds =
      top >= GRAPH_VIEWPORT_MARGIN &&
      bottom <= viewportElement.clientHeight - GRAPH_VIEWPORT_MARGIN;

    if (withinHorizontalBounds && withinVerticalBounds) {
      centeredConversationIdRef.current = activeConversationId;
      return;
    }

    centeredConversationIdRef.current = activeConversationId;
    viewportStateRef.current = nextViewport;
    setViewport(nextViewport);
  }, [
    activeCategoryId,
    activeConversationId,
    categoryRegionById,
    graphLayouts,
    isCategoryOverview,
    scale,
    stageSize.originX,
    stageSize.originY,
    viewport.x,
    viewport.y,
  ]);

  useEffect(() => {
    if (
      scrollFocusedConversationId &&
      scrollFocusedConversationId !== activeConversationId
    ) {
      setScrollFocusedConversationId(null);
    }
  }, [activeConversationId, scrollFocusedConversationId]);

  useEffect(() => {
    if (!focusedCategoryId || categoryRegionById.has(focusedCategoryId)) {
      return;
    }

    setFocusedCategoryId(null);
  }, [categoryRegionById, focusedCategoryId]);

  useEffect(() => {
    if (autoArrangedByCategoryRef.current || categoryRegions.length < 2) {
      return;
    }

    if (areGraphLayoutsEqual(graphLayouts, categoryOrganizedLayouts)) {
      autoArrangedByCategoryRef.current = true;
      return;
    }

    if (!areGraphLayoutsEqual(graphLayouts, defaultGraphLayouts)) {
      return;
    }

    autoArrangedByCategoryRef.current = true;
    onApplyGraphLayouts(categoryOrganizedLayouts);
  }, [
    categoryOrganizedLayouts,
    categoryRegions.length,
    defaultGraphLayouts,
    graphLayouts,
    onApplyGraphLayouts,
  ]);

  useEffect(() => {
    function clearInteraction() {
      if (!interactionRef.current) {
        return;
      }

      interactionRef.current = null;
      setDraggingConversationId(null);
      setIsPanning(false);
      setResizingConversationId(null);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    }

    function handlePointerMove(event: PointerEvent) {
      const interaction = interactionRef.current;

      if (!interaction) {
        return;
      }

      event.preventDefault();

      if (interaction.type === "pan") {
        const nextViewport = {
          x: interaction.originX + (event.clientX - interaction.startClientX),
          y: interaction.originY + (event.clientY - interaction.startClientY),
        };

        viewportStateRef.current = nextViewport;
        setViewport(nextViewport);
        return;
      }

      if (interaction.type === "move") {
        onUpdateGraphNodeLayout(interaction.conversationId, {
          x: Math.round(
            interaction.originX +
              (event.clientX - interaction.startClientX) / scale,
          ),
          y: Math.round(
            interaction.originY +
              (event.clientY - interaction.startClientY) / scale,
          ),
        });
        return;
      }

      const width = clamp(
        interaction.originWidth +
          (event.clientX - interaction.startClientX) / scale,
        GRAPH_NODE_MIN_WIDTH,
        GRAPH_NODE_MAX_WIDTH,
      );

      if (interaction.handle === "edge") {
        onUpdateGraphNodeLayout(interaction.conversationId, {
          width,
        });
        return;
      }

      if (interaction.handle === "corner-bottom") {
        onUpdateGraphNodeLayout(interaction.conversationId, {
          height: clamp(
            interaction.originHeight +
              (event.clientY - interaction.startClientY) / scale,
            GRAPH_NODE_MIN_HEIGHT,
            GRAPH_NODE_MAX_HEIGHT,
          ),
          width,
        });
        return;
      }

      const bottomY = interaction.originY + interaction.originHeight;
      const height = clamp(
        interaction.originHeight -
          (event.clientY - interaction.startClientY) / scale,
        GRAPH_NODE_MIN_HEIGHT,
        GRAPH_NODE_MAX_HEIGHT,
      );

      onUpdateGraphNodeLayout(interaction.conversationId, {
        height,
        width,
        y: Math.round(bottomY - height),
      });
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", clearInteraction);
    window.addEventListener("pointercancel", clearInteraction);
    window.addEventListener("blur", clearInteraction);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", clearInteraction);
      window.removeEventListener("pointercancel", clearInteraction);
      window.removeEventListener("blur", clearInteraction);
    };
  }, [onUpdateGraphNodeLayout, scale]);

  function setScaleAtViewportPoint(
    nextScale: number,
    localX: number,
    localY: number,
  ) {
    const currentScale = scaleRef.current;
    const clampedScale = clamp(nextScale, GRAPH_SCALE_MIN, GRAPH_SCALE_MAX);

    if (Math.abs(clampedScale - currentScale) < 0.0001) {
      return;
    }

    suppressNextAutoCenterRef.current = true;
    const currentViewport = viewportStateRef.current;
    const worldX = (localX - currentViewport.x) / currentScale;
    const worldY = (localY - currentViewport.y) / currentScale;
    const nextViewport = {
      x: localX - worldX * clampedScale,
      y: localY - worldY * clampedScale,
    };

    scaleRef.current = clampedScale;
    viewportStateRef.current = nextViewport;
    setScale(clampedScale);
    setViewport(nextViewport);
  }

  function zoomByStep(direction: "in" | "out") {
    const viewportElement = viewportRef.current;

    if (!viewportElement) {
      return;
    }

    const factor =
      direction === "in"
        ? GRAPH_BUTTON_ZOOM_FACTOR
        : 1 / GRAPH_BUTTON_ZOOM_FACTOR;

    setScaleAtViewportPoint(
      scaleRef.current * factor,
      viewportElement.clientWidth / 2,
      viewportElement.clientHeight / 2,
    );
  }

  function focusViewportOnRect(
    bounds: {
      height: number;
      width: number;
      x: number;
      y: number;
    },
    options?: { preferredScale?: number },
  ) {
    const viewportElement = viewportRef.current;

    if (!viewportElement) {
      return;
    }

    const nextScale =
      options?.preferredScale === undefined
        ? scaleRef.current
        : clamp(options.preferredScale, GRAPH_SCALE_MIN, GRAPH_SCALE_MAX);

    suppressNextAutoCenterRef.current = true;
    const nextViewport = {
      x:
        viewportElement.clientWidth / 2 -
        (stageSize.originX + bounds.x + bounds.width / 2) * nextScale,
      y:
        viewportElement.clientHeight / 2 -
        (stageSize.originY + bounds.y + bounds.height / 2) * nextScale,
    };

    scaleRef.current = nextScale;
    viewportStateRef.current = nextViewport;
    setScale(nextScale);
    setViewport(nextViewport);
  }

  function focusCategory(
    categoryId: ThreadCategoryId | null,
    options?: { preferredScale?: number },
  ) {
    setScrollFocusedConversationId(null);
    setFocusedCategoryId(categoryId);

    if (!categoryId) {
      return;
    }

    const region = categoryRegionById.get(categoryId);

    if (!region) {
      return;
    }

    focusViewportOnRect(region.bounds, options);
  }

  function arrangeByCategory() {
    onApplyGraphLayouts(categoryOrganizedLayouts);
    const targetCategoryId = focusedCategoryId ?? activeCategoryId;

    if (!targetCategoryId) {
      return;
    }

    const nextRegion = buildGraphCategoryRegions({
      conversations,
      graphLayouts: categoryOrganizedLayouts,
      threads,
    }).find((region) => region.categoryId === targetCategoryId);

    if (!nextRegion) {
      return;
    }

    focusViewportOnRect(nextRegion.bounds);
  }

  function selectCategoryFromLegend(categoryId: ThreadCategoryId | null) {
    if (categoryId === null) {
      focusCategory(null);
      return;
    }

    focusCategory(categoryId, {
      preferredScale: isCategoryOverview
        ? Math.max(scaleRef.current, GRAPH_CATEGORY_FOCUS_SCALE)
        : undefined,
    });
  }

  function startPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }

    const target = event.target as HTMLElement;

    if (
      target.closest("[data-graph-node='true']") ||
      target.closest("[data-graph-ui='true']")
    ) {
      return;
    }

    event.preventDefault();
    setScrollFocusedConversationId(null);
    interactionRef.current = {
      originX: viewport.x,
      originY: viewport.y,
      startClientX: event.clientX,
      startClientY: event.clientY,
      type: "pan",
    };
    setIsPanning(true);
    document.body.style.setProperty("cursor", "grabbing");
    document.body.style.setProperty("user-select", "none");
  }

  function activateConversationLocally(
    conversationId: string,
    options?: { engageScroll?: boolean },
  ) {
    const nextCategoryId = categoryByConversationId[conversationId];

    if (focusedCategoryId && nextCategoryId && focusedCategoryId !== nextCategoryId) {
      setFocusedCategoryId(nextCategoryId);
    }

    suppressNextAutoCenterRef.current = true;
    onActivateConversation(conversationId);

    if (options?.engageScroll) {
      setScrollFocusedConversationId(conversationId);
      return;
    }

    setScrollFocusedConversationId(null);
  }

  function startNodeDrag(
    conversationId: string,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) {
    if (event.button !== 0) {
      return;
    }

    const layout = graphLayouts[conversationId];

    if (!layout) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    activateConversationLocally(conversationId);
    interactionRef.current = {
      conversationId,
      originX: layout.x,
      originY: layout.y,
      startClientX: event.clientX,
      startClientY: event.clientY,
      type: "move",
    };
    setDraggingConversationId(conversationId);
    document.body.style.setProperty("cursor", "grabbing");
    document.body.style.setProperty("user-select", "none");
  }

  function startNodeResize(
    conversationId: string,
    handle: "corner-bottom" | "corner-top" | "edge",
    event: ReactPointerEvent<HTMLElement>,
  ) {
    if (event.button !== 0) {
      return;
    }

    const layout = graphLayouts[conversationId];

    if (!layout) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    activateConversationLocally(conversationId);
    interactionRef.current = {
      conversationId,
      handle,
      originHeight: layout.height,
      originWidth: layout.width,
      originY: layout.y,
      startClientX: event.clientX,
      startClientY: event.clientY,
      type: "resize",
    };
    setResizingConversationId(conversationId);
    document.body.style.setProperty(
      "cursor",
      handle === "edge"
        ? "col-resize"
        : handle === "corner-top"
          ? "nesw-resize"
          : "nwse-resize",
    );
    document.body.style.setProperty("user-select", "none");
  }

  const handleViewportWheel = useEffectEvent((event: WheelEvent) => {
    const viewportElement = viewportRef.current;
    const target = event.target as HTMLElement;
    const hoveredNode = target.closest<HTMLElement>("[data-graph-node='true']");
    const hoveredConversationId = hoveredNode?.dataset.conversationId ?? null;
    const normalizedDeltaX = normalizeWheelDelta(
      event.deltaX,
      event.deltaMode,
      viewportElement?.clientWidth ?? 0,
    );
    const normalizedDeltaY = normalizeWheelDelta(
      event.deltaY,
      event.deltaMode,
      viewportElement?.clientHeight ?? 0,
    );
    const scrollElement =
      hoveredConversationId === activeConversationId &&
      hoveredConversationId === scrollFocusedConversationId
        ? getGraphNodeScrollElement(target)
        : null;

    if (
      !event.ctrlKey &&
      scrollElement &&
      canScrollGraphNodeElement(scrollElement, normalizedDeltaY)
    ) {
      return;
    }

    event.preventDefault();

    if (event.ctrlKey) {
      if (!viewportElement) {
        return;
      }

      const rect = viewportElement.getBoundingClientRect();
      const localX = event.clientX - rect.left;
      const localY = event.clientY - rect.top;
      const nextScale =
        scaleRef.current * Math.exp(-normalizedDeltaY * GRAPH_ZOOM_SENSITIVITY);

      setScaleAtViewportPoint(nextScale, localX, localY);
      return;
    }

    setViewport((current) => {
      const nextViewport = {
        x: current.x - normalizedDeltaX,
        y: current.y - normalizedDeltaY,
      };

      viewportStateRef.current = nextViewport;
      return nextViewport;
    });
  });

  useEffect(() => {
    const viewportElement = viewportRef.current;

    if (!viewportElement) {
      return;
    }

    function handleNativeWheel(event: WheelEvent) {
      handleViewportWheel(event);
    }

    viewportElement.addEventListener("wheel", handleNativeWheel, {
      passive: false,
    });

    return () => {
      viewportElement.removeEventListener("wheel", handleNativeWheel);
    };
  }, [handleViewportWheel]);

  function handleResizeKeyDown(
    conversationId: string,
    event: ReactKeyboardEvent<HTMLElement>,
  ) {
    const layout = graphLayouts[conversationId];

    if (!layout) {
      return;
    }

    const step = event.shiftKey
      ? GRAPH_RESIZE_KEYBOARD_STEP * 2
      : GRAPH_RESIZE_KEYBOARD_STEP;

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onUpdateGraphNodeLayout(conversationId, {
        width: clamp(
          layout.width - step,
          GRAPH_NODE_MIN_WIDTH,
          GRAPH_NODE_MAX_WIDTH,
        ),
      });
      return;
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      onUpdateGraphNodeLayout(conversationId, {
        width: clamp(
          layout.width + step,
          GRAPH_NODE_MIN_WIDTH,
          GRAPH_NODE_MAX_WIDTH,
        ),
      });
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      onUpdateGraphNodeLayout(conversationId, {
        width: GRAPH_NODE_MIN_WIDTH,
      });
      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      onUpdateGraphNodeLayout(conversationId, {
        width: GRAPH_NODE_MAX_WIDTH,
      });
    }
  }

  return (
    <div
      className={isPanning ? "graph-canvas-viewport is-panning" : "graph-canvas-viewport"}
      onPointerDown={startPan}
      ref={viewportRef}
    >
      {categoryRegions.length ? (
        <div
          className="graph-map-hud"
          data-graph-ui="true"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="graph-map-zoom-stack">
            <button
              aria-label="Zoom in"
              className="graph-map-zoom-button"
              data-graph-ui="true"
              disabled={scale >= GRAPH_SCALE_MAX - 0.01}
              onClick={() => zoomByStep("in")}
              type="button"
            >
              +
            </button>

            <button
              aria-label="Zoom out"
              className="graph-map-zoom-button"
              data-graph-ui="true"
              disabled={scale <= GRAPH_SCALE_MIN + 0.01}
              onClick={() => zoomByStep("out")}
              type="button"
            >
              -
            </button>
          </div>

          <div className="graph-category-dock">
            <div className="graph-category-dock-head">
              <div className="graph-category-dock-copy">
                <p className="graph-category-dock-label">Workspace Map</p>
                <p className="graph-category-dock-body">
                  {isCategoryOverview
                    ? "Zoomed out to category view"
                    : focusedCategoryId
                      ? "Focused on one category"
                      : "Legend and category focus"}
                </p>
              </div>

              <button
                className="graph-category-arrange-button"
                data-graph-ui="true"
                onClick={arrangeByCategory}
                type="button"
              >
                Arrange
              </button>
            </div>

            <div
              aria-label="Focus graph by category"
              className="graph-category-chip-row"
              role="toolbar"
            >
              <button
                aria-pressed={focusedCategoryId === null}
                className={
                  focusedCategoryId === null
                    ? "graph-category-chip is-active is-neutral"
                    : "graph-category-chip is-neutral"
                }
                data-graph-ui="true"
                onClick={() => selectCategoryFromLegend(null)}
                type="button"
              >
                <span>All threads</span>
                <strong>{threads.length}</strong>
              </button>

              {categoryRegions.map((region) => (
                <button
                  key={`graph-category-chip-${region.categoryId}`}
                  aria-pressed={focusedCategoryId === region.categoryId}
                  className={
                    focusedCategoryId === region.categoryId
                      ? "graph-category-chip is-active"
                      : "graph-category-chip"
                  }
                  data-graph-ui="true"
                  onClick={() =>
                    selectCategoryFromLegend(
                      focusedCategoryId === region.categoryId
                        ? null
                        : region.categoryId,
                    )
                  }
                  style={getCategoryStyleVariables(region.palette)}
                  type="button"
                >
                  <span>{region.label}</span>
                  <strong>{region.threadCount}</strong>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      <div className="graph-canvas-stage" style={stageStyle}>
        <div aria-hidden="true" className="graph-canvas-mesh" />

        {!isCategoryOverview
          ? categoryRegions.map((region) => {
          const isFocused =
            focusedCategoryId === region.categoryId ||
            (!focusedCategoryId && activeCategoryId === region.categoryId);
          const isDimmed = Boolean(
            focusedCategoryId && focusedCategoryId !== region.categoryId,
          );
          const regionStyle = {
            ...getCategoryStyleVariables(region.palette),
            height: `${region.bounds.height}px`,
            left: `${stageSize.originX + region.bounds.x}px`,
            top: `${stageSize.originY + region.bounds.y}px`,
            width: `${region.bounds.width}px`,
          } as CSSProperties;
          const hubStyle = {
            height: `${region.hub.height}px`,
            left: `${region.hub.x - region.bounds.x}px`,
            top: `${region.hub.y - region.bounds.y}px`,
            width: `${region.hub.width}px`,
          } as CSSProperties;

          return (
            <div
              key={`graph-category-region-${region.categoryId}`}
              className={[
                "graph-category-region",
                isFocused ? "is-active" : "",
                isDimmed ? "is-dimmed" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={regionStyle}
            >
              <button
                className="graph-category-hub"
                data-graph-ui="true"
                onClick={() =>
                  focusCategory(
                    focusedCategoryId === region.categoryId
                      ? null
                      : region.categoryId,
                  )
                }
                onPointerDown={(event) => event.stopPropagation()}
                style={hubStyle}
                type="button"
              >
                <span className="graph-category-hub-label">Auto category</span>
                <strong>{region.label}</strong>
                <span className="graph-category-hub-meta">
                  {region.threadCount} main chat
                  {region.threadCount === 1 ? "" : "s"} • {region.panelCount} panel
                  {region.panelCount === 1 ? "" : "s"}
                </span>
                <span className="graph-category-hub-copy">{region.description}</span>
              </button>
            </div>
          );
            })
          : overviewCategoryNodes.map((region) => {
              const isFocused =
                focusedCategoryId === region.categoryId ||
                (!focusedCategoryId && activeCategoryId === region.categoryId);
              const isDimmed = Boolean(
                focusedCategoryId && focusedCategoryId !== region.categoryId,
              );
              const overviewStyle = {
                ...getCategoryStyleVariables(region.palette),
                height: `${region.height}px`,
                left: `${stageSize.originX + region.x}px`,
                top: `${stageSize.originY + region.y}px`,
                width: `${region.width}px`,
              } as CSSProperties;

              return (
                <button
                  key={`graph-category-overview-${region.categoryId}`}
                  className={[
                    "graph-category-overview-node",
                    isFocused ? "is-active" : "",
                    isDimmed ? "is-dimmed" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  data-graph-ui="true"
                  onClick={() =>
                    focusCategory(region.categoryId, {
                      preferredScale: GRAPH_CATEGORY_FOCUS_SCALE,
                    })
                  }
                  onPointerDown={(event) => event.stopPropagation()}
                  style={overviewStyle}
                  type="button"
                >
                  <span className="graph-category-overview-label">
                    Category
                  </span>
                  <strong>{region.label}</strong>
                  <span className="graph-category-overview-meta">
                    {region.threadCount} main chat
                    {region.threadCount === 1 ? "" : "s"} • {region.panelCount} panel
                    {region.panelCount === 1 ? "" : "s"}
                  </span>
                </button>
              );
            })}

        <svg
          aria-hidden="true"
          className="graph-canvas-connections"
          height={stageSize.height}
          viewBox={`0 0 ${stageSize.width} ${stageSize.height}`}
          width={stageSize.width}
        >
          <defs>
            <linearGradient id="graph-connector-gradient" x1="0%" x2="100%">
              <stop offset="0%" stopColor="var(--connector-start)" />
              <stop offset="100%" stopColor="var(--connector-end)" />
            </linearGradient>
          </defs>

          {!isCategoryOverview
            ? categoryRegions.flatMap((region) =>
            region.roots.map((root) => {
              const isFocused =
                focusedCategoryId === region.categoryId ||
                (!focusedCategoryId && activeCategoryId === region.categoryId);
              const isDimmed = Boolean(
                focusedCategoryId && focusedCategoryId !== region.categoryId,
              );
              const startX =
                stageSize.originX + region.hub.x + region.hub.width;
              const startY =
                stageSize.originY + region.hub.y + region.hub.height / 2;
              const endX = stageSize.originX + root.x;
              const endY =
                stageSize.originY + root.y + Math.min(root.height * 0.36, 112);

              return (
                <g key={`graph-category-edge-${region.categoryId}-${root.conversationId}`}>
                  <path
                    className={[
                      "graph-category-connection-path",
                      isFocused ? "is-active" : "",
                      isDimmed ? "is-dimmed" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    d={buildConnectorPath({
                      endX,
                      endY,
                      startX,
                      startY,
                    })}
                    style={{ stroke: region.palette.accent }}
                  />
                  <circle
                    className={[
                      "graph-category-connection-node",
                      isFocused ? "is-active" : "",
                      isDimmed ? "is-dimmed" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    cx={startX}
                    cy={startY}
                    r={4}
                    style={{ fill: region.palette.accent }}
                  />
                  <circle
                    className={[
                      "graph-category-connection-node",
                      isFocused ? "is-active" : "",
                      isDimmed ? "is-dimmed" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    cx={endX}
                    cy={endY}
                    r={4}
                    style={{ fill: region.palette.accent }}
                  />
                </g>
              );
            }),
            )
            : null}

          {!isCategoryOverview
            ? Object.values(conversations).map((conversation) => {
            if (!conversation.parentId) {
              return null;
            }

            const parentLayout = graphLayouts[conversation.parentId];
            const childLayout = graphLayouts[conversation.id];

            if (!parentLayout || !childLayout) {
              return null;
            }

            const startX =
              stageSize.originX + parentLayout.x + parentLayout.width;
            const startY =
              stageSize.originY + parentLayout.y + parentLayout.height / 2;
            const endX = stageSize.originX + childLayout.x;
            const endY =
              stageSize.originY + childLayout.y + childLayout.height / 2;
            const isActivePath = activePathIds.has(conversation.id);
            const isDimmed = Boolean(
              focusedCategoryId &&
                categoryByConversationId[conversation.id] !== focusedCategoryId,
            );

            return (
              <g key={`graph-edge-${conversation.id}`}>
                <path
                  className={[
                    "graph-connection-path",
                    isActivePath ? "is-active" : "",
                    isDimmed ? "is-dimmed" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  d={buildConnectorPath({
                    endX,
                    endY,
                    startX,
                    startY,
                  })}
                />
                <circle
                  className={[
                    "graph-connection-node",
                    isActivePath ? "is-active" : "",
                    isDimmed ? "is-dimmed" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  cx={startX}
                  cy={startY}
                  r={4}
                />
                <circle
                  className={[
                    "graph-connection-node",
                    isActivePath ? "is-active" : "",
                    isDimmed ? "is-dimmed" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  cx={endX}
                  cy={endY}
                  r={4}
                />
              </g>
            );
            })
            : null}
        </svg>

        {isCategoryOverview
          ? null
          : orderedConversations.map((conversation) => {
          const layout = graphLayouts[conversation.id];

          if (!layout) {
            return null;
          }

          const isActive = conversation.id === activeConversationId;
          const isDimmed = Boolean(
            focusedCategoryId &&
              categoryByConversationId[conversation.id] !== focusedCategoryId,
          );
          const rootConversationId = conversationRootIdById[conversation.id];
          const threadSummary = threadSummaryById.get(rootConversationId);
          const categoryId = categoryByConversationId[conversation.id];
          const palette = getGraphCategoryPalette(categoryId);
          const nodeStyle = {
            ...getCategoryStyleVariables(palette),
            height: `${layout.height}px`,
            left: `${stageSize.originX + layout.x}px`,
            top: `${stageSize.originY + layout.y}px`,
            width: `${layout.width}px`,
            zIndex: isActive ? 8 : conversation.parentId === null ? 4 : 3,
          } as CSSProperties;

          return (
            <div
              key={conversation.id}
              className={[
                "graph-node-shell",
                isActive ? "is-active" : "",
                scrollFocusedConversationId === conversation.id
                  ? "is-scroll-focused"
                  : "",
                draggingConversationId === conversation.id ? "is-dragging" : "",
                resizingConversationId === conversation.id ? "is-resizing" : "",
                isDimmed ? "is-dimmed" : "",
                conversation.parentId === null ? "is-root-thread" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              data-graph-node="true"
              data-conversation-id={conversation.id}
              style={nodeStyle}
            >
              <div className="graph-node-toolbar" data-graph-node-toolbar="true">
                <button
                  className="graph-node-drag-handle"
                  onClick={() => activateConversationLocally(conversation.id)}
                  onPointerDown={(event) => startNodeDrag(conversation.id, event)}
                  type="button"
                >
                  <div className="graph-node-meta">
                    <span className="graph-node-type">
                      {conversation.parentId === null ? "Main chat" : "Branch"}
                    </span>
                    {conversation.parentId === null && threadSummary ? (
                      <span className="graph-node-category-badge">
                        {threadSummary.categoryLabel}
                      </span>
                    ) : null}
                  </div>
                  <strong>{conversation.title}</strong>
                  <span className="graph-node-context">
                    {conversation.branchAnchor
                      ? excerpt(
                          conversation.branchAnchor.prompt ||
                          conversation.branchAnchor.quote,
                          56,
                        )
                      : conversation.parentId === null && threadSummary
                        ? `${threadSummary.conversationCount} panel${
                            threadSummary.conversationCount === 1 ? "" : "s"
                          } • ${threadSummary.updatedLabel}`
                      : `${conversation.childIds.length} connected ${
                          conversation.childIds.length === 1
                            ? "branch"
                            : "branches"
                        }`}
                  </span>
                </button>
              </div>

              <div
                className="graph-node-panel"
                onPointerDownCapture={(event) => {
                  if (event.button !== 0) {
                    return;
                  }

                  setScrollFocusedConversationId(conversation.id);
                  suppressNextAutoCenterRef.current = true;
                }}
              >
                <ChatPanel
                  anchorsByMessageId={getAnchorsByMessageId(conversation.id)}
                  conversation={conversation}
                  draft={drafts[conversation.id] ?? ""}
                  isActive={isActive}
                  isSubmitting={Boolean(pendingConversationIds[conversation.id])}
                  recentModelSelections={recentModelSelections}
                  onActivate={() =>
                    activateConversationLocally(conversation.id, {
                      engageScroll: true,
                    })
                  }
                  onDraftChange={(value) => onDraftChange(conversation.id, value)}
                  onModelChange={onModelChange}
                  onStopTypewriter={onStopTypewriter}
                  onSubmit={onSubmit}
                  onTypewriterComplete={onTypewriterComplete}
                  onTypewriterProgress={onTypewriterProgress}
                  registerAnchorRef={noopRegisterAnchorRef}
                  registerComposerSurfaceRef={noopRegisterComposerSurfaceRef}
                  registerPanelRef={noopRegisterPanelRef}
                  selectionPreview={
                    selectionPreview?.conversationId === conversation.id
                      ? selectionPreview
                      : null
                  }
                  theme={theme}
                  typingMessageIds={typingMessageIds}
                  typingProgressByMessageId={typingProgressByMessageId}
                />
              </div>

              {isActive || resizingConversationId === conversation.id ? (
                <>
                  <div
                    aria-label="Resize graph node width"
                    aria-orientation="vertical"
                    aria-valuemax={GRAPH_NODE_MAX_WIDTH}
                    aria-valuemin={GRAPH_NODE_MIN_WIDTH}
                    aria-valuenow={Math.round(layout.width)}
                    aria-valuetext={`${Math.round(layout.width)} pixels wide`}
                    className="graph-node-resize-handle"
                    onDoubleClick={() =>
                      onUpdateGraphNodeLayout(conversation.id, {
                        width: GRAPH_NODE_DEFAULT_WIDTH,
                      })
                    }
                    onKeyDown={(event) =>
                      handleResizeKeyDown(conversation.id, event)
                    }
                    onPointerDown={(event) =>
                      startNodeResize(conversation.id, "edge", event)
                    }
                    role="separator"
                    tabIndex={0}
                  >
                    <span className="graph-node-resize-grip" />
                  </div>

                  <button
                    aria-label={`Resize ${conversation.title} from top right`}
                    className="graph-node-corner-knob is-top-right"
                    onDoubleClick={() =>
                      onUpdateGraphNodeLayout(conversation.id, {
                        height: GRAPH_NODE_DEFAULT_HEIGHT,
                        width: GRAPH_NODE_DEFAULT_WIDTH,
                      })
                    }
                    onKeyDown={(event) =>
                      handleResizeKeyDown(conversation.id, event)
                    }
                    onPointerDown={(event) =>
                      startNodeResize(conversation.id, "corner-top", event)
                    }
                    type="button"
                  >
                    <span className="graph-node-corner-knob-dot is-diagonal-top" />
                  </button>

                  <button
                    aria-label={`Resize ${conversation.title} from bottom right`}
                    className="graph-node-corner-knob is-bottom-right"
                    onDoubleClick={() =>
                      onUpdateGraphNodeLayout(conversation.id, {
                        height: GRAPH_NODE_DEFAULT_HEIGHT,
                        width: GRAPH_NODE_DEFAULT_WIDTH,
                      })
                    }
                    onKeyDown={(event) =>
                      handleResizeKeyDown(conversation.id, event)
                    }
                    onPointerDown={(event) =>
                      startNodeResize(conversation.id, "corner-bottom", event)
                    }
                    type="button"
                  >
                    <span className="graph-node-corner-knob-dot is-diagonal" />
                  </button>
                </>
              ) : null}
            </div>
          );
            })}
      </div>
    </div>
  );
}
