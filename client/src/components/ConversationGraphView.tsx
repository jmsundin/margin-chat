import {
  useCallback,
  useEffect,
  useEffectEvent,
  useDeferredValue,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  buildConversationForestGraphScene,
  getConversationGraphNodeDimensions,
  replaceConversationGraphNodes,
  getConversationGraphViewportBounds,
  graphPlacementIntersectsBounds,
  queryConversationGraphNodeSpatialIndex,
  type ConversationGraphDetail,
  type ConversationGraphGroupPlacement,
  type ConversationGraphNodePlacement,
  type ConversationGraphScene,
  type ConversationGraphSemanticLevel,
} from "../lib/conversationGraph";
import GraphExplorationPanel, { type GraphExplorationOverviewItem } from "./GraphExplorationPanel";
import GraphOverviewCanvas from "./GraphOverviewCanvas";
import {
  aggregateGraphEdges, getGraphScopeConversationIds, getGraphWorldBounds,
  getGraphConceptConversationIds, readGraphConcepts, writeGraphConcepts,
  searchGraphSources, resolveGraphEvidence,
  type GraphConcept, type GraphEvidenceRef, type GraphScope, type GraphAggregatedEdge,
} from "../lib/graphExploration";
import { useGraphExplorationNavigation } from "../lib/useGraphExplorationNavigation";
import { resolveGraphFocusLayout } from "../lib/graphFocusLayout";
import "./GraphMapExploration.css";
import "./GraphFocusLayout.css";
import { ConversationGroupSelect } from "./ConversationGroupControls";
import {
  excerpt,
  getConversationPath,
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
import { buildGraphDragPreviewIndex, resolveGraphDragPreview } from "../lib/graphDragPreview";
import {
  getGraphNodesInSelectionBounds,
  type GraphNodeMove,
  type GraphSelectionBounds,
  type GraphViewport,
} from "../lib/graphInteractions";
import { useGraphInteractions } from "../lib/useGraphInteractions";
import { buildThreadSummaries } from "../lib/conversationSearch";
import { buildCategoryOrganizedGraphLayouts } from "../lib/graphCategories";
import { getConversationRootId } from "../lib/tree";
export { getGraphNodesInSelectionBounds } from "../lib/graphInteractions";
import type {
  Conversation,
  ConversationGroup,
  GraphNodeLayout,
  ThreadSummary,
} from "../types";

const GRAPH_SCALE_MIN = 0.02;
const GRAPH_SCALE_MAX = 2.2;
const GRAPH_ZOOM_STEP = 1.14;
const GRAPH_PINCH_ZOOM_SENSITIVITY = 0.008;
const GRAPH_PINCH_ZOOM_MAX_FACTOR = 1.28;
const GRAPH_GRID_SIZE = 22;
const GRAPH_MINIMAP_MAX_EDGES = 320;
const GRAPH_MINIMAP_MAX_NODES = 280;
const EMPTY_RELATED_ITEMS: Array<{ id: string; score: number }> = [];

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

interface ConversationGraphViewProps {
  workspaceKey?: string;
  onFocusRequestHandled?: (requestId: number) => void;
  relatedItems?: Array<{ id: string; score: number }>;
  relatedStatus?: string;
  activeConversationId: string;
  conversations: Record<string, Conversation>;
  threads?: ThreadSummary[];
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
  renderDockedConversation?: (conversationId: string, source?: GraphEvidenceRef) => ReactNode;
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

export function calculateFitViewport(
  scene: ConversationGraphScene,
  viewportElement: Pick<HTMLDivElement, "clientWidth" | "clientHeight">,
): GraphViewport {
  const availableWidth = Math.max(240, viewportElement.clientWidth - 56);
  const availableHeight = Math.max(220, viewportElement.clientHeight - 48);
  // Saved and topic-organized positions may be negative. Stage dimensions only
  // describe its positive extent, so fit the authored geometry itself.
  const placements = [...scene.nodes, ...scene.groups];
  const bounds = placements.length ? placements.reduce((current, item) => ({
    left: Math.min(current.left, item.x),
    top: Math.min(current.top, item.y),
    right: Math.max(current.right, item.x + item.width),
    bottom: Math.max(current.bottom, item.y + item.height),
  }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity }) : {
    left: 0, top: 0, right: scene.width, bottom: scene.height,
  };
  const width = Math.max(1, bounds.right - bounds.left);
  const height = Math.max(1, bounds.bottom - bounds.top);
  const scale = clamp(
    Math.min(availableWidth / width, availableHeight / height),
    Number.EPSILON,
    0.96,
  );

  return {
    scale,
    x: viewportElement.clientWidth / 2 - (bounds.left + width / 2) * scale,
    y: viewportElement.clientHeight / 2 - (bounds.top + height / 2) * scale,
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
  categoryLabel,
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
  onFocus,
  onSource,
  onMoveStart,
  onOpen,
  onSelect,
  placement,
  readerContent,
  semanticLevel,
}: {
  activeConversationId: string;
  categoryLabel?: string;
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
  onFocus: (conversationId: string) => void;
  onSource: (conversationId: string) => void;
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
            {categoryLabel ? <span className="conversation-graph-node-category">{categoryLabel}</span> : null}
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
          <span className="conversation-graph-node-source-label">{conversation.parentId ? "Branched from" : isNote ? "Workspace note" : "Discussion"}</span>
          <blockquote>{getSourceQuote(conversation)}</blockquote>
          <p>{getConversationPreview(conversation)}</p>
          <div className="graph-map-preview-actions">
            <button type="button" onClick={() => onFocus(conversation.id)}>Focus here</button>
            {conversation.parentId ? <button type="button" onClick={() => onSource(conversation.id)}>Show source</button> : null}
          </div>
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
          onClick={() => onOpen(placement)}
          type="button"
        >
          <span className="conversation-graph-group-node-kicker">
            Group · {placement.conversationIds.length} chats
          </span>
          <strong>{group.name}</strong>
          <span>Explore group</span>
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
  workspaceKey,
  onFocusRequestHandled,
  relatedItems = EMPTY_RELATED_ITEMS,
  relatedStatus = "off",
  activeConversationId,
  conversations,
  threads,
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
  const navigation = useGraphExplorationNavigation(workspaceKey);
  const { scope, selectedConversationId, detailLevel, dockedConversationId, viewport, source, query, expandedGroups, showRelated } = navigation.state;
  const setSelectedConversationId = (id: string | null) => navigation.update({ selectedConversationId: id });
  const setDetailLevel = (value: ConversationGraphDetail) => navigation.update({ detailLevel: value });
  const setDockedConversationId = (id: string | null) => navigation.update({ dockedConversationId: id, source: null });
  const setViewport = navigation.update;
  const [concepts, setConcepts] = useState<GraphConcept[]>(() => workspaceKey ? readGraphConcepts(workspaceKey) : []);
  const [conceptSaveError, setConceptSaveError] = useState(false);
  const [inspectedEdge, setInspectedEdge] = useState<GraphAggregatedEdge | null>(null);
  const [inspectedOverviewSources, setInspectedOverviewSources] = useState<string[]>([]);
  const [explorerOpen, setExplorerOpen] = useState(true);
  const deferredQuery = useDeferredValue(query);
  const dockBodyRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const viewportStateRef = useRef<GraphViewport>(viewport);
  viewportStateRef.current = viewport;
  const positionedInitialSceneRef = useRef(navigation.restored);
  const revealedSelectionKeyRef = useRef<string | null>(navigation.restored && selectedConversationId ? `${selectedConversationId}:${detailLevel}` : null);
  const handledFocusRequestIdRef = useRef<number | null>(null);
  const restoringHistoryRef = useRef(false);
  const [restoreRevision, setRestoreRevision] = useState(0);
  const [viewportSize, setViewportSize] = useState({ height: 0, width: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const backgroundPressRef = useRef<{ pointerId: number; x: number; y: number; moved: boolean } | null>(null);
  const [isMultiSelectActive, setIsMultiSelectActive] = useState(false);
  const [multiSelectedConversationIds, setMultiSelectedConversationIds] =
    useState<Set<string>>(() => new Set());
  const [marqueeBounds, setMarqueeBounds] =
    useState<GraphSelectionBounds | null>(null);
  const [isAutoArranging, setIsAutoArranging] = useState(false);
  const [autoArrangeError, setAutoArrangeError] = useState<string | null>(null);
  const [fitAfterArrange, setFitAfterArrange] = useState(false);
  const [movingNodePosition, setMovingNodePosition] = useState<GraphNodeMove | null>(null);
  const movingConversationIds = useMemo(
    () => new Set(movingNodePosition?.conversationIds),
    [movingNodePosition?.conversationIds],
  );
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
  const categorizedThreads = useMemo(() => threads ?? buildThreadSummaries(conversations), [threads, conversations]);
  const categoryLabels = useMemo(() => new Map(categorizedThreads.map((thread) => [thread.id, thread.categoryLabel])), [categorizedThreads]);
  const completeScene = useMemo(
    () =>
      buildConversationForestGraphScene({
        conversations,
        detailLevel: "compact",
        groups,
        semanticLevel,
        selectedConversationId: sceneConversationId,
        treeLayouts: graphLayouts,
      }),
    [
      conversations,
      graphLayouts,
      groups,
      sceneConversationId,
      semanticLevel,
    ],
  );
  const scopedIds = useMemo(() => {
    const ids = getGraphScopeConversationIds({ scope, conversations, groups, threads: categorizedThreads, concepts });
    if (showRelated && scope.kind === "focus" && scope.conversationId === activeConversationId) {
      for (const item of relatedItems) if (conversations[item.id]) ids.add(item.id);
    }
    return ids;
  }, [scope, conversations, groups, categorizedThreads, concepts, showRelated, relatedItems, activeConversationId]);
  const unfocusedScene = useMemo(() => {
    if (scope.kind === "all") return completeScene;
    const nodes = completeScene.nodes.filter((node) => scopedIds.has(node.conversationId));
    const edges = completeScene.edges.filter((edge) => scopedIds.has(edge.parentConversationId) && scopedIds.has(edge.childConversationId));
    const groupPlacements = completeScene.groups.flatMap((group) => {
      const members = nodes.filter((node) => group.conversationIds.includes(node.conversationId));
      if (!members.length) return [];
      const bounds = getGraphWorldBounds(members, 24);
      return [{ ...group, conversationIds: members.map((node) => node.conversationId), x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height }];
    });
    return { ...completeScene, nodes, edges, groups: groupPlacements };
  }, [completeScene, scope.kind, scopedIds]);
  const scene = useMemo(() => {
    if (!selectedConversation || detailLevel === "compact") return unfocusedScene;
    const placements = unfocusedScene.nodes.map((node) => node.conversationId === selectedConversation.id ? {
      ...node,
      ...getConversationGraphNodeDimensions({ conversation: selectedConversation, detailLevel, isSelected: true, mode: "overview", semanticLevel }),
    } : node);
    return replaceConversationGraphNodes(unfocusedScene, resolveGraphFocusLayout({
      placements, selectedConversationId: selectedConversation.id,
    }));
  }, [unfocusedScene, selectedConversation, detailLevel, semanticLevel]);
  const worldBounds = useMemo(() => getGraphWorldBounds([...scene.nodes, ...scene.groups], 24), [scene]);
  const sourceItems = useMemo(() => searchGraphSources(conversations, deferredQuery).filter((item) => scopedIds.has(item.evidence.conversationId)), [conversations, deferredQuery, query, scopedIds]);
  const overviewItems = useMemo<GraphExplorationOverviewItem[]>(() => {
    const items: GraphExplorationOverviewItem[] = [];
    for (const concept of concepts) {
      const ids = [...getGraphConceptConversationIds(concept, conversations)];
      items.push({ id: `concept:${concept.id}`, label: concept.label, kind: "Concept", count: ids.length, description: concept.description, examples: ids.slice(0, 2).map((id) => conversations[id].title) });
    }
    for (const group of Object.values(groups)) {
      const ids = [...new Set(group.conversationIds.filter((id) => conversations[id]))];
      items.push({ id: `group:${group.id}`, label: group.name, kind: "Group", count: ids.length, examples: ids.slice(0, 2).map((id) => conversations[id].title) });
    }
    const ungrouped = [...getGraphScopeConversationIds({ scope: { kind: "ungrouped" }, conversations, groups })];
    if (ungrouped.length) items.push({ id: "ungrouped", label: "Ungrouped", kind: "Ungrouped", count: ungrouped.length, examples: ungrouped.slice(0, 2).map((id) => conversations[id].title) });
    const seen = new Set<string>();
    for (const thread of categorizedThreads) {
      if (seen.has(thread.categoryId)) continue;
      seen.add(thread.categoryId);
      const ids = [...getGraphScopeConversationIds({ scope: { kind: "category", categoryId: thread.categoryId }, conversations, threads: categorizedThreads })];
      items.push({ id: `category:${thread.categoryId}`, label: thread.categoryLabel, kind: "Category", count: ids.length, description: "Activity category", examples: ids.slice(0, 2).map((id) => conversations[id].title) });
    }
    return items;
  }, [concepts, conversations, groups, categorizedThreads]);
  const overviewMemberships = useMemo(() => Object.fromEntries(overviewItems.map((item) => {
    const [kind, ...parts] = item.id.split(":");
    const id = parts.join(":");
    const itemScope: GraphScope = kind === "group" ? { kind, groupId: id }
      : kind === "concept" ? { kind, conceptId: id }
      : kind === "category" ? { kind, categoryId: categorizedThreads.find((thread) => thread.categoryId === id)!.categoryId }
      : { kind: "ungrouped" };
    return [item.id, [...getGraphScopeConversationIds({ scope: itemScope, conversations, groups, concepts, threads: categorizedThreads })]];
  })), [overviewItems, conversations, groups, concepts, categorizedThreads]);
  const showThemeOverview = scope.kind === "all" && !selectedConversation && navigation.state.overviewPresentation === "themes";
  const scopeLabel = scope.kind === "all" ? "All discussions" : scope.kind === "ungrouped" ? "Ungrouped" : scope.kind === "focus" ? `Around ${conversations[scope.conversationId]?.title ?? "removed discussion"}` : overviewItems.find((item) => item.id === `${scope.kind}:${scope.kind === "group" ? scope.groupId : scope.kind === "concept" ? scope.conceptId : scope.categoryId}`)?.label ?? "Unavailable collection";
  const resolvedSource = useMemo(() => source ? resolveGraphEvidence(conversations, source) : null, [conversations, source]);
  const {
    spatialIndex: nodeSpatialIndex,
    placementsById: placementByConversationId,
    orderById: placementOrderByConversationId,
  } = useMemo(
    () => buildGraphDragPreviewIndex(scene.nodes),
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
          scope.kind === "all" && !expandedGroups.includes(placement.groupId) &&
          (groups[placement.groupId]?.collapsed || semanticLevel === "territory"),
      ),
    [groups, scene.groups, semanticLevel, scope.kind, expandedGroups],
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
  const previewPlacementByConversationId = useMemo(
    () =>
      movingNodePosition
        ? resolveGraphDragPreview({
            move: movingNodePosition,
            placementsById: placementByConversationId,
            orderById: placementOrderByConversationId,
            spatialIndex: nodeSpatialIndex,
          }).placements
        : new Map<string, ConversationGraphNodePlacement>(),
    [movingNodePosition, nodeSpatialIndex, placementByConversationId, placementOrderByConversationId],
  );
  const renderedNodePlacements = useMemo(() => {
    if (!movingNodePosition) {
      return baseRenderedNodePlacements;
    }

    const visibleConversationIds = new Set(
      baseRenderedNodePlacements.map(
        (placement) => placement.conversationId,
      ),
    );
    const placements = baseRenderedNodePlacements.map(
      (placement) =>
        previewPlacementByConversationId.get(placement.conversationId) ??
        placement,
    );

    for (const placement of previewPlacementByConversationId.values()) {
      if (
        !visibleConversationIds.has(placement.conversationId) &&
        !hiddenConversationIds.has(placement.conversationId) &&
        (placement.conversationId === movingNodePosition.conversationId ||
          graphPlacementIntersectsBounds(placement, viewportBounds))
      ) {
        placements.push(placement);
      }
    }

    return placements;
  }, [
    baseRenderedNodePlacements,
    movingNodePosition,
    previewPlacementByConversationId,
    hiddenConversationIds,
    viewportBounds,
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

      const parentPlacement = previewPlacementByConversationId.get(
        edge.parentConversationId,
      ) ?? placementByConversationId.get(edge.parentConversationId);
      const childPlacement = previewPlacementByConversationId.get(
        edge.childConversationId,
      ) ?? placementByConversationId.get(edge.childConversationId);

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
    previewPlacementByConversationId,
    placementByConversationId,
    renderedNodePlacements,
    scene.edges,
  ]);
  const groupedEdges = useMemo(() => aggregateGraphEdges(scene, collapsedGroupPlacements).filter((edge) => edge.source.kind === "group" || edge.target.kind === "group"), [scene, collapsedGroupPlacements]);
  const aggregateEdges = useMemo(() => groupedEdges.filter((edge) =>
    graphPlacementIntersectsBounds({ x: Math.min(edge.startX, edge.endX) - 150, y: Math.min(edge.startY, edge.endY) - 30, width: Math.abs(edge.endX - edge.startX) + 300, height: Math.abs(edge.endY - edge.startY) + 60 }, viewportBounds)
  ), [groupedEdges, viewportBounds]);
  const relatedEdges = useMemo(() => {
    if (!showRelated || relatedStatus !== "ready") return [];
    const origin = placementByConversationId.get(activeConversationId);
    if (!origin || hiddenConversationIds.has(activeConversationId)) return [];
    return relatedItems.flatMap((item) => {
      const target = placementByConversationId.get(item.id);
      if (!target || hiddenConversationIds.has(item.id) || target.conversationId === activeConversationId) return [];
      return [{ id: item.id, startX: origin.x + origin.width, startY: origin.y + origin.height / 2, endX: target.x, endY: target.y + target.height / 2 }];
    });
  }, [showRelated, relatedStatus, activeConversationId, relatedItems, placementByConversationId, hiddenConversationIds]);
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
    setViewport({ viewport: nextViewport });
  }, [setViewport]);

  const interactions = useGraphInteractions({
    getViewport: () => viewportStateRef.current,
    toWorld: (point) => clientPointToWorld(point.clientX, point.clientY),
    getSelection: (bounds) => getGraphNodesInSelectionBounds(
      queryConversationGraphNodeSpatialIndex(nodeSpatialIndex, {
        left: bounds.x,
        top: bounds.y,
        right: bounds.x + bounds.width,
        bottom: bounds.y + bounds.height,
      }),
      bounds,
    ).filter((id) => !hiddenConversationIds.has(id)),
    onViewport: applyViewport,
    onPanning: setIsPanning,
    onNodePreview: setMovingNodePosition,
    onNodeCommit: commitNodeMove,
    onMarquee: setMarqueeBounds,
    onSelection: setMultiSelectedConversationIds,
  });

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

    const scale = detailLevel === "reader" ? 0.9 : Math.max(0.82, Math.min(viewportStateRef.current.scale, 1.12));

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
    navigation.navigate({
      scope: { kind: "all" }, selectedConversationId: focusRequest.conversationId, detailLevel: "preview", query: "",
      expandedGroups: Object.values(groups).filter((group) => group.conversationIds.includes(focusRequest.conversationId)).map((group) => group.id),
    });
    onFocusRequestHandled?.(focusRequest.requestId);
  }, [conversations, focusRequest, groups, navigation.navigate, onFocusRequestHandled]);

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

    if (restoringHistoryRef.current) {
      restoringHistoryRef.current = false;
      revealedSelectionKeyRef.current = selectionKey;
      return;
    }
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
    navigation.state,
  ]);

  useEffect(() => {
    if (!dockedConversationId) return;
    const saved = navigation.state.readerScroll;
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        if (!saved) return;
        const scroller = dockBodyRef.current?.querySelector<HTMLElement>(".panel-body, .conversation-graph-dock-fallback");
        if (scroller) scroller.scrollTop = saved;
      });
    });
    return () => { window.cancelAnimationFrame(firstFrame); window.cancelAnimationFrame(secondFrame); };
  }, [dockedConversationId, source, restoreRevision]);

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

      if (interactions.cancel()) return;

      if (isMultiSelectActive) {
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
    interactions,
    selectedConversationId,
  ]);

  function setScaleAtPoint(nextScale: number, localX: number, localY: number) {
    const current = viewportStateRef.current;
    const scale = clamp(nextScale, Math.min(GRAPH_SCALE_MIN, current.scale), GRAPH_SCALE_MAX);

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
      interactions.isActive() ||
      event.button !== 0 ||
      (event.target as HTMLElement).closest(
        "button, .conversation-graph-node, [data-graph-reader-scroll], [data-graph-ui]",
      )
    ) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    if (isMultiSelectActive) {
      interactions.startMarquee(event, event.shiftKey, multiSelectedConversationIds);
    } else {
      backgroundPressRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
      interactions.startPan(event);
    }
  }

  function startNodeMove(
    event: ReactPointerEvent<HTMLButtonElement>,
    conversationId: string,
  ) {
    if (event.button !== 0 || interactions.isActive()) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const conversationIds = multiSelectedConversationIds.has(conversationId)
      ? [...multiSelectedConversationIds].filter((id) => conversations[id])
      : [conversationId];
    interactions.startNode(event, conversationId, conversationIds);
  }

  function commitNodeMove(move: GraphNodeMove) {
    if (Math.abs(move.deltaX) < 0.5 && Math.abs(move.deltaY) < 0.5) return;
    // Focus spacing is transient. A deliberate drag starts at the displayed
    // position, but collision settlement and persistence use the authored map.
    const originalPlacements = new Map(unfocusedScene.nodes.map((node) => [node.conversationId, node]));
    const movedIds = new Set(move.conversationIds);
    const commitPlacements = unfocusedScene.nodes.map((node) => {
      const displayed = placementByConversationId.get(node.conversationId);
      return movedIds.has(node.conversationId) && displayed ? { ...node, x: displayed.x, y: displayed.y } : node;
    });
    const anchorPlacement = commitPlacements.find((node) => node.conversationId === move.conversationId);
    // Preview work is bounded, but release always settles the complete scene.
    const reflowedNodes = move.conversationIds.length > 1
      ? resolveGraphSelectionReflow({
          conversationIds: move.conversationIds,
          deltaX: move.deltaX,
          deltaY: move.deltaY,
          placements: commitPlacements,
        })
      : anchorPlacement
        ? resolveGraphNodeReflow({
            anchorConversationId: move.conversationId,
            placements: commitPlacements,
            x: anchorPlacement.x + move.deltaX,
            y: anchorPlacement.y + move.deltaY,
          })
        : commitPlacements;
    const nextLayouts = Object.fromEntries(
      reflowedNodes.filter((placement) => {
        const current = originalPlacements.get(placement.conversationId);
        return !current || Math.abs(current.x - placement.x) >= 0.5 || Math.abs(current.y - placement.y) >= 0.5;
      }).map((placement) => [placement.conversationId, {
        positioned: true,
        x: Math.round(placement.x),
        y: Math.round(placement.y),
      }]),
    );
    onUpdateGraphNodeLayouts?.(nextLayouts);
  }

  function handleViewportPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const press = backgroundPressRef.current;
    if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4) press.moved = true;
    if (interactions.move(event)) event.preventDefault();
  }

  function handleViewportPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const press = backgroundPressRef.current;
    backgroundPressRef.current = null;
    interactions.end(event);
    if (press?.pointerId === event.pointerId && !press.moved && Math.hypot(event.clientX - press.x, event.clientY - press.y) <= 4 && selectedConversationId) {
      navigation.navigate({ selectedConversationId: null, detailLevel: "compact" });
    }
  }

  function handleViewportPointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    backgroundPressRef.current = null;
    interactions.end(event, false);
  }

  function clientPointToWorld(clientX: number, clientY: number) {
    const viewportElement = viewportRef.current;
    const current = viewportStateRef.current;
    if (!viewportElement) return { x: 0, y: 0 };
    const rect = viewportElement.getBoundingClientRect();
    return {
      x: (clientX - rect.left - current.x) / current.scale,
      y: (clientY - rect.top - current.y) / current.scale,
    };
  }

  function toggleMultiSelect() {
    interactions.cancel();
    setIsMultiSelectActive((active) => {
      if (active) {
        setMultiSelectedConversationIds(new Set());
        setMarqueeBounds(null);
      }
      return !active;
    });
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
      navigation.navigate({ selectedConversationId: null, detailLevel: "compact" });
      return;
    }

    setInspectedEdge(null);
    navigation.navigate({ selectedConversationId: conversationId, detailLevel: "preview", source: null });
  }

  function expandConversation(conversationId: string) {
    if (!conversations[conversationId]) {
      return;
    }

    navigation.navigate({ selectedConversationId: conversationId, detailLevel: "reader", source: null });
  }

  function dockConversation(conversationId: string) {
    if (!conversations[conversationId]) {
      return;
    }

    navigation.navigate({ dockedConversationId: conversationId, selectedConversationId: conversationId, detailLevel: "preview", source: null, readerScroll: 0 });
  }

  function addChildConversation(parentConversationId: string) {
    const childConversationId = onCreateChildConversation(
      parentConversationId,
    );

    if (!childConversationId) {
      return;
    }

    navigation.navigate({ scope: { kind: "all" }, selectedConversationId: childConversationId, detailLevel: "preview", expandedGroups: [] });
  }

  function changeScope(nextScope: GraphScope) {
    setInspectedEdge(null);
    setInspectedOverviewSources([]);
    setMultiSelectedConversationIds(new Set());
    setIsMultiSelectActive(false);
    navigation.navigate({ scope: nextScope, query: "", selectedConversationId: null, detailLevel: "compact", expandedGroups: [], overviewPresentation: "themes" });
    setFitAfterArrange(true);
  }

  function openGroup(placement: ConversationGraphGroupPlacement) {
    changeScope({ kind: "group", groupId: placement.groupId });
  }

  function openOverviewItem(id: string) {
    if (id === "ungrouped") return changeScope({ kind: "ungrouped" });
    const separator = id.indexOf(":");
    const kind = id.slice(0, separator);
    const value = id.slice(separator + 1);
    if (kind === "concept") changeScope({ kind, conceptId: value });
    if (kind === "group") changeScope({ kind, groupId: value });
    if (kind === "category") {
      const category = categorizedThreads.find((thread) => thread.categoryId === value);
      if (category) changeScope({ kind, categoryId: category.categoryId });
    }
  }

  function openEvidence(evidence: GraphEvidenceRef) {
    if (!conversations[evidence.conversationId]) return;
    setInspectedEdge(null);
    setInspectedOverviewSources([]);
    revealedSelectionKeyRef.current = null;
    navigation.navigate({
      scope: scopedIds.has(evidence.conversationId) ? scope : { kind: "all" },
      selectedConversationId: evidence.conversationId, dockedConversationId: evidence.conversationId,
      detailLevel: "preview", source: evidence, readerScroll: 0,
      expandedGroups: [...new Set([...expandedGroups, ...Object.values(groups).filter((group) => group.conversationIds.includes(evidence.conversationId)).map((group) => group.id)])],
    });
  }

  function branchEvidence(conversation: Conversation): GraphEvidenceRef | null {
    const anchor = conversation.branchAnchor;
    return anchor ? { conversationId: anchor.sourceConversationId, sourceKind: "message", messageId: anchor.sourceMessageId, quote: anchor.quote, startOffset: anchor.startOffset, endOffset: anchor.endOffset } : conversation.parentId ? { conversationId: conversation.parentId, sourceKind: "conversation" } : null;
  }

  function saveConcepts(next: GraphConcept[]) {
    setConcepts(next);
    setConceptSaveError(workspaceKey ? !writeGraphConcepts(workspaceKey, next) : true);
  }

  function addSelectionToConcept(id: string) {
    if (!selectedConversation) return;
    const member: GraphEvidenceRef = source?.conversationId === selectedConversation.id ? source : { conversationId: selectedConversation.id, sourceKind: "conversation" };
    saveConcepts(concepts.map((concept) => concept.id !== id || concept.members.some((item) => JSON.stringify(item) === JSON.stringify(member)) ? concept : { ...concept, members: [...concept.members, member] }));
  }

  function restoreHistory(direction: "back" | "forward") {
    setInspectedEdge(null);
    setInspectedOverviewSources([]);
    setFitAfterArrange(false);
    restoringHistoryRef.current = true;
    setRestoreRevision((value) => value + 1);
    if (direction === "back") navigation.back(); else navigation.forward();
  }

  if (!activeConversation) {
    return null;
  }

  const minimapScale = Math.min(112 / Math.max(1, worldBounds.width), 66 / Math.max(1, worldBounds.height));
  const worldViewport = {
    height: viewportSize.height / viewport.scale,
    width: viewportSize.width / viewport.scale,
    x: -viewport.x / viewport.scale,
    y: -viewport.y / viewport.scale,
  };
  const minimapViewport = {
    height:
      Math.min(worldBounds.bottom, worldViewport.y + worldViewport.height) -
      Math.max(worldBounds.top, worldViewport.y),
    width:
      Math.min(worldBounds.right, worldViewport.x + worldViewport.width) -
      Math.max(worldBounds.left, worldViewport.x),
    x: Math.max(worldBounds.left, worldViewport.x),
    y: Math.max(worldBounds.top, worldViewport.y),
  };
  const showMinimapViewport =
    minimapViewport.height > 0 && minimapViewport.width > 0;

  return (
    <section className="conversation-graph graph-map-exploration" aria-label="Conversation graph">
      <div className="graph-map-navigation" role="toolbar" aria-label="Map exploration">
        <button type="button" aria-label="Back in map" disabled={!navigation.canGoBack} onClick={() => restoreHistory("back")}>← Back</button>
        <button type="button" aria-label="Forward in map" disabled={!navigation.canGoForward} onClick={() => restoreHistory("forward")}>Forward →</button>
        <button type="button" onClick={() => changeScope({ kind: "all" })}>Overview</button>
        {scope.kind === "all" && !selectedConversation ? <button type="button" onClick={() => { setInspectedOverviewSources([]); navigation.navigate({ overviewPresentation: showThemeOverview ? "map" : "themes" }); }}>{showThemeOverview ? "Show map" : "Show themes"}</button> : null}
        <span className="graph-map-scope" aria-live="polite">{scopeLabel} · {scopedIds.size} of {Object.keys(conversations).length} sources</span>
        <button type="button" aria-expanded={explorerOpen} aria-controls="graph-exploration-panel" onClick={() => setExplorerOpen((open) => !open)}>{explorerOpen ? "Hide explorer" : "Explore & search"}</button>
      </div>
      <div
        className={
          `conversation-graph-workspace${dockedConversation ? " has-docked-chat" : ""}${explorerOpen ? " has-explorer" : ""}`
        }
      >
        {explorerOpen ? <div id="graph-exploration-panel" className="graph-map-explorer">
          <GraphExplorationPanel
            overviewItems={overviewItems} sourceItems={scope.kind === "concept" && !query.trim() ? (concepts.find((concept) => concept.id === scope.conceptId)?.members ?? []).map((evidence, index) => {
              const resolved = resolveGraphEvidence(conversations, evidence);
              return { id: `member-${index}`, title: conversations[evidence.conversationId]?.title ?? "Removed source", preview: evidence.quote || excerpt(resolved.content ?? "This source is no longer available.", 180), sourceLabel: resolved.status === "missing" || resolved.status === "stale" ? "Source needs review" : "Discusses concept · added by you", evidence };
            }) : sourceItems}
            concepts={concepts} scopeLabel={scopeLabel} scopeKind={scope.kind} scopeKey={JSON.stringify(scope)}
            selectedConversationTitle={selectedConversation?.title}
            selectedConceptId={scope.kind === "concept" ? scope.conceptId : undefined}
            query={query} onQueryChange={(value) => navigation.update({ query: value })}
            onOpenOverviewItem={openOverviewItem} onSelectSource={openEvidence}
            onCreateConcept={(label, description) => {
              const members: GraphEvidenceRef[] = selectedConversation ? [source?.conversationId === selectedConversation.id ? source : { conversationId: selectedConversation.id, sourceKind: "conversation" }] : [];
              const concept = { id: crypto.randomUUID(), label, description, members };
              saveConcepts([...concepts, concept]);
              changeScope({ kind: "concept", conceptId: concept.id });
            }}
            onUpdateConcept={(concept) => saveConcepts(concepts.map((item) => item.id === concept.id ? concept : item))}
            onDeleteConcept={(id) => { saveConcepts(concepts.filter((concept) => concept.id !== id)); if (scope.kind === "concept" && scope.conceptId === id) changeScope({ kind: "all" }); }}
            onAddSelectionToConcept={addSelectionToConcept}
            onFocusSelection={() => { if (selectedConversation) changeScope({ kind: "focus", conversationId: selectedConversation.id, depth: 1 }); }}
            onShowBranchSource={selectedConversation?.parentId ? () => { const evidence = branchEvidence(selectedConversation); if (evidence) openEvidence(evidence); } : undefined}
          />
          {conceptSaveError ? <p className="graph-map-storage-error" role="status">Concept changes could not be saved on this device. Keep this view open to retain them.</p> : null}
        </div> : null}
        <div
          className={`conversation-graph-viewport${isPanning ? " is-panning" : ""}${showThemeOverview ? " is-theme-overview" : ""}${movingNodePosition ? " is-moving-nodes" : ""}`}
          onLostPointerCapture={handleViewportPointerCancel}
          onPointerCancel={handleViewportPointerCancel}
          onPointerDown={startPan}
          onPointerMove={handleViewportPointerMove}
          onPointerUp={handleViewportPointerUp}
          ref={viewportRef}
          style={viewportStyle}
        >
          {showThemeOverview ? <GraphOverviewCanvas items={overviewItems} memberships={overviewMemberships} conversations={conversations} selectedTopicId={navigation.state.overviewTopicId} onSelectTopic={(id) => navigation.update({ overviewTopicId: id })} onOpen={openOverviewItem} onInspectConnection={setInspectedOverviewSources} /> : null}
          <div className="graph-map-context-controls" data-graph-ui="true">
            {scope.kind === "focus" ? <button type="button" onClick={() => { navigation.navigate({ scope: { ...scope, depth: scope.depth + 1 } }); setFitAfterArrange(true); }}>Expand branches · depth {scope.depth}</button> : null}
            {relatedStatus === "ready" && relatedItems.length > 0 ? <label><input type="checkbox" checked={showRelated} onChange={(event) => { navigation.update({ showRelated: event.target.checked }); setFitAfterArrange(true); }} /> Possibly related to {conversations[activeConversationId]?.title}</label> : null}
            {showRelated && relatedStatus === "ready" ? <small>Suggestions from up to 40 recent items; relevance is not a factual relationship.</small> : null}
          </div>
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
                    collapsedGroupPlacements.some((item) => item.groupId === group.id)
                  }
                  group={group}
                  key={group.id}
                  onOpen={openGroup}
                  onToggle={(id) => {
                    navigation.navigate({ scope: { kind: "all" }, expandedGroups: expandedGroups.filter((item) => item !== id) });
                    if (!groups[id]?.collapsed || !expandedGroups.includes(id)) onToggleGroup(id);
                  }}
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
              {aggregateEdges.map((edge) => <g key={edge.id} className="graph-map-aggregate-edge" data-graph-ui="true" role="button" tabIndex={0} aria-label={`Inspect ${edge.count} branch relationship${edge.count === 1 ? "" : "s"}`} onClick={() => setInspectedEdge(edge)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setInspectedEdge(edge); } }}>
                <path className="conversation-graph-edge" d={buildConnectorPath(edge)} />
                <path className="graph-map-edge-hit" d={buildConnectorPath(edge)} />
                <text x={(edge.startX + edge.endX) / 2} y={(edge.startY + edge.endY) / 2 - 8}>{edge.count} branch{edge.count === 1 ? "" : "es"}</text>
              </g>)}
              {relatedEdges.map((edge) => <g key={`related-${edge.id}`} className="graph-map-related-edge"><path d={buildConnectorPath(edge)} /><title>Possibly related: {conversations[edge.id].title}</title></g>)}
              {renderedEdges.map((edge) => (
                <g key={`${edge.parentConversationId}-${edge.childConversationId}`}>
                  <path className="graph-map-edge-hit" data-graph-ui="true" d={buildConnectorPath(edge)} role="button" tabIndex={0} aria-label={`Show branch source for ${conversations[edge.childConversationId]?.title}`} onClick={() => { const evidence = branchEvidence(conversations[edge.childConversationId]); if (evidence) openEvidence(evidence); }} onKeyDown={(event) => { if (event.key === "Enter") { const evidence = branchEvidence(conversations[edge.childConversationId]); if (evidence) openEvidence(evidence); } }} />
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
                  categoryLabel={categoryLabels.get(getConversationRootId(conversations, conversation.id) ?? conversation.id)}
                  conversation={conversation}
                  detailLevel={
                    conversation.id === selectedConversation?.id
                      ? detailLevel
                      : "compact"
                  }
                  group={group}
                  groups={groups}
                  isMoving={movingConversationIds.has(conversation.id)}
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
                  onFocus={(id) => changeScope({ kind: "focus", conversationId: id, depth: 1 })}
                  onSource={(id) => { const evidence = branchEvidence(conversations[id]); if (evidence) openEvidence(evidence); }}
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

          {inspectedEdge ? <section className="graph-map-edge-inspector" data-graph-ui="true" aria-label="Branch connection details">
            <header><strong>{inspectedEdge.count} branch relationship{inspectedEdge.count === 1 ? "" : "s"}</strong><button type="button" aria-label="Close connection details" onClick={() => setInspectedEdge(null)}>×</button></header>
            {inspectedEdge.memberEdges.map((edge) => <button type="button" key={`${edge.parentConversationId}-${edge.childConversationId}`} onClick={() => { const child = conversations[edge.childConversationId]; const evidence = child && branchEvidence(child); if (evidence) openEvidence(evidence); }}>
              {conversations[edge.parentConversationId]?.title ?? "Removed source"} → {conversations[edge.childConversationId]?.title ?? "Removed discussion"}<small>Branched from · show source</small>
            </button>)}
          </section> : null}
          {inspectedOverviewSources.length ? <section className="graph-map-edge-inspector graph-map-overview-inspector" data-graph-ui="true" aria-label="Sources behind this connection">
            <header><strong>Sources behind this connection</strong><button type="button" aria-label="Close connection sources" onClick={() => setInspectedOverviewSources([])}>×</button></header>
            {inspectedOverviewSources.map((id) => conversations[id] ? <button type="button" key={id} onClick={() => openEvidence({ conversationId: id, sourceKind: "conversation" })}>{conversations[id].title}<small>Open original source</small></button> : null)}
          </section> : null}
          {scene.nodes.length === 0 ? <p className="graph-map-empty">{scope.kind === "concept" ? "Add a source to this concept from the overview or search results." : "No discussions in this view. Return to Overview to explore."}</p> : null}
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
              aria-label="Organize graph by topic"
              disabled={isAutoArranging || !scene.nodes.length || !onUpdateGraphNodeLayouts}
              onClick={() => {
                onUpdateGraphNodeLayouts?.(buildCategoryOrganizedGraphLayouts({ conversations, graphLayouts, threads: categorizedThreads }));
                setFitAfterArrange(true);
              }}
              title="Arrange threads using their topic categories"
              type="button"
            >
              Topics
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
            <div className="conversation-graph-minimap" aria-label="Discussion minimap" data-graph-ui="true" onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              const x = worldBounds.left + ((event.clientX - rect.left) / rect.width) * worldBounds.width;
              const y = worldBounds.top + ((event.clientY - rect.top) / rect.height) * worldBounds.height;
              applyViewport({ scale: viewport.scale, x: viewportSize.width / 2 - x * viewport.scale, y: viewportSize.height / 2 - y * viewport.scale });
            }}>
              <svg
                aria-hidden="true"
                height={Math.max(28, worldBounds.height * minimapScale)}
                viewBox={`${worldBounds.left} ${worldBounds.top} ${worldBounds.width} ${worldBounds.height}`}
                width={Math.max(48, worldBounds.width * minimapScale)}
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
            {source && resolvedSource ? <section className="graph-map-evidence" aria-label="Source passage">
              <div><strong>{source.sourceKind === "message" ? "Source message" : source.sourceKind === "standalone-note" ? "Source note" : "Selected discussion"}</strong><button type="button" onClick={() => navigation.update({ source: null })}>Close passage</button></div>
              {resolvedSource.status === "missing" || resolvedSource.status === "stale" ? <p role="status">{resolvedSource.status === "missing" ? "The source has been removed." : "The quoted passage has changed. Review the current text; the old quote is not highlighted."}</p> : null}
              {resolvedSource.status === "recovered" ? <p>Passage found at its updated position.</p> : null}
              {source.quote && !resolvedSource.highlight ? <blockquote>{source.quote}</blockquote> : null}
              {resolvedSource.content ? <p className="graph-map-source-text">{resolvedSource.highlight ? <>{resolvedSource.content.slice(Math.max(0, resolvedSource.highlight.startOffset - 180), resolvedSource.highlight.startOffset)}<mark>{resolvedSource.content.slice(resolvedSource.highlight.startOffset, resolvedSource.highlight.endOffset)}</mark>{resolvedSource.content.slice(resolvedSource.highlight.endOffset, resolvedSource.highlight.endOffset + 220)}</> : excerpt(resolvedSource.content, 460)}</p> : null}
            </section> : null}
            <div className="conversation-graph-dock-body" ref={dockBodyRef} onScrollCapture={(event) => { if (event.target instanceof HTMLElement) navigation.update({ readerScroll: event.target.scrollTop }); }}>
              {renderDockedConversation?.(dockedConversation.id, source ?? undefined) ?? (
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
