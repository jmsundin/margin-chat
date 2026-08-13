import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  buildConversationGraphScene,
  type ConversationGraphDetail,
  type ConversationGraphNodePlacement,
  type ConversationGraphScene,
} from "../lib/conversationGraph";
import { excerpt, getConversationPath, getConversationRootId } from "../lib/tree";
import { getWheelGestureAxis } from "../lib/wheelGestures";
import type { Conversation, ThreadSummary } from "../types";

const GRAPH_SCALE_MIN = 0.38;
const GRAPH_SCALE_MAX = 1.5;
const GRAPH_ZOOM_STEP = 1.14;
const GRAPH_ZOOM_SENSITIVITY = 0.0012;
const GRAPH_PAN_EDGE_MARGIN = 88;
const GRAPH_PAN_SLACK = 112;

type GraphViewport = {
  scale: number;
  x: number;
  y: number;
};

type PanInteraction = {
  originX: number;
  originY: number;
  pointerId: number;
  startClientX: number;
  startClientY: number;
};

interface ConversationGraphViewProps {
  activeConversationId: string;
  conversations: Record<string, Conversation>;
  threads: ThreadSummary[];
  onActivateConversation: (conversationId: string) => void;
  onOpenConversation: (conversationId: string) => void;
  renderDockedConversation?: (conversationId: string) => ReactNode;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

function normalizeWheelDelta(
  delta: number,
  deltaMode: number,
  viewportSize: number,
) {
  if (deltaMode === 1) {
    return delta * 16;
  }

  if (deltaMode === 2) {
    return delta * Math.max(viewportSize, 1);
  }

  return delta;
}

function constrainPanAxis(args: {
  contentSize: number;
  position: number;
  viewportSize: number;
}) {
  if (args.contentSize <= args.viewportSize) {
    const centeredPosition = (args.viewportSize - args.contentSize) / 2;

    return clamp(
      args.position,
      centeredPosition - GRAPH_PAN_SLACK,
      centeredPosition + GRAPH_PAN_SLACK,
    );
  }

  return clamp(
    args.position,
    args.viewportSize - args.contentSize - GRAPH_PAN_EDGE_MARGIN,
    GRAPH_PAN_EDGE_MARGIN,
  );
}

function buildConnectorPath(args: {
  endX: number;
  endY: number;
  startX: number;
  startY: number;
}) {
  const distance = Math.max(0, args.endX - args.startX);
  const controlOffset = Math.max(54, Math.min(150, distance * 0.42));

  return `M ${args.startX} ${args.startY} C ${
    args.startX + controlOffset
  } ${args.startY}, ${args.endX - controlOffset} ${args.endY}, ${args.endX} ${
    args.endY
  }`;
}

function getLatestMessage(
  conversation: Conversation,
  role?: "assistant" | "user",
) {
  return [...conversation.messages]
    .reverse()
    .find((message) => role === undefined || message.role === role);
}

function getConversationPreview(conversation: Conversation) {
  const message =
    getLatestMessage(conversation, "assistant") ??
    getLatestMessage(conversation);

  return message
    ? excerpt(message.content, 124)
    : "This chat does not have any messages yet.";
}

function getSourceQuote(conversation: Conversation) {
  if (!conversation.branchAnchor) {
    return "Root of this discussion";
  }

  return excerpt(
    conversation.branchAnchor.quote || conversation.branchAnchor.prompt,
    132,
  );
}

function sortChildConversations(
  conversations: Record<string, Conversation>,
  conversation: Conversation,
) {
  return conversation.childIds
    .map((conversationId) => conversations[conversationId])
    .filter((child): child is Conversation => Boolean(child))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function calculateFitViewport(
  scene: ConversationGraphScene,
  viewportElement: HTMLDivElement,
): GraphViewport {
  const availableWidth = Math.max(240, viewportElement.clientWidth - 56);
  const availableHeight = Math.max(220, viewportElement.clientHeight - 48);
  const scale = clamp(
    Math.min(availableWidth / scene.width, availableHeight / scene.height),
    GRAPH_SCALE_MIN,
    0.96,
  );

  return {
    scale,
    x: (viewportElement.clientWidth - scene.width * scale) / 2,
    y: (viewportElement.clientHeight - scene.height * scale) / 2,
  };
}

function GraphActionIcon({
  name,
}: {
  name: "collapse" | "dock" | "expand" | "main" | "open";
}) {
  if (name === "collapse") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M6 12h12" />
      </svg>
    );
  }

