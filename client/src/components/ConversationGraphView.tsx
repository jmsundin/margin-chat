import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
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
      originHeight: number;
      originWidth: number;
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
      (layout.x + GRAPH_STAGE_PADDING + layout.width / 2),
    y:
      args.viewportHeight * 0.24 -
      (layout.y + GRAPH_STAGE_PADDING + Math.min(layout.height / 2, 240)),
  };
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
  const [viewport, setViewport] = useState<ViewportPosition>({
    x: GRAPH_VIEWPORT_MARGIN,
    y: GRAPH_VIEWPORT_MARGIN,
  });
  const [isPanning, setIsPanning] = useState(false);
  const [draggingConversationId, setDraggingConversationId] = useState<
    string | null
  >(null);
  const [resizingConversationId, setResizingConversationId] = useState<
    string | null
  >(null);
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
    const maxRight = Object.values(graphLayouts).reduce(
      (currentMax, layout) => Math.max(currentMax, layout.x + layout.width),
      0,
    );
    const maxBottom = Object.values(graphLayouts).reduce(
      (currentMax, layout) => Math.max(currentMax, layout.y + layout.height),
      0,
    );

    return {
      height: Math.max(1600, maxBottom + GRAPH_STAGE_PADDING * 2),
      width: Math.max(2200, maxRight + GRAPH_STAGE_PADDING * 2),
    };
  }, [graphLayouts]);
  const stageStyle = {
    height: `${stageSize.height}px`,
    transform: `translate(${Math.round(viewport.x)}px, ${Math.round(viewport.y)}px)`,
    width: `${stageSize.width}px`,
  } as CSSProperties;
  const gridOffsetX = ((viewport.x % 36) + 36) % 36;
  const gridOffsetY = ((viewport.y % 36) + 36) % 36;
  const viewportStyle = {
    backgroundPosition: `${gridOffsetX}px ${gridOffsetY}px, ${
      gridOffsetX / 2
    }px ${gridOffsetY / 2}px, center`,
  } as CSSProperties;

  useEffect(() => {
    const viewportElement = viewportRef.current;

    if (!viewportElement) {
      return;
    }

    const nextViewport = getViewportPositionForConversation({
      conversationId: activeConversationId,
      graphLayouts,
      viewportHeight: viewportElement.clientHeight,
      viewportWidth: viewportElement.clientWidth,
    });

    if (!initializedViewportRef.current) {
      initializedViewportRef.current = true;
      centeredConversationIdRef.current = activeConversationId;
      setViewport(nextViewport);
      return;
    }

    if (centeredConversationIdRef.current === activeConversationId) {
      return;
    }

    const activeLayout = graphLayouts[activeConversationId];

    if (!activeLayout) {
      return;
    }

    const left = viewport.x + activeLayout.x + GRAPH_STAGE_PADDING;
    const right = left + activeLayout.width;
    const top = viewport.y + activeLayout.y + GRAPH_STAGE_PADDING;
    const bottom = top + activeLayout.height;
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
    setViewport(nextViewport);
  }, [activeConversationId]);

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
        setViewport({
          x: interaction.originX + (event.clientX - interaction.startClientX),
          y: interaction.originY + (event.clientY - interaction.startClientY),
        });
        return;
      }

      if (interaction.type === "move") {
        onUpdateGraphNodeLayout(interaction.conversationId, {
          x: Math.max(
            0,
            Math.round(
              interaction.originX + (event.clientX - interaction.startClientX),
            ),
          ),
          y: Math.max(
            0,
            Math.round(
              interaction.originY + (event.clientY - interaction.startClientY),
            ),
          ),
        });
        return;
      }

      onUpdateGraphNodeLayout(interaction.conversationId, {
        height: clamp(
          interaction.originHeight + (event.clientY - interaction.startClientY),
          GRAPH_NODE_MIN_HEIGHT,
          GRAPH_NODE_MAX_HEIGHT,
        ),
        width: clamp(
          interaction.originWidth + (event.clientX - interaction.startClientX),
          GRAPH_NODE_MIN_WIDTH,
          GRAPH_NODE_MAX_WIDTH,
        ),
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
  }, [onUpdateGraphNodeLayout]);

  function startPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }

    const target = event.target as HTMLElement;

    if (target.closest("[data-graph-node='true']")) {
      return;
    }

    event.preventDefault();
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
    onActivateConversation(conversationId);
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
    onActivateConversation(conversationId);
    interactionRef.current = {
      conversationId,
      originHeight: layout.height,
      originWidth: layout.width,
      startClientX: event.clientX,
      startClientY: event.clientY,
      type: "resize",
    };
    setResizingConversationId(conversationId);
    document.body.style.setProperty("cursor", "nwse-resize");
    document.body.style.setProperty("user-select", "none");
  }

  function handleViewportWheel(event: ReactWheelEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;

    if (
      target.closest(".panel-body") ||
      target.closest(".composer-primary-scroll") ||
      target.closest(".composer-textarea")
    ) {
      return;
    }

    event.preventDefault();
    setViewport((current) => ({
      x: current.x - event.deltaX,
      y: current.y - event.deltaY,
    }));
  }

  function handleResizeKeyDown(
    conversationId: string,
    event: ReactKeyboardEvent<HTMLButtonElement>,
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

    if (event.key === "ArrowUp") {
      event.preventDefault();
      onUpdateGraphNodeLayout(conversationId, {
        height: clamp(
          layout.height - step,
          GRAPH_NODE_MIN_HEIGHT,
          GRAPH_NODE_MAX_HEIGHT,
        ),
      });
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      onUpdateGraphNodeLayout(conversationId, {
        height: clamp(
          layout.height + step,
          GRAPH_NODE_MIN_HEIGHT,
          GRAPH_NODE_MAX_HEIGHT,
        ),
      });
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      onUpdateGraphNodeLayout(conversationId, {
        height: GRAPH_NODE_DEFAULT_HEIGHT,
        width: GRAPH_NODE_DEFAULT_WIDTH,
      });
    }
  }

  return (
    <div
      className={isPanning ? "graph-canvas-viewport is-panning" : "graph-canvas-viewport"}
      onPointerDown={startPan}
      onWheel={handleViewportWheel}
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
              GRAPH_STAGE_PADDING + parentLayout.x + parentLayout.width;
            const startY =
              GRAPH_STAGE_PADDING + parentLayout.y + parentLayout.height / 2;
            const endX = GRAPH_STAGE_PADDING + childLayout.x;
            const endY =
              GRAPH_STAGE_PADDING + childLayout.y + childLayout.height / 2;
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
            left: `${GRAPH_STAGE_PADDING + layout.x}px`,
            top: `${GRAPH_STAGE_PADDING + layout.y}px`,
            width: `${layout.width}px`,
            zIndex: isActive ? 8 : 3,
          } as CSSProperties;

          return (
            <div
              key={conversation.id}
              className={[
                "graph-node-shell",
                isActive ? "is-active" : "",
                draggingConversationId === conversation.id ? "is-dragging" : "",
                resizingConversationId === conversation.id ? "is-resizing" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              data-graph-node="true"
              style={nodeStyle}
            >
              <div className="graph-node-toolbar" data-graph-node-toolbar="true">
                <button
                  className="graph-node-drag-handle"
                  onClick={() => onActivateConversation(conversation.id)}
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

              <div className="graph-node-panel">
                <ChatPanel
                  anchorsByMessageId={getAnchorsByMessageId(conversation.id)}
                  conversation={conversation}
                  draft={drafts[conversation.id] ?? ""}
                  isActive={isActive}
                  isSubmitting={Boolean(pendingConversationIds[conversation.id])}
                  onActivate={() => onActivateConversation(conversation.id)}
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

              <button
                aria-label={`Resize ${conversation.title}`}
                className="graph-node-resize-handle"
                onKeyDown={(event) => handleResizeKeyDown(conversation.id, event)}
                onPointerDown={(event) => startNodeResize(conversation.id, event)}
                type="button"
              >
                <span className="graph-node-resize-grip" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
