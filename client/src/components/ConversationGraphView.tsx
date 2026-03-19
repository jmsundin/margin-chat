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
  GRAPH_NODE_DEFAULT_HEIGHT,
  GRAPH_NODE_DEFAULT_WIDTH,
  GRAPH_NODE_MAX_HEIGHT,
  GRAPH_NODE_MAX_WIDTH,
  GRAPH_NODE_MIN_HEIGHT,
  GRAPH_NODE_MIN_WIDTH,
} from "../lib/graphLayout";
import { excerpt, getConversationPath } from "../lib/tree";
import type {
  BackendServiceId,
  Conversation,
  GraphNodeLayout,
  MessageAnchorLink,
  SelectionDraft,
} from "../types";

const GRAPH_STAGE_PADDING = 240;
const GRAPH_VIEWPORT_MARGIN = 96;
const GRAPH_RESIZE_KEYBOARD_STEP = 24;
const GRAPH_SCALE_MAX = 2.2;
const GRAPH_SCALE_MIN = 0.55;
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
  selectionPreview: SelectionDraft | null;
  theme: "light" | "dark";
  typingProgressByMessageId: Record<string, number>;
  typingMessageIds: Record<string, boolean>;
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
  selectionPreview,
  theme,
  typingProgressByMessageId,
  typingMessageIds,
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
  const [scrollFocusedConversationId, setScrollFocusedConversationId] =
    useState<string | null>(null);
  const activePathIds = useMemo(
    () =>
      new Set(
        getConversationPath(conversations, activeConversationId).map(
          (conversation) => conversation.id,
        ),
      ),
    [activeConversationId, conversations],
  );
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

    if (!layouts.length) {
      return {
        height: 1600,
        originX: GRAPH_STAGE_PADDING,
        originY: GRAPH_STAGE_PADDING,
        width: 2200,
      };
    }

    const maxRight = layouts.reduce(
      (currentMax, layout) => Math.max(currentMax, layout.x + layout.width),
      0,
    );
    const maxBottom = layouts.reduce(
      (currentMax, layout) => Math.max(currentMax, layout.y + layout.height),
      0,
    );

    return {
      height: Math.max(1600, maxBottom + GRAPH_STAGE_PADDING * 2),
      originX: GRAPH_STAGE_PADDING,
      originY: GRAPH_STAGE_PADDING,
      width: Math.max(2200, maxRight + GRAPH_STAGE_PADDING * 2),
    };
  }, [graphLayouts]);
  const stageStyle = {
    height: `${stageSize.height}px`,
    transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${scale})`,
    width: `${stageSize.width}px`,
  } as CSSProperties;
  const gridSize = 36 * scale;
  const gridOffsetX = ((viewport.x % gridSize) + gridSize) % gridSize;
  const gridOffsetY = ((viewport.y % gridSize) + gridSize) % gridSize;
  const viewportStyle = {
    backgroundSize: `auto, auto, ${gridSize}px ${gridSize}px, ${gridSize}px ${gridSize}px, auto`,
    backgroundPosition: `${gridOffsetX}px ${gridOffsetY}px, ${
      gridOffsetX / 2
    }px ${gridOffsetY / 2}px, center`,
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

    const nextViewport = getViewportPositionForConversation({
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

    const activeLayout = graphLayouts[activeConversationId];

    if (!activeLayout) {
      return;
    }

    const left = viewport.x + (activeLayout.x + stageSize.originX) * scale;
    const right = left + activeLayout.width * scale;
    const top = viewport.y + (activeLayout.y + stageSize.originY) * scale;
    const bottom = top + activeLayout.height * scale;
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
  }, [activeConversationId, scale, stageSize.originX, stageSize.originY]);

  useEffect(() => {
    if (
      scrollFocusedConversationId &&
      scrollFocusedConversationId !== activeConversationId
    ) {
      setScrollFocusedConversationId(null);
    }
  }, [activeConversationId, scrollFocusedConversationId]);

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

  function startPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }

    const target = event.target as HTMLElement;

    if (target.closest("[data-graph-node='true']")) {
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
      suppressNextAutoCenterRef.current = true;
      const currentScale = scaleRef.current;
      const currentViewport = viewportStateRef.current;
      const nextScale = clamp(
        currentScale * Math.exp(-normalizedDeltaY * GRAPH_ZOOM_SENSITIVITY),
        GRAPH_SCALE_MIN,
        GRAPH_SCALE_MAX,
      );
      const worldX = (localX - currentViewport.x) / currentScale;
      const worldY = (localY - currentViewport.y) / currentScale;
      const nextViewport = {
        x: localX - worldX * nextScale,
        y: localY - worldY * nextScale,
      };

      scaleRef.current = nextScale;
      viewportStateRef.current = nextViewport;
      setScale(nextScale);
      setViewport(nextViewport);
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
      style={viewportStyle}
    >
      <div className="graph-canvas-stage" style={stageStyle}>
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

          {Object.values(conversations).map((conversation) => {
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

            return (
              <g key={`graph-edge-${conversation.id}`}>
                <path
                  className={
                    isActivePath
                      ? "graph-connection-path is-active"
                      : "graph-connection-path"
                  }
                  d={buildConnectorPath({
                    endX,
                    endY,
                    startX,
                    startY,
                  })}
                />
                <circle
                  className={
                    isActivePath
                      ? "graph-connection-node is-active"
                      : "graph-connection-node"
                  }
                  cx={startX}
                  cy={startY}
                  r={4}
                />
                <circle
                  className={
                    isActivePath
                      ? "graph-connection-node is-active"
                      : "graph-connection-node"
                  }
                  cx={endX}
                  cy={endY}
                  r={4}
                />
              </g>
            );
          })}
        </svg>

        {orderedConversations.map((conversation) => {
          const layout = graphLayouts[conversation.id];

          if (!layout) {
            return null;
          }

          const isActive = conversation.id === activeConversationId;
          const nodeStyle = {
            height: `${layout.height}px`,
            left: `${stageSize.originX + layout.x}px`,
            top: `${stageSize.originY + layout.y}px`,
            width: `${layout.width}px`,
            zIndex: isActive ? 8 : 3,
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
                  <span className="graph-node-type">
                    {conversation.parentId === null ? "Main chat" : "Branch"}
                  </span>
                  <strong>{conversation.title}</strong>
                  <span className="graph-node-context">
                    {conversation.branchAnchor
                      ? excerpt(
                          conversation.branchAnchor.prompt ||
                            conversation.branchAnchor.quote,
                          56,
                        )
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