  if (name === "dock") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <rect height="14" rx="2" width="18" x="3" y="5" />
        <path d="M12 5v14" />
      </svg>
    );
  }

  if (name === "expand") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" />
      </svg>
    );
  }

  if (name === "main") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="m8 4 8 8-8 8" />
      </svg>
    );
  }

  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M5 6.5h14v10H9l-4 3z" />
    </svg>
  );
}

function GraphNodeAction({
  icon,
  label,
  onClick,
  primary = false,
}: {
  icon: "collapse" | "dock" | "expand" | "main" | "open";
  label: string;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      aria-label={label}
      className={
        primary
          ? "conversation-graph-node-action is-primary"
          : "conversation-graph-node-action"
      }
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      title={label}
      type="button"
    >
      <GraphActionIcon name={icon} />
    </button>
  );
}

function GraphNode({
  activeConversationId,
  conversation,
  conversations,
  detailLevel,
  isSelected,
  onCollapse,
  onDock,
  onExpand,
  onMakeMain,
  onOpen,
  onSelect,
  placement,
}: {
  activeConversationId: string;
  conversation: Conversation;
  conversations: Record<string, Conversation>;
  detailLevel: ConversationGraphDetail;
  isSelected: boolean;
  onCollapse: () => void;
  onDock: (conversationId: string) => void;
  onExpand: (conversationId: string) => void;
  onMakeMain: (conversationId: string) => void;
  onOpen: (conversationId: string) => void;
  onSelect: (conversationId: string) => void;
  placement: ConversationGraphNodePlacement;
}) {
  const childConversations = sortChildConversations(conversations, conversation);
  const isPreview = isSelected && detailLevel === "preview";
  const isReader = isSelected && detailLevel === "reader";
  const nodeStyle = {
    height: `${placement.height}px`,
    left: `${placement.x}px`,
    top: `${placement.y}px`,
    width: `${placement.width}px`,
  } as CSSProperties;
  const nodeType =
    conversation.id === activeConversationId
      ? "Current main"
      : conversation.parentId
          ? "Child chat"
          : "Main chat";

  return (
    <article
      className={[
        "conversation-graph-node",
        isSelected ? "is-selected" : "",
        isPreview ? "is-preview" : "",
        isReader ? "is-reader" : "",
        conversation.id === activeConversationId ? "is-current-main" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-conversation-id={conversation.id}
      style={nodeStyle}
    >
      <button
        aria-label={`Preview ${conversation.title}`}
        aria-pressed={isSelected}
        className="conversation-graph-node-select"
        onClick={() => onSelect(conversation.id)}
        type="button"
      >
        <span className="conversation-graph-node-head">
          <span className="conversation-graph-node-kicker">
            <span>{nodeType}</span>
            {conversation.id === activeConversationId ? (
              <span aria-hidden="true" className="conversation-graph-main-dot" />
            ) : null}
          </span>
          <strong>{conversation.title}</strong>
        </span>

        {!isPreview && !isReader ? (
          <span className="conversation-graph-node-meta">
            {conversation.branchAnchor
              ? excerpt(
                  conversation.branchAnchor.quote ||
                    conversation.branchAnchor.prompt,
                  52,
                )
              : `${conversation.childIds.length} child chat${
                  conversation.childIds.length === 1 ? "" : "s"
                }`}
          </span>
        ) : null}
      </button>

      {isPreview ? (
        <div className="conversation-graph-node-preview">
          <span className="conversation-graph-node-source-label">
            Branched from
          </span>
          <blockquote>{getSourceQuote(conversation)}</blockquote>
          <p>{getConversationPreview(conversation)}</p>
          <div className="conversation-graph-node-actions">
            <GraphNodeAction
              icon="expand"
              label={`Expand ${conversation.title}`}
              onClick={() => onExpand(conversation.id)}
              primary
            />
            <GraphNodeAction
              icon="dock"
              label={`Dock ${conversation.title} in split view`}
              onClick={() => onDock(conversation.id)}
            />
            {conversation.id !== activeConversationId ? (
              <GraphNodeAction
                icon="main"
                label={`Make ${conversation.title} the main chat`}
                onClick={() => onMakeMain(conversation.id)}
              />
            ) : null}
            <GraphNodeAction
              icon="open"
              label={`Open ${conversation.title} in chat view`}
              onClick={() => onOpen(conversation.id)}
            />
          </div>
        </div>
      ) : null}

      {isReader ? (
        <div className="conversation-graph-node-reader">
          <div className="conversation-graph-reader-actions">
            <GraphNodeAction
              icon="collapse"
              label={`Minimize ${conversation.title}`}
              onClick={onCollapse}
            />
            <GraphNodeAction
              icon="dock"
              label={`Dock ${conversation.title} in split view`}
              onClick={() => onDock(conversation.id)}
              primary
            />
            {conversation.id !== activeConversationId ? (
              <GraphNodeAction
                icon="main"
                label={`Make ${conversation.title} the main chat`}
                onClick={() => onMakeMain(conversation.id)}
              />
            ) : null}
            <GraphNodeAction
              icon="open"
              label={`Open ${conversation.title} in chat view`}
              onClick={() => onOpen(conversation.id)}
            />
          </div>
          <div
            className="conversation-graph-reader-messages"
            data-graph-reader-scroll="true"
          >
            {conversation.messages.length ? (
              conversation.messages.map((message) => (
                <div
                  className={`conversation-graph-reader-message is-${message.role}`}
                  key={message.id}
                >
                  <span>{message.role === "user" ? "You" : "Assistant"}</span>
                  <p>{message.content}</p>
                </div>
              ))
            ) : (
              <p className="conversation-graph-reader-empty">
                This chat does not have any messages yet.
              </p>
            )}
          </div>
        </div>
      ) : null}

      {(isPreview || isReader) && childConversations.length ? (
        <div className="conversation-graph-source-list">
          {childConversations.map((childConversation) => (
            <span
              className="conversation-graph-source-row"
              data-source-child-id={childConversation.id}
              key={childConversation.id}
            >
              {excerpt(
                childConversation.branchAnchor?.quote ||
                  childConversation.branchAnchor?.prompt ||
                  childConversation.title,
                54,
              )}
            </span>
          ))}
        </div>
      ) : null}
    </article>
  );
}

export default function ConversationGraphView({
  activeConversationId,
  conversations,
  threads,
  onActivateConversation,
  onOpenConversation,
  renderDockedConversation,
}: ConversationGraphViewProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const panInteractionRef = useRef<PanInteraction | null>(null);
  const viewportStateRef = useRef<GraphViewport>({ scale: 1, x: 0, y: 0 });
  const [selectedConversationId, setSelectedConversationId] = useState<
    string | null
  >(null);
  const [detailLevel, setDetailLevel] =
    useState<ConversationGraphDetail>("compact");
  const [dockedConversationId, setDockedConversationId] = useState<
    string | null
  >(null);
  const [viewport, setViewport] = useState<GraphViewport>({
    scale: 1,
    x: 0,
    y: 0,
  });
  const [viewportSize, setViewportSize] = useState({ height: 0, width: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const activeRootConversationId = getConversationRootId(
    conversations,
    activeConversationId,
  );
  const activeConversation = conversations[activeConversationId];
  const selectedConversation = selectedConversationId
    ? conversations[selectedConversationId] ?? null
    : null;
  const navigationConversation = selectedConversation ?? activeConversation;
  const selectedRootConversationId = selectedConversation
    ? getConversationRootId(conversations, selectedConversation.id)
    : null;
  const sceneConversationId =
    selectedConversation?.id ?? activeConversationId;
  const scene = useMemo(
    () =>
      buildConversationGraphScene({
        conversations,
        detailLevel: selectedConversation ? detailLevel : "compact",
        mode: "overview",
        selectedConversationId: sceneConversationId,
      }),
    [conversations, detailLevel, sceneConversationId, selectedConversation],
  );
  const selectedPath = navigationConversation
    ? getConversationPath(conversations, navigationConversation.id)
    : [];
  const activeRootThread = threads.find(
    (thread) => thread.id === activeRootConversationId,
  );
  const dockedConversation = dockedConversationId
    ? conversations[dockedConversationId] ?? null
    : null;
  const showMinimap = scene.nodes.length > 4;
  const stageStyle = {
    height: `${scene.height}px`,
    transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
    width: `${scene.width}px`,
  } as CSSProperties;

  const applyViewport = useCallback((nextViewport: GraphViewport) => {
    viewportStateRef.current = nextViewport;
    setViewport(nextViewport);
  }, []);

  const fitGraph = useCallback(() => {
    const viewportElement = viewportRef.current;

    if (!viewportElement) {
      return;
    }

    applyViewport(calculateFitViewport(scene, viewportElement));
  }, [applyViewport, scene]);

  const revealSelectedConversation = useCallback(() => {
    const viewportElement = viewportRef.current;

    if (!viewportElement || !selectedConversation) {
      fitGraph();
      return;
    }

    const selectedPlacement = scene.nodes.find(
      (placement) => placement.conversationId === selectedConversation.id,
    );

    if (!selectedPlacement) {
      fitGraph();
      return;
    }

    const fitScale = calculateFitViewport(scene, viewportElement).scale;
    const preferredScale = detailLevel === "reader" ? 0.9 : 0.82;
    const scale = clamp(
      Math.max(fitScale, Math.min(viewportStateRef.current.scale, preferredScale)),
      GRAPH_SCALE_MIN,
      preferredScale,
    );

    applyViewport({
      scale,
      x:
        viewportElement.clientWidth / 2 -
        (selectedPlacement.x + selectedPlacement.width / 2) * scale,
      y:
        viewportElement.clientHeight / 2 -
        (selectedPlacement.y + selectedPlacement.height / 2) * scale,
    });
  }, [applyViewport, detailLevel, fitGraph, scene, selectedConversation]);

  useEffect(() => {
    if (
      !selectedConversation ||
      (activeRootConversationId &&
        selectedRootConversationId !== activeRootConversationId)
    ) {
      setSelectedConversationId(null);
      setDetailLevel("compact");
    }
  }, [
    activeConversationId,
    activeRootConversationId,
    selectedConversation,
    selectedRootConversationId,
  ]);

  useEffect(() => {
    if (!dockedConversation) {
      return;
    }

    const dockedRootConversationId = getConversationRootId(
      conversations,
      dockedConversation.id,
    );

    if (
      activeRootConversationId &&
      dockedRootConversationId !== activeRootConversationId
    ) {
      setDockedConversationId(null);
    }
  }, [activeRootConversationId, conversations, dockedConversation]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(
      selectedConversation ? revealSelectedConversation : fitGraph,
    );

    return () => window.cancelAnimationFrame(frame);
  }, [fitGraph, revealSelectedConversation, selectedConversation]);

  useEffect(() => {
    const viewportElement = viewportRef.current;

    if (!viewportElement || typeof ResizeObserver === "undefined") {
      return;
    }

    setViewportSize({
      height: viewportElement.clientHeight,
      width: viewportElement.clientWidth,
    });
    const responsiveResizeObserver = new ResizeObserver(() => {
      setViewportSize({
        height: viewportElement.clientHeight,
        width: viewportElement.clientWidth,
      });
      if (selectedConversation) {
        revealSelectedConversation();
      } else {
        fitGraph();
      }
    });

    responsiveResizeObserver.observe(viewportElement);
    return () => responsiveResizeObserver.disconnect();
  }, [fitGraph, revealSelectedConversation, selectedConversation]);

  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }

      if (detailLevel === "reader") {
        setDetailLevel("preview");
        return;
      }

      if (selectedConversationId) {
        setSelectedConversationId(null);
        setDetailLevel("compact");
        return;
      }

      if (dockedConversationId) {
        setDockedConversationId(null);
      }
    }

    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [detailLevel, dockedConversationId, selectedConversationId]);

  function setScaleAtPoint(nextScale: number, localX: number, localY: number) {
    const current = viewportStateRef.current;
    const scale = clamp(nextScale, GRAPH_SCALE_MIN, GRAPH_SCALE_MAX);

    if (Math.abs(scale - current.scale) < 0.001) {
      return;
    }

    const worldX = (localX - current.x) / current.scale;
    const worldY = (localY - current.y) / current.scale;

    applyViewport(constrainViewport({
      scale,
      x: localX - worldX * scale,
      y: localY - worldY * scale,
    }));
  }

  function constrainViewport(nextViewport: GraphViewport) {
    const viewportElement = viewportRef.current;

    if (!viewportElement) {
      return nextViewport;
    }

    return {
      scale: nextViewport.scale,
      x: constrainPanAxis({
        contentSize: scene.width * nextViewport.scale,
        position: nextViewport.x,
        viewportSize: viewportElement.clientWidth,
      }),
      y: constrainPanAxis({
        contentSize: scene.height * nextViewport.scale,
        position: nextViewport.y,
        viewportSize: viewportElement.clientHeight,
      }),
    };
  }

  function zoomByStep(direction: "in" | "out") {
    const viewportElement = viewportRef.current;

    if (!viewportElement) {
      return;
    }

    setScaleAtPoint(
      viewportStateRef.current.scale *
        (direction === "in" ? GRAPH_ZOOM_STEP : 1 / GRAPH_ZOOM_STEP),
      viewportElement.clientWidth / 2,
      viewportElement.clientHeight / 2,
    );
  }

  const handleViewportWheel = useEffectEvent((event: WheelEvent) => {
    const viewportElement = viewportRef.current;

    if (!viewportElement) {
      return;
    }

    const deltaX = normalizeWheelDelta(
      event.deltaX,
      event.deltaMode,
      viewportElement.clientWidth,
    );
    const deltaY = normalizeWheelDelta(
      event.deltaY,
      event.deltaMode,
      viewportElement.clientHeight,
    );

    const readerScroller =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-graph-reader-scroll]")
        : null;
    const gestureAxis = getWheelGestureAxis(deltaX, deltaY);

    if (
      readerScroller &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      gestureAxis === "vertical"
    ) {
      const canScrollUp = deltaY < 0 && readerScroller.scrollTop > 0;
      const canScrollDown =
        deltaY > 0 &&
        readerScroller.scrollTop + readerScroller.clientHeight <
          readerScroller.scrollHeight - 1;

      if (canScrollUp || canScrollDown) {
        return;
      }
    }

    event.preventDefault();

    if (event.ctrlKey || event.metaKey) {
      const rect = viewportElement.getBoundingClientRect();
      const zoomFactor = Math.exp(-deltaY * GRAPH_ZOOM_SENSITIVITY);

      setScaleAtPoint(
        viewportStateRef.current.scale * zoomFactor,
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
      return;
    }

    const current = viewportStateRef.current;
    const isShiftScrolling = event.shiftKey && Math.abs(deltaX) < 0.5;

    applyViewport(
      constrainViewport({
        ...current,
        x: current.x - (isShiftScrolling ? deltaY : deltaX),
        y: current.y - (isShiftScrolling ? 0 : deltaY),
      }),
    );
  });

  useEffect(() => {
    const viewportElement = viewportRef.current;

    if (!viewportElement) {
      return;
    }

    function handleWheel(event: WheelEvent) {
      handleViewportWheel(event);
    }

    viewportElement.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewportElement.removeEventListener("wheel", handleWheel);
  }, [handleViewportWheel]);

  function startPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (
      event.button !== 0 ||
      (event.target as HTMLElement).closest(
        "button, .conversation-graph-node, [data-graph-reader-scroll]",
      )
    ) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const current = viewportStateRef.current;
    panInteractionRef.current = {
      originX: current.x,
      originY: current.y,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
    };
    setIsPanning(true);
  }

  function continuePan(event: ReactPointerEvent<HTMLDivElement>) {
    const interaction = panInteractionRef.current;

    if (!interaction || interaction.pointerId !== event.pointerId) {
      return;
    }

    applyViewport(
      constrainViewport({
        ...viewportStateRef.current,
        x: interaction.originX + event.clientX - interaction.startClientX,
        y: interaction.originY + event.clientY - interaction.startClientY,
      }),
    );
  }

  function endPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (panInteractionRef.current?.pointerId !== event.pointerId) {
      return;
    }

    panInteractionRef.current = null;
    setIsPanning(false);
  }

  function selectConversation(conversationId: string) {
    if (!conversations[conversationId]) {
      return;
    }

    if (selectedConversationId === conversationId) {
      return;
    }

    setSelectedConversationId(conversationId);
    setDetailLevel("preview");
  }

  function expandConversation(conversationId: string) {
    if (!conversations[conversationId]) {
      return;
    }

    setSelectedConversationId(conversationId);
    setDetailLevel("reader");
  }

  function dockConversation(conversationId: string) {
    if (!conversations[conversationId]) {
      return;
    }

    setDockedConversationId(conversationId);
    setSelectedConversationId(conversationId);
    setDetailLevel("preview");
  }

  if (!navigationConversation) {
    return null;
  }

  const minimapScale = Math.min(112 / scene.width, 66 / scene.height);
  const minimapViewport = {
    height: Math.min(scene.height, viewportSize.height / viewport.scale),
    width: Math.min(scene.width, viewportSize.width / viewport.scale),
    x: clamp(-viewport.x / viewport.scale, 0, scene.width),
    y: clamp(-viewport.y / viewport.scale, 0, scene.height),
  };

  minimapViewport.x = Math.min(
    minimapViewport.x,
    Math.max(0, scene.width - minimapViewport.width),
  );
  minimapViewport.y = Math.min(
    minimapViewport.y,
    Math.max(0, scene.height - minimapViewport.height),
  );

  return (
    <section className="conversation-graph" aria-label="Conversation graph">
      <header className="conversation-graph-header">
        <nav aria-label="Selected chat path" className="conversation-graph-breadcrumbs">
          {selectedPath.map((conversation, index) => (
            <span key={conversation.id}>
              {index > 0 ? <span aria-hidden="true">›</span> : null}
              <button
                aria-current={
                  conversation.id === navigationConversation.id
                    ? "page"
                    : undefined
                }
                onClick={() => selectConversation(conversation.id)}
                type="button"
              >
                {conversation.title}
              </button>
            </span>
          ))}
        </nav>
      </header>

      <div className="conversation-graph-toolbar">
        <div>
          <strong>Whole discussion</strong>
          <span>
            {activeRootThread?.title
              ? `${activeRootThread.title} · ${scene.nodes.length} chats`
              : `${scene.nodes.length} chats in this discussion`}
          </span>
        </div>
        <div className="conversation-graph-zoom" role="group" aria-label="Graph navigation">
          <button aria-label="Zoom out" onClick={() => zoomByStep("out")} type="button">
            −
          </button>
          <button onClick={fitGraph} type="button">Fit</button>
          <button aria-label="Zoom in" onClick={() => zoomByStep("in")} type="button">
            +
          </button>
        </div>
      </div>

      <div
        className={
          dockedConversation
            ? "conversation-graph-workspace has-docked-chat"
            : "conversation-graph-workspace"
        }
      >
        <div
          className={
            isPanning
              ? "conversation-graph-viewport is-panning"
              : "conversation-graph-viewport"
          }
          onPointerCancel={endPan}
          onPointerDown={startPan}
          onPointerMove={continuePan}
          onPointerUp={endPan}
          ref={viewportRef}
        >
          <div className="conversation-graph-stage" style={stageStyle}>
            <svg
              aria-label="Chat branch relationships"
              className="conversation-graph-edges"
              height={scene.height}
              role="img"
              viewBox={`0 0 ${scene.width} ${scene.height}`}
              width={scene.width}
            >
              <title>Chat branch relationships</title>
              {scene.edges.map((edge) => (
                <g key={`${edge.parentConversationId}-${edge.childConversationId}`}>
                  <path
                    className={
                      edge.isSelectedPath
                        ? "conversation-graph-edge is-selected-path"
                        : "conversation-graph-edge"
                    }
                    d={buildConnectorPath(edge)}
                    data-child-conversation-id={edge.childConversationId}
                    data-parent-conversation-id={edge.parentConversationId}
                  />
                  <circle
                    className={
                      edge.isSelectedPath
                        ? "conversation-graph-edge-port is-selected-path"
                        : "conversation-graph-edge-port"
                    }
                    cx={edge.startX}
                    cy={edge.startY}
                    r="4"
                  />
                </g>
              ))}
            </svg>

            {scene.nodes.map((placement) => {
              const conversation = conversations[placement.conversationId];

              return conversation ? (
                <GraphNode
                  activeConversationId={activeConversationId}
                  conversation={conversation}
                  conversations={conversations}
                  detailLevel={
                    conversation.id === selectedConversation?.id
                      ? detailLevel
                      : "compact"
                  }
                  isSelected={conversation.id === selectedConversation?.id}
                  key={conversation.id}
                  onCollapse={() => setDetailLevel("preview")}
                  onDock={dockConversation}
                  onExpand={expandConversation}
                  onMakeMain={onActivateConversation}
                  onOpen={onOpenConversation}
                  onSelect={selectConversation}
                  placement={placement}
                />
              ) : null;
            })}
          </div>

          <p className="conversation-graph-pan-hint">
            {detailLevel === "compact"
              ? "Click a chat for a preview · Drag or two-finger scroll to pan"
              : detailLevel === "preview"
                ? "Expand to read here · Dock to keep the graph interactive"
                : "Scroll inside the chat · Minimize or dock when ready"}
          </p>

          {showMinimap ? (
            <div className="conversation-graph-minimap" aria-label="Discussion minimap">
              <svg
                aria-hidden="true"
                height={Math.max(28, scene.height * minimapScale)}
                viewBox={`0 0 ${scene.width} ${scene.height}`}
                width={Math.max(48, scene.width * minimapScale)}
              >
                {scene.edges.map((edge) => (
                  <path
                    className="conversation-graph-minimap-edge"
                    d={buildConnectorPath(edge)}
                    key={`minimap-${edge.parentConversationId}-${edge.childConversationId}`}
                  />
                ))}
                {scene.nodes.map((placement) => (
                  <rect
                    className={
                      placement.conversationId === selectedConversation?.id
                        ? "conversation-graph-minimap-node is-selected"
                        : "conversation-graph-minimap-node"
                    }
                    height={placement.height}
                    key={`minimap-${placement.conversationId}`}
                    rx="8"
                    width={placement.width}
                    x={placement.x}
                    y={placement.y}
                  />
                ))}
                <rect
                  className="conversation-graph-minimap-viewport"
                  height={minimapViewport.height}
                  rx="10"
                  width={minimapViewport.width}
                  x={minimapViewport.x}
                  y={minimapViewport.y}
                />
              </svg>
            </div>
          ) : null}
        </div>

        {dockedConversation ? (
          <aside
            aria-label={`Docked chat: ${dockedConversation.title}`}
            className="conversation-graph-dock"
          >
            <header className="conversation-graph-dock-header">
              <div>
                <span>Docked chat</span>
                <strong>{dockedConversation.title}</strong>
              </div>
              <button
                aria-label={`Close ${dockedConversation.title} split view`}
                onClick={() => setDockedConversationId(null)}
                type="button"
              >
                ×
              </button>
            </header>
            <div className="conversation-graph-dock-body">
              {renderDockedConversation?.(dockedConversation.id) ?? (
                <div className="conversation-graph-dock-fallback">
                  {dockedConversation.messages.map((message) => (
                    <p key={message.id}>{message.content}</p>
                  ))}
                </div>
              )}
            </div>
          </aside>
        ) : null}
      </div>
    </section>
  );
}
