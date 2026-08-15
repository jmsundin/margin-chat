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
  buildConversationGraphNodeSpatialIndex,
  buildConversationForestGraphScene,
  getConversationGraphViewportBounds,
  graphPlacementIntersectsBounds,
  queryConversationGraphNodeSpatialIndex,
  type ConversationGraphDetail,
  type ConversationGraphGroupPlacement,
  type ConversationGraphNodePlacement,
  type ConversationGraphScene,
  type ConversationGraphSemanticLevel,
} from "../lib/conversationGraph";
import { ConversationGroupSelect } from "./ConversationGroupControls";
import {
  excerpt,
  getConversationPath,
  getConversationRootId,
} from "../lib/tree";
import {
  getStandaloneNote,
  isStandaloneNoteConversation,
} from "../lib/standaloneNotes";
import {
  buildElkConversationLayout,
  resolveGraphNodeReflow,
  resolveGraphSelectionReflow,
} from "../lib/graphAutoLayout";
import { getWheelGestureAxis } from "../lib/wheelGestures";
import type {
  Conversation,
  ConversationGroup,
  GraphNodeLayout,
} from "../types";

const GRAPH_SCALE_MIN = 0.38;
const GRAPH_SCALE_MAX = 2.2;
const GRAPH_ZOOM_STEP = 1.14;
const GRAPH_PINCH_ZOOM_SENSITIVITY = 0.008;
const GRAPH_PINCH_ZOOM_MAX_FACTOR = 1.28;
const GRAPH_GRID_SIZE = 22;
const GRAPH_MINIMAP_MAX_EDGES = 320;
const GRAPH_MINIMAP_MAX_NODES = 280;

function getGraphSemanticLevel(scale: number): ConversationGraphSemanticLevel {
  if (scale < 0.52) {
    return "territory";
  }

  if (scale < 0.78) {
    return "compact";
  }

  if (scale < 1.12) {
    return "summary";
  }

  return "detail";
}

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

type NodeMoveInteraction = {
  conversationId: string;
  conversationIds: string[];
  currentDeltaX: number;
  currentDeltaY: number;
  pointerId: number;
  startClientX: number;
  startClientY: number;
};

type MarqueeInteraction = {
  additive: boolean;
  initialConversationIds: Set<string>;
  pointerId: number;
  startX: number;
  startY: number;
};

type GraphSelectionBounds = {
  height: number;
  width: number;
  x: number;
  y: number;
};

export function getGraphNodesInSelectionBounds(
  placements: ConversationGraphNodePlacement[],
  bounds: GraphSelectionBounds,
) {
  const right = bounds.x + bounds.width;
  const bottom = bounds.y + bounds.height;

  return placements
    .filter(
      (placement) =>
        placement.x < right &&
        placement.x + placement.width > bounds.x &&
        placement.y < bottom &&
        placement.y + placement.height > bounds.y,
    )
    .map((placement) => placement.conversationId);
}

interface ConversationGraphViewProps {
  activeConversationId: string;
  conversations: Record<string, Conversation>;
  focusRequest?: {
    conversationId: string;
    requestId: number;
  } | null;
  graphLayouts?: Record<string, GraphNodeLayout>;
  groups: Record<string, ConversationGroup>;
  onActivateConversation: (conversationId: string) => void;
  onAssignGroup: (conversationId: string, groupId: string | null) => void;
  onCreateChildConversation: (conversationId: string) => string | null;
  onOpenConversation: (conversationId: string) => void;
  onToggleGroup: (groupId: string) => void;
  onUpdateGraphNodeLayouts?: (
    nextLayouts: Record<string, Partial<GraphNodeLayout>>,
  ) => void;
  renderDockedConversation?: (conversationId: string) => ReactNode;
  renderExpandedConversation?: (conversationId: string) => ReactNode;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

export function getGraphPinchZoomFactor(deltaY: number) {
  return clamp(
    Math.exp(-deltaY * GRAPH_PINCH_ZOOM_SENSITIVITY),
    1 / GRAPH_PINCH_ZOOM_MAX_FACTOR,
    GRAPH_PINCH_ZOOM_MAX_FACTOR,
  );
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

function sampleGraphItems<T>(items: T[], maximumCount: number) {
  if (items.length <= maximumCount) {
    return [...items];
  }

  const sample: T[] = [];
  const step = items.length / maximumCount;

  for (let index = 0; index < maximumCount; index += 1) {
    sample.push(items[Math.floor(index * step)]);
  }

  return sample;
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
  const standaloneNote = getStandaloneNote(conversation);

  if (standaloneNote) {
    return standaloneNote.content.trim()
      ? excerpt(standaloneNote.content, 124)
      : "This note is empty.";
  }

  const message =
    getLatestMessage(conversation, "assistant") ??
    getLatestMessage(conversation);

  return message
    ? excerpt(message.content, 124)
    : "This chat does not have any messages yet.";
}

function getSourceQuote(conversation: Conversation) {
  if (isStandaloneNoteConversation(conversation)) {
    return "Standalone workspace note";
  }

  if (!conversation.branchAnchor) {
    return conversation.parentId
      ? "Started directly from this chat"
      : "Root of this discussion";
  }

  return excerpt(
    conversation.branchAnchor.quote || conversation.branchAnchor.prompt,
    132,
  );
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
  name: "add" | "collapse" | "dock" | "expand" | "main" | "open";
}) {
  if (name === "add") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M12 5v14M5 12h14" />
      </svg>
    );
  }

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
  icon: "add" | "collapse" | "dock" | "expand" | "main" | "open";
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
  detailLevel,
  group,
  groups,
  isMoving,
  isMultiSelected,
  isSelected,
  isSelectionMode,
  multiSelectionSize,
  onAddChild,
  onAssignGroup,
  onCollapse,
  onDock,
  onExpand,
  onMakeMain,
  onMoveStart,
  onOpen,
  onSelect,
  placement,
  readerContent,
  semanticLevel,
}: {
  activeConversationId: string;
  conversation: Conversation;
  detailLevel: ConversationGraphDetail;
  group: ConversationGroup | null;
  groups: Record<string, ConversationGroup>;
  isMoving: boolean;
  isMultiSelected: boolean;
  isSelected: boolean;
  isSelectionMode: boolean;
  multiSelectionSize: number;
  onAddChild: (conversationId: string) => void;
  onAssignGroup: (conversationId: string, groupId: string | null) => void;
  onCollapse: () => void;
  onDock: (conversationId: string) => void;
  onExpand: (conversationId: string) => void;
  onMakeMain: (conversationId: string) => void;
  onMoveStart: (
    event: ReactPointerEvent<HTMLButtonElement>,
    conversationId: string,
  ) => void;
  onOpen: (conversationId: string) => void;
  onSelect: (conversationId: string) => void;
  placement: ConversationGraphNodePlacement;
  readerContent?: ReactNode;
  semanticLevel: ConversationGraphSemanticLevel;
}) {
  const isPreview = isSelected && detailLevel === "preview";
  const isReader = isSelected && detailLevel === "reader";
  const isNote = isStandaloneNoteConversation(conversation);
  const moveLabel =
    isMultiSelected && multiSelectionSize > 1
      ? `Move ${multiSelectionSize} selected chats`
      : `Move ${conversation.title}`;
  const nodeStyle = {
    height: `${placement.height}px`,
    left: `${placement.x}px`,
    top: `${placement.y}px`,
    width: `${placement.width}px`,
  } as CSSProperties;
  const nodeType =
    isNote
      ? "Note"
      : conversation.id === activeConversationId
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
        isMoving ? "is-moving" : "",
        isMultiSelected ? "is-multi-selected" : "",
        isNote ? "is-note" : "",
        `is-semantic-${semanticLevel}`,
        conversation.id === activeConversationId ? "is-current-main" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-conversation-id={conversation.id}
      data-multi-selected={isMultiSelected ? "true" : undefined}
      style={nodeStyle}
    >
      <button
        aria-label={moveLabel}
        className="conversation-graph-node-move-handle"
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => onMoveStart(event, conversation.id)}
        title={moveLabel}
        type="button"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="m12 3-3 3m3-3 3 3M12 3v18m0 0-3-3m3 3 3-3M3 12l3-3m-3 3 3 3M3 12h18m0 0-3-3m3 3-3 3" />
        </svg>
      </button>

      <button
        aria-label={`${isSelectionMode ? "Select" : "Preview"} ${conversation.title}`}
        aria-pressed={isSelectionMode ? isMultiSelected : isSelected}
        className="conversation-graph-node-select"
        onClick={() => onSelect(conversation.id)}
        type="button"
      >
        <span className="conversation-graph-node-head">
          <span className="conversation-graph-node-kicker">
            <span>{nodeType}</span>
            {group ? (
              <span className="conversation-graph-node-group">
                <span
                  aria-hidden="true"
                  style={{ backgroundColor: group.color }}
                />
                {group.name}
              </span>
            ) : null}
            {conversation.id === activeConversationId ? (
              <span aria-hidden="true" className="conversation-graph-main-dot" />
            ) : null}
          </span>
          <strong>{conversation.title}</strong>
        </span>

        {!isPreview && !isReader && semanticLevel === "compact" ? (
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

        {!isPreview &&
        !isReader &&
        (semanticLevel === "summary" || semanticLevel === "detail") ? (
          <span className="conversation-graph-node-semantic-preview">
            <span>{getSourceQuote(conversation)}</span>
            <span>{getConversationPreview(conversation)}</span>
          </span>
        ) : null}
      </button>

      <div
        aria-label={`Actions for ${conversation.title}`}
        className="conversation-graph-node-actions"
        role="toolbar"
      >
        {!isNote ? (
          <GraphNodeAction
            icon="add"
            label={`Add child chat to ${conversation.title}`}
            onClick={() => onAddChild(conversation.id)}
            primary
          />
        ) : null}
        <GraphNodeAction
          icon={isReader ? "collapse" : "expand"}
          label={
            isReader
              ? `Minimize ${conversation.title}`
              : `Expand ${conversation.title}`
          }
          onClick={
            isReader ? onCollapse : () => onExpand(conversation.id)
          }
        />
        <GraphNodeAction
          icon="dock"
          label={`Dock ${conversation.title} in split view`}
          onClick={() => onDock(conversation.id)}
        />
        {!isNote && conversation.id !== activeConversationId ? (
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
        <ConversationGroupSelect
          className="is-graph"
          conversationId={conversation.id}
          groups={groups}
          onAssign={onAssignGroup}
        />
      </div>

      {isPreview ? (
        <div className="conversation-graph-node-preview">
          <span className="conversation-graph-node-source-label">
            Branched from
          </span>
          <blockquote>{getSourceQuote(conversation)}</blockquote>
          <p>{getConversationPreview(conversation)}</p>
        </div>
      ) : null}

      {isReader ? (
        <div
          className="conversation-graph-node-reader"
          data-graph-reader-scroll="true"
        >
          {readerContent ?? (
            <p className="conversation-graph-reader-empty">
              This chat does not have any messages yet.
            </p>
          )}
        </div>
      ) : null}
    </article>
  );
}

function GraphGroupRegion({
  collapsed,
  group,
  onOpen,
  onToggle,
  placement,
}: {
  collapsed: boolean;
  group: ConversationGroup;
  onOpen: (placement: ConversationGraphGroupPlacement) => void;
  onToggle: (groupId: string) => void;
  placement: ConversationGraphGroupPlacement;
}) {
  if (collapsed) {
    const width = Math.min(300, Math.max(230, placement.width * 0.56));
    const height = 112;
    const style = {
      "--conversation-group-color": group.color,
      height: `${height}px`,
      left: `${placement.x + (placement.width - width) / 2}px`,
      top: `${placement.y + (placement.height - height) / 2}px`,
      width: `${width}px`,
    } as CSSProperties;

    return (
      <article className="conversation-graph-group-node" style={style}>
        <button
          onClick={() => (group.collapsed ? onToggle(group.id) : onOpen(placement))}
          type="button"
        >
          <span className="conversation-graph-group-node-kicker">
            Group · {placement.conversationIds.length} chats
          </span>
          <strong>{group.name}</strong>
          <span>{group.collapsed ? "Expand group" : "Zoom in to explore"}</span>
        </button>
      </article>
    );
  }

  return (
    <section
      aria-label={`Group ${group.name}`}
      className="conversation-graph-group-hull"
      style={
        {
          "--conversation-group-color": group.color,
          height: `${placement.height}px`,
          left: `${placement.x}px`,
          top: `${placement.y}px`,
          width: `${placement.width}px`,
        } as CSSProperties
      }
    >
      <button onClick={() => onToggle(group.id)} type="button">
        <span aria-hidden="true" />
        <strong>{group.name}</strong>
        <small>{placement.conversationIds.length}</small>
        <span aria-hidden="true">−</span>
      </button>
    </section>
  );
}

export default function ConversationGraphView({
  activeConversationId,
  conversations,
  focusRequest = null,
  graphLayouts = {},
  groups,
  onActivateConversation,
  onAssignGroup,
  onCreateChildConversation,
  onOpenConversation,
  onToggleGroup,
  onUpdateGraphNodeLayouts,
  renderDockedConversation,
  renderExpandedConversation,
}: ConversationGraphViewProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const panInteractionRef = useRef<PanInteraction | null>(null);
  const nodeMoveInteractionRef = useRef<NodeMoveInteraction | null>(null);
  const marqueeInteractionRef = useRef<MarqueeInteraction | null>(null);
  const viewportStateRef = useRef<GraphViewport>({ scale: 1, x: 0, y: 0 });
  const positionedInitialSceneRef = useRef(false);
  const revealedSelectionKeyRef = useRef<string | null>(null);
  const handledFocusRequestIdRef = useRef<number | null>(null);
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
  const [isMultiSelectActive, setIsMultiSelectActive] = useState(false);
  const [multiSelectedConversationIds, setMultiSelectedConversationIds] =
    useState<Set<string>>(() => new Set());
  const [marqueeBounds, setMarqueeBounds] =
    useState<GraphSelectionBounds | null>(null);
  const [isAutoArranging, setIsAutoArranging] = useState(false);
  const [autoArrangeError, setAutoArrangeError] = useState<string | null>(null);
  const [fitAfterArrange, setFitAfterArrange] = useState(false);
  const [movingNodePosition, setMovingNodePosition] = useState<{
    conversationId: string;
    conversationIds: string[];
    deltaX: number;
    deltaY: number;
  } | null>(null);
  const activeConversation = conversations[activeConversationId];
  const selectedConversation = selectedConversationId
    ? conversations[selectedConversationId] ?? null
    : null;
  const sceneConversationId =
    selectedConversation?.id ?? activeConversationId;
  const breadcrumbPath = getConversationPath(
    conversations,
    sceneConversationId,
  );
  const semanticLevel = getGraphSemanticLevel(viewport.scale);
  const scene = useMemo(
    () =>
      buildConversationForestGraphScene({
        conversations,
        detailLevel: selectedConversation ? detailLevel : "compact",
        groups,
        semanticLevel,
        selectedConversationId: sceneConversationId,
        treeLayouts: graphLayouts,
      }),
    [
      conversations,
      detailLevel,
      graphLayouts,
      groups,
      sceneConversationId,
      selectedConversation,
      semanticLevel,
    ],
  );
  const nodeSpatialIndex = useMemo(
    () => buildConversationGraphNodeSpatialIndex(scene.nodes),
    [scene.nodes],
  );
  const viewportBounds = useMemo(
    () =>
      getConversationGraphViewportBounds({
        viewport,
        viewportSize,
      }),
    [viewport, viewportSize],
  );
  const nearbyNodePlacements = useMemo(
    () =>
      queryConversationGraphNodeSpatialIndex(
        nodeSpatialIndex,
        viewportBounds,
      ),
    [nodeSpatialIndex, viewportBounds],
  );
  const collapsedGroupPlacements = useMemo(
    () =>
      scene.groups.filter(
        (placement) =>
          groups[placement.groupId]?.collapsed ||
          semanticLevel === "territory",
      ),
    [groups, scene.groups, semanticLevel],
  );
  const hiddenConversationIds = useMemo(
    () => {
      const conversationIds = new Set<string>();

      for (const placement of collapsedGroupPlacements) {
        for (const conversationId of placement.conversationIds) {
          conversationIds.add(conversationId);
        }
      }

      return conversationIds;
    },
    [collapsedGroupPlacements],
  );
  const baseRenderedNodePlacements = useMemo(
    () =>
      nearbyNodePlacements.filter(
        (placement) =>
          !hiddenConversationIds.has(placement.conversationId),
      ),
    [hiddenConversationIds, nearbyNodePlacements],
  );
  const reflowedSceneNodes = useMemo(
    () =>
      movingNodePosition
        ? movingNodePosition.conversationIds.length > 1
          ? resolveGraphSelectionReflow({
              conversationIds: movingNodePosition.conversationIds,
              deltaX: movingNodePosition.deltaX,
              deltaY: movingNodePosition.deltaY,
              placements: scene.nodes,
            })
          : (() => {
              const placement = scene.nodes.find(
                (candidate) =>
                  candidate.conversationId === movingNodePosition.conversationId,
              );

              return placement
                ? resolveGraphNodeReflow({
                    anchorConversationId: movingNodePosition.conversationId,
                    placements: scene.nodes,
                    x: placement.x + movingNodePosition.deltaX,
                    y: placement.y + movingNodePosition.deltaY,
                  })
                : scene.nodes;
            })()
        : scene.nodes,
    [movingNodePosition, scene.nodes],
  );
  const reflowedPlacementByConversationId = useMemo(() => {
    const placements = new Map<string, ConversationGraphNodePlacement>();

    for (const placement of reflowedSceneNodes) {
      placements.set(placement.conversationId, placement);
    }

    return placements;
  }, [reflowedSceneNodes]);
  const renderedNodePlacements = useMemo(() => {
    if (!movingNodePosition) {
      return baseRenderedNodePlacements;
    }

    const movingPlacement = reflowedPlacementByConversationId.get(
      movingNodePosition.conversationId,
    );

    if (!movingPlacement) {
      return baseRenderedNodePlacements;
    }

    const visibleConversationIds = new Set(
      baseRenderedNodePlacements.map(
        (placement) => placement.conversationId,
      ),
    );
    const placements = baseRenderedNodePlacements.map(
      (placement) =>
        reflowedPlacementByConversationId.get(placement.conversationId) ??
        placement,
    );

    if (!visibleConversationIds.has(movingNodePosition.conversationId)) {
      placements.push(movingPlacement);
    }

    return placements;
  }, [
    baseRenderedNodePlacements,
    movingNodePosition,
    reflowedPlacementByConversationId,
  ]);
  const renderedGroupPlacements = useMemo(
    () =>
      scene.groups.filter((placement) =>
        graphPlacementIntersectsBounds(placement, viewportBounds),
      ),
    [scene.groups, viewportBounds],
  );
  const edgeByChildConversationId = useMemo(() => {
    const index = new Map<string, (typeof scene.edges)[number]>();

    for (const edge of scene.edges) {
      index.set(edge.childConversationId, edge);
    }

    return index;
  }, [scene.edges]);
  const renderedEdges = useMemo(() => {
    const edges: typeof scene.edges = [];

    for (const placement of renderedNodePlacements) {
      const edge = edgeByChildConversationId.get(placement.conversationId);

      if (
        !edge ||
        hiddenConversationIds.has(edge.parentConversationId) ||
        hiddenConversationIds.has(edge.childConversationId)
      ) {
        continue;
      }

      const parentPlacement = reflowedPlacementByConversationId.get(
        edge.parentConversationId,
      );
      const childPlacement = reflowedPlacementByConversationId.get(
        edge.childConversationId,
      );

      if (!parentPlacement || !childPlacement) {
        continue;
      }

      edges.push({
        ...edge,
        endX: childPlacement.x,
        endY:
          childPlacement.y + Math.min(childPlacement.height / 2, 44),
        startX: parentPlacement.x + parentPlacement.width,
        startY: parentPlacement.y + parentPlacement.height / 2,
      });
    }

    return edges;
  }, [
    edgeByChildConversationId,
    hiddenConversationIds,
    reflowedPlacementByConversationId,
    renderedNodePlacements,
    scene.edges,
  ]);
  const conversationGroupByConversationId = useMemo(() => {
    const groupByConversationId = new Map<string, ConversationGroup>();

    for (const group of Object.values(groups)) {
      for (const conversationId of group.conversationIds) {
        groupByConversationId.set(conversationId, group);
      }
    }

    return groupByConversationId;
  }, [groups]);
  const minimapNodePlacements = useMemo(() => {
    const sampledPlacements = sampleGraphItems(
      scene.nodes,
      GRAPH_MINIMAP_MAX_NODES,
    );
    const sampledConversationIds = new Set(
      sampledPlacements.map((placement) => placement.conversationId),
    );

    for (const conversationId of [
      activeConversationId,
      selectedConversationId,
    ]) {
      if (!conversationId || sampledConversationIds.has(conversationId)) {
        continue;
      }

      const placement = scene.nodes.find(
        (candidate) => candidate.conversationId === conversationId,
      );

      if (placement) {
        sampledPlacements.push(placement);
        sampledConversationIds.add(conversationId);
      }
    }

    return sampledPlacements;
  }, [activeConversationId, scene.nodes, selectedConversationId]);
  const minimapEdges = useMemo(
    () => sampleGraphItems(scene.edges, GRAPH_MINIMAP_MAX_EDGES),
    [scene.edges],
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
  const viewportStyle = {
    backgroundPosition: `${viewport.x}px ${viewport.y}px`,
    backgroundSize: `${GRAPH_GRID_SIZE * viewport.scale}px ${GRAPH_GRID_SIZE * viewport.scale}px`,
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

  async function autoArrangeGraph() {
    if (isAutoArranging || !scene.nodes.length) {
      return;
    }

    setIsAutoArranging(true);
    setAutoArrangeError(null);

    try {
      const nextLayouts = await buildElkConversationLayout({
        conversations,
        placements: scene.nodes,
      });

      onUpdateGraphNodeLayouts?.(nextLayouts);
      setFitAfterArrange(true);
    } catch (error) {
      console.error("Unable to auto-arrange the conversation graph.", error);
      setAutoArrangeError("Auto-arrange could not complete.");
    } finally {
      setIsAutoArranging(false);
    }
  }

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
    if (selectedConversationId && !selectedConversation) {
      setSelectedConversationId(null);
      setDetailLevel("compact");
    }
  }, [selectedConversation, selectedConversationId]);

  useEffect(() => {
    if (
      !focusRequest ||
      handledFocusRequestIdRef.current === focusRequest.requestId ||
      !conversations[focusRequest.conversationId]
    ) {
      return;
    }

    handledFocusRequestIdRef.current = focusRequest.requestId;
    revealedSelectionKeyRef.current = null;
    setSelectedConversationId(focusRequest.conversationId);
    setDetailLevel("preview");
  }, [conversations, focusRequest]);

  useEffect(() => {
    if (dockedConversationId && !dockedConversation) {
      setDockedConversationId(null);
    }
  }, [dockedConversation, dockedConversationId]);

  useEffect(() => {
    if (positionedInitialSceneRef.current) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      positionedInitialSceneRef.current = true;
      revealedSelectionKeyRef.current = null;
      fitGraph();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [fitGraph]);

  useEffect(() => {
    if (!fitAfterArrange) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      fitGraph();
      setFitAfterArrange(false);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [fitAfterArrange, fitGraph]);

  useEffect(() => {
    const selectionKey = selectedConversation
      ? `${selectedConversation.id}:${detailLevel}`
      : null;

    if (!selectionKey) {
      revealedSelectionKeyRef.current = null;
      return;
    }

    if (revealedSelectionKeyRef.current === selectionKey) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      revealedSelectionKeyRef.current = selectionKey;
      revealSelectedConversation();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [
    detailLevel,
    revealSelectedConversation,
    selectedConversation,
  ]);

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
    });

    responsiveResizeObserver.observe(viewportElement);
    return () => responsiveResizeObserver.disconnect();
  }, []);

  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }

      if (isMultiSelectActive) {
        marqueeInteractionRef.current = null;
        setMarqueeBounds(null);
        setMultiSelectedConversationIds(new Set());
        setIsMultiSelectActive(false);
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
  }, [
    detailLevel,
    dockedConversationId,
    isMultiSelectActive,
    selectedConversationId,
  ]);

  function setScaleAtPoint(nextScale: number, localX: number, localY: number) {
    const current = viewportStateRef.current;
    const scale = clamp(nextScale, GRAPH_SCALE_MIN, GRAPH_SCALE_MAX);

    if (Math.abs(scale - current.scale) < 0.001) {
      return;
    }

    const worldX = (localX - current.x) / current.scale;
    const worldY = (localY - current.y) / current.scale;

    applyViewport({
      scale,
      x: localX - worldX * scale,
      y: localY - worldY * scale,
    });
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

    const readerRoot =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-graph-reader-scroll]")
        : null;
    const graphUiRoot =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-graph-ui]")
        : null;
    const readerScroller = readerRoot
      ? event.target instanceof Element
        ? event.target.closest<HTMLElement>(".panel-body") ?? readerRoot
        : readerRoot
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

    if (graphUiRoot && !event.ctrlKey && !event.metaKey) {
      return;
    }

    event.preventDefault();

    if (event.ctrlKey || event.metaKey) {
      const rect = viewportElement.getBoundingClientRect();
      const zoomFactor = getGraphPinchZoomFactor(deltaY);

      setScaleAtPoint(
        viewportStateRef.current.scale * zoomFactor,
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
      return;
    }

    const current = viewportStateRef.current;
    const isShiftScrolling = event.shiftKey && Math.abs(deltaX) < 0.5;

    applyViewport({
      ...current,
      x: current.x - (isShiftScrolling ? deltaY : deltaX),
      y: current.y - (isShiftScrolling ? 0 : deltaY),
    });
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
      nodeMoveInteractionRef.current ||
      event.button !== 0 ||
      (event.target as HTMLElement).closest(
        "button, .conversation-graph-node, [data-graph-reader-scroll], [data-graph-ui]",
      )
    ) {
      return;
    }

    if (isMultiSelectActive) {
      startMarqueeSelection(event);
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

  function startNodeMove(
    event: ReactPointerEvent<HTMLButtonElement>,
    conversationId: string,
  ) {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const conversationIds = multiSelectedConversationIds.has(conversationId)
      ? [...multiSelectedConversationIds].filter((id) => conversations[id])
      : [conversationId];
    nodeMoveInteractionRef.current = {
      conversationId,
      conversationIds,
      currentDeltaX: 0,
      currentDeltaY: 0,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
    };
    setMovingNodePosition({
      conversationId,
      conversationIds,
      deltaX: 0,
      deltaY: 0,
    });
  }

  function continueNodeMove(event: ReactPointerEvent<HTMLDivElement>) {
    const interaction = nodeMoveInteractionRef.current;

    if (!interaction || interaction.pointerId !== event.pointerId) {
      return false;
    }

    event.preventDefault();
    const scale = Math.max(viewportStateRef.current.scale, 0.001);
    interaction.currentDeltaX =
      (event.clientX - interaction.startClientX) / scale;
    interaction.currentDeltaY =
      (event.clientY - interaction.startClientY) / scale;
    setMovingNodePosition({
      conversationId: interaction.conversationId,
      conversationIds: interaction.conversationIds,
      deltaX: interaction.currentDeltaX,
      deltaY: interaction.currentDeltaY,
    });
    return true;
  }

  function endNodeMove(
    event: ReactPointerEvent<HTMLDivElement>,
    commit: boolean,
  ) {
    const interaction = nodeMoveInteractionRef.current;

    if (!interaction || interaction.pointerId !== event.pointerId) {
      return false;
    }

    nodeMoveInteractionRef.current = null;
    setMovingNodePosition(null);

    if (commit) {
      const anchorPlacement = scene.nodes.find(
        (placement) =>
          placement.conversationId === interaction.conversationId,
      );
      const reflowedNodes =
        interaction.conversationIds.length > 1
          ? resolveGraphSelectionReflow({
              conversationIds: interaction.conversationIds,
              deltaX: interaction.currentDeltaX,
              deltaY: interaction.currentDeltaY,
              placements: scene.nodes,
            })
          : anchorPlacement
            ? resolveGraphNodeReflow({
                anchorConversationId: interaction.conversationId,
                placements: scene.nodes,
                x: anchorPlacement.x + interaction.currentDeltaX,
                y: anchorPlacement.y + interaction.currentDeltaY,
              })
            : scene.nodes;
      const currentNodeById = new Map(
        scene.nodes.map((placement) => [placement.conversationId, placement]),
      );
      const nextLayouts = Object.fromEntries(
        reflowedNodes
          .filter((placement) => {
            const currentPlacement = currentNodeById.get(
              placement.conversationId,
            );

            return (
              !currentPlacement ||
              Math.abs(currentPlacement.x - placement.x) >= 0.5 ||
              Math.abs(currentPlacement.y - placement.y) >= 0.5
            );
          })
          .map((placement) => [
            placement.conversationId,
            {
              positioned: true,
              x: Math.round(placement.x),
              y: Math.round(placement.y),
            },
          ]),
      );

      onUpdateGraphNodeLayouts?.(nextLayouts);
    }

    return true;
  }

  function handleViewportPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!continueNodeMove(event) && !continueMarqueeSelection(event)) {
      continuePan(event);
    }
  }

  function handleViewportPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (!endNodeMove(event, true) && !endMarqueeSelection(event)) {
      endPan(event);
    }
  }

  function handleViewportPointerCancel(
    event: ReactPointerEvent<HTMLDivElement>,
  ) {
    if (!endNodeMove(event, false) && !endMarqueeSelection(event, true)) {
      endPan(event);
    }
  }

  function clientPointToWorld(clientX: number, clientY: number) {
    const viewportElement = viewportRef.current;
    const current = viewportStateRef.current;

    if (!viewportElement) {
      return { x: 0, y: 0 };
    }

    const rect = viewportElement.getBoundingClientRect();
    return {
      x: (clientX - rect.left - current.x) / current.scale,
      y: (clientY - rect.top - current.y) / current.scale,
    };
  }

  function startMarqueeSelection(event: ReactPointerEvent<HTMLDivElement>) {
    const point = clientPointToWorld(event.clientX, event.clientY);

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    marqueeInteractionRef.current = {
      additive: event.shiftKey,
      initialConversationIds: new Set(multiSelectedConversationIds),
      pointerId: event.pointerId,
      startX: point.x,
      startY: point.y,
    };
    setMarqueeBounds({ height: 0, width: 0, x: point.x, y: point.y });
    if (!event.shiftKey) {
      setMultiSelectedConversationIds(new Set());
    }
  }

  function continueMarqueeSelection(
    event: ReactPointerEvent<HTMLDivElement>,
  ) {
    const interaction = marqueeInteractionRef.current;

    if (!interaction || interaction.pointerId !== event.pointerId) {
      return false;
    }

    event.preventDefault();
    const point = clientPointToWorld(event.clientX, event.clientY);
    const bounds = {
      height: Math.abs(point.y - interaction.startY),
      width: Math.abs(point.x - interaction.startX),
      x: Math.min(point.x, interaction.startX),
      y: Math.min(point.y, interaction.startY),
    };
    const selectedIds = new Set(
      interaction.additive ? interaction.initialConversationIds : [],
    );

    for (const conversationId of getGraphNodesInSelectionBounds(
      scene.nodes,
      bounds,
    )) {
      if (!hiddenConversationIds.has(conversationId)) {
        selectedIds.add(conversationId);
      }
    }

    setMarqueeBounds(bounds);
    setMultiSelectedConversationIds(selectedIds);
    return true;
  }

  function endMarqueeSelection(
    event: ReactPointerEvent<HTMLDivElement>,
    cancelled = false,
  ) {
    const interaction = marqueeInteractionRef.current;

    if (!interaction || interaction.pointerId !== event.pointerId) {
      return false;
    }

    marqueeInteractionRef.current = null;
    setMarqueeBounds(null);
    if (cancelled) {
      setMultiSelectedConversationIds(interaction.initialConversationIds);
    }
    return true;
  }

  function toggleMultiSelect() {
    setIsMultiSelectActive((active) => {
      if (active) {
        setMultiSelectedConversationIds(new Set());
        setMarqueeBounds(null);
      }

      return !active;
    });
  }

  function continuePan(event: ReactPointerEvent<HTMLDivElement>) {
    const interaction = panInteractionRef.current;

    if (!interaction || interaction.pointerId !== event.pointerId) {
      return;
    }

    applyViewport({
      ...viewportStateRef.current,
      x: interaction.originX + event.clientX - interaction.startClientX,
      y: interaction.originY + event.clientY - interaction.startClientY,
    });
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

    if (isMultiSelectActive) {
      setMultiSelectedConversationIds((currentIds) => {
        const nextIds = new Set(currentIds);

        if (nextIds.has(conversationId)) {
          nextIds.delete(conversationId);
        } else {
          nextIds.add(conversationId);
        }

        return nextIds;
      });
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

  function addChildConversation(parentConversationId: string) {
    const childConversationId = onCreateChildConversation(
      parentConversationId,
    );

    if (!childConversationId) {
      return;
    }

    setSelectedConversationId(childConversationId);
    setDetailLevel("preview");
  }

  function openGroup(placement: ConversationGraphGroupPlacement) {
    const viewportElement = viewportRef.current;

    if (!viewportElement) {
      return;
    }

    const scale = Math.max(viewportStateRef.current.scale, 0.68);

    applyViewport({
      scale,
      x:
        viewportElement.clientWidth / 2 -
        (placement.x + placement.width / 2) * scale,
      y:
        viewportElement.clientHeight / 2 -
        (placement.y + placement.height / 2) * scale,
    });
  }

  if (!activeConversation) {
    return null;
  }

  const minimapScale = Math.min(112 / scene.width, 66 / scene.height);
  const worldViewport = {
    height: viewportSize.height / viewport.scale,
    width: viewportSize.width / viewport.scale,
    x: -viewport.x / viewport.scale,
    y: -viewport.y / viewport.scale,
  };
  const minimapViewport = {
    height:
      Math.min(scene.height, worldViewport.y + worldViewport.height) -
      Math.max(0, worldViewport.y),
    width:
      Math.min(scene.width, worldViewport.x + worldViewport.width) -
      Math.max(0, worldViewport.x),
    x: Math.max(0, worldViewport.x),
    y: Math.max(0, worldViewport.y),
  };
  const showMinimapViewport =
    minimapViewport.height > 0 && minimapViewport.width > 0;

  return (
    <section className="conversation-graph" aria-label="Conversation graph">
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
          onPointerCancel={handleViewportPointerCancel}
          onPointerDown={startPan}
          onPointerMove={handleViewportPointerMove}
          onPointerUp={handleViewportPointerUp}
          ref={viewportRef}
          style={viewportStyle}
        >
          <nav
            aria-label="Graph node hierarchy"
            className="conversation-graph-node-breadcrumbs"
            data-graph-ui="true"
          >
            {breadcrumbPath.map((conversation, index) => {
              const isCurrent = index === breadcrumbPath.length - 1;

              return (
                <span key={conversation.id}>
                  {index > 0 ? (
                    <span
                      aria-hidden="true"
                      className="conversation-graph-breadcrumb-separator"
                    >
                      ›
                    </span>
                  ) : null}
                  <button
                    aria-current={isCurrent ? "page" : undefined}
                    data-breadcrumb-conversation-id={conversation.id}
                    onClick={() => selectConversation(conversation.id)}
                    title={conversation.title}
                    type="button"
                  >
                    {conversation.title}
                  </button>
                </span>
              );
            })}
          </nav>

          <div
            className="conversation-graph-stage"
            data-rendered-edge-count={renderedEdges.length}
            data-rendered-node-count={renderedNodePlacements.length}
            data-scene-node-count={scene.nodes.length}
            style={stageStyle}
          >
            {marqueeBounds ? (
              <div
                aria-hidden="true"
                className="conversation-graph-selection-marquee"
                style={{
                  height: `${marqueeBounds.height}px`,
                  left: `${marqueeBounds.x}px`,
                  top: `${marqueeBounds.y}px`,
                  width: `${marqueeBounds.width}px`,
                }}
              />
            ) : null}

            {renderedGroupPlacements.map((placement) => {
              const group = groups[placement.groupId];

              return group ? (
                <GraphGroupRegion
                  collapsed={
                    group.collapsed || semanticLevel === "territory"
                  }
                  group={group}
                  key={group.id}
                  onOpen={openGroup}
                  onToggle={onToggleGroup}
                  placement={placement}
                />
              ) : null;
            })}

            <svg
              aria-label="Chat branch relationships"
              className="conversation-graph-edges"
              height={scene.height}
              role="img"
              viewBox={`0 0 ${scene.width} ${scene.height}`}
              width={scene.width}
            >
              <title>Chat branch relationships</title>
              {renderedEdges.map((edge) => (
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

            {renderedNodePlacements.map((placement) => {
              const conversation = conversations[placement.conversationId];
              const group =
                conversationGroupByConversationId.get(
                  placement.conversationId,
                ) ?? null;

              return conversation ? (
                <GraphNode
                  activeConversationId={activeConversationId}
                  conversation={conversation}
                  detailLevel={
                    conversation.id === selectedConversation?.id
                      ? detailLevel
                      : "compact"
                  }
                  group={group}
                  groups={groups}
                  isMoving={
                    movingNodePosition?.conversationIds.includes(conversation.id) ??
                    false
                  }
                  isMultiSelected={multiSelectedConversationIds.has(
                    conversation.id,
                  )}
                  isSelected={conversation.id === selectedConversation?.id}
                  isSelectionMode={isMultiSelectActive}
                  key={conversation.id}
                  multiSelectionSize={multiSelectedConversationIds.size}
                  onAddChild={addChildConversation}
                  onAssignGroup={onAssignGroup}
                  onCollapse={() => setDetailLevel("preview")}
                  onDock={dockConversation}
                  onExpand={expandConversation}
                  onMakeMain={onActivateConversation}
                  onMoveStart={startNodeMove}
                  onOpen={onOpenConversation}
                  onSelect={selectConversation}
                  placement={placement}
                  readerContent={
                    conversation.id === selectedConversation?.id &&
                    detailLevel === "reader"
                      ? renderExpandedConversation?.(conversation.id)
                      : undefined
                  }
                  semanticLevel={semanticLevel}
                />
              ) : null;
            })}
          </div>

          <p className="conversation-graph-pan-hint">
            {isMultiSelectActive
              ? multiSelectedConversationIds.size
                ? "Drag a selected chat's move handle to move the group · Shift-drag to add more"
                : "Drag across chats to select them · Shift-drag adds to the selection"
              : detailLevel === "compact"
              ? "Click a chat for a preview · Drag or two-finger scroll to pan"
              : detailLevel === "preview"
                ? "Expand to read here · Dock to keep the graph interactive"
                : "Scroll inside the chat · Minimize or dock when ready"}
          </p>

          <div
            className="conversation-graph-zoom is-floating"
            role="group"
            aria-label="Graph navigation"
          >
            <button
              aria-label={
                isMultiSelectActive
                  ? "Exit multi-select and clear selection"
                  : "Select multiple chats"
              }
              aria-pressed={isMultiSelectActive}
              className="conversation-graph-multi-select-toggle"
              data-graph-ui="true"
              onClick={toggleMultiSelect}
              title={
                isMultiSelectActive
                  ? "Drag across chats to select them; use a selected chat's move handle to move the group"
                  : "Select and move multiple chats"
              }
              type="button"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4" />
                <path d="m9 9 7 3-3 1-1 3z" />
              </svg>
              <span>
                {multiSelectedConversationIds.size
                  ? `${multiSelectedConversationIds.size} selected`
                  : "Select"}
              </span>
            </button>
            <button
              aria-label="Auto-arrange graph with ELK"
              className="conversation-graph-auto-arrange"
              disabled={isAutoArranging || !scene.nodes.length}
              onClick={autoArrangeGraph}
              title="Auto-arrange graph with ELK"
              type="button"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <circle cx="6" cy="7" r="2.2" />
                <circle cx="18" cy="6" r="2.2" />
                <circle cx="12" cy="18" r="2.2" />
                <path d="m8 7 7.8-.8M7.2 8.8l3.7 6.9m5.7-7.8-3.5 7.8" />
              </svg>
              <span>{isAutoArranging ? "Arranging…" : "Auto-arrange"}</span>
            </button>
            <button
              aria-label="Zoom out"
              onClick={() => zoomByStep("out")}
              type="button"
            >
              −
            </button>
            <button onClick={fitGraph} type="button">Fit</button>
            <button
              aria-label="Zoom in"
              onClick={() => zoomByStep("in")}
              type="button"
            >
              +
            </button>
          </div>

          {autoArrangeError ? (
            <p className="conversation-graph-layout-error" role="status">
              {autoArrangeError}
            </p>
          ) : null}

          {showMinimap ? (
            <div className="conversation-graph-minimap" aria-label="Discussion minimap">
              <svg
                aria-hidden="true"
                height={Math.max(28, scene.height * minimapScale)}
                viewBox={`0 0 ${scene.width} ${scene.height}`}
                width={Math.max(48, scene.width * minimapScale)}
              >
                {minimapEdges.map((edge) => (
                  <path
                    className="conversation-graph-minimap-edge"
                    d={buildConnectorPath(edge)}
                    key={`minimap-${edge.parentConversationId}-${edge.childConversationId}`}
                  />
                ))}
                {minimapNodePlacements.map((placement) => (
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
                {showMinimapViewport ? (
                  <rect
                    className="conversation-graph-minimap-viewport"
                    height={minimapViewport.height}
                    rx="10"
                    width={minimapViewport.width}
                    x={minimapViewport.x}
                    y={minimapViewport.y}
                  />
                ) : null}
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
