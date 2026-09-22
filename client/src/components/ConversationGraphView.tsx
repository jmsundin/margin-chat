import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useEffectEvent,
  useId,
  useDeferredValue,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { getCurrentDocumentText, getPrimaryDocumentSources } from "../lib/documentSources";
import GraphTerritoryLayer from "./GraphTerritoryLayer";
import { useJevGroupCategories } from "../lib/useJevGroupCategories";
import { getDocumentNodeFootprint, layoutDocumentMap, type DocumentLayoutMode } from "../lib/documentMapLayout";
import { getGraphNeighborhoodIds } from "../lib/graphNeighborhood";
import { documentConnectionGeometry } from "../lib/documentMapConnections";
import { curvedGraphConnection } from "../lib/graphConnectionCurve";
import { buildMapTerritories, centerNodeInCanvas, fitMapTerritories, fitMapTerritory, fitMapTerritoryOverview, getMapScale, layoutMapTerritoryOverview, layoutFocusedMapTerritory, mapLabelsOverlap, OVERVIEW_NODE_FOOTPRINT as GROUP_NODE_FOOTPRINT, readableNodeSize, type MapTerritory } from "../lib/graphPresentation";
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
import "./GraphSemanticMap.css";
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
  revealGraphBounds,
  type GraphNodeMove,
  type GraphPointer,
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
const GRAPH_SPARSE_GROUP_SCALE = 0.35;
const EMPTY_RELATED_ITEMS: Array<{ id: string; score: number }> = [];

function getGraphSemanticLevel(scale: number): ConversationGraphSemanticLevel {
  return getMapScale(scale) === "groups" ? "territory" : "compact";
}

export interface ConversationGraphViewProps {
  toolbarLeading?: ReactNode;
  toolbarTrailing?: ReactNode;
  explorerContainer?: HTMLElement | null;
  onOpenExplorer?: () => void;
  onFocusCanvas?: () => void;
  isVisible?: boolean;
  renderNodeActions?: (conversation: Conversation) => ReactNode;
  renderNodeMenuActions?: (conversation: Conversation) => ReactNode;
  connectingConversationId?: string | null;
  onConnectConversation?: (sourceId: string, targetId: string) => void;
  onRemoveConnection?: (sourceId: string, targetId: string) => void;
  workspaceKey?: string;
  onFocusRequestHandled?: (requestId: number) => void;
  relatedItems?: Array<{ id: string; score: number }>;
  relatedStatus?: string;
  jev?: { userId: string; enabled: boolean; ready: boolean };
  activeConversationId: string;
  conversations: Record<string, Conversation>;
  threads?: ThreadSummary[];
  focusRequest?: {
    conversationId: string;
    requestId: number;
    openReader?: boolean;
    neighborhoodDepth?: number;
    preserveMapMode?: boolean;
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
  return curvedGraphConnection(args).path;
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
  if (conversation.document) return excerpt(getCurrentDocumentText(conversation), 124) || "This document is empty.";
  const standaloneNote = getStandaloneNote(conversation);

  if (standaloneNote) {
    return standaloneNote.content.trim()
      ? excerpt(standaloneNote.content, 124)
      : conversation.publicTopic?.description ? excerpt(conversation.publicTopic.description, 124) : "This note is empty.";
  }

  const message =
    getLatestMessage(conversation, "assistant") ??
    getLatestMessage(conversation);

  return message
    ? excerpt(message.content, 124)
    : "This chat does not have any messages yet.";
}

function getSourceQuote(conversation: Conversation) {
  if (conversation.publicTopic) return `Wikidata · ${conversation.publicTopic.label}`;
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
        event.currentTarget.closest("details.graph-node-more")?.removeAttribute("open");
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
  zoomScale,
  screenFootprint,
  isConnectionCenter = false,
  isSpaced,
  menuActions,
  actions,
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
  actions?: ReactNode;
  menuActions?: ReactNode;
  zoomScale: number;
  screenFootprint?: { width: number; height: number; titleFontSize?: number; titleLines?: number };
  isConnectionCenter?: boolean;
  isSpaced?: boolean;
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
  const isPreview = isSelected && detailLevel === "preview" && !screenFootprint;
  const isReader = isSelected && detailLevel === "reader";
  const isNote = isStandaloneNoteConversation(conversation);
  const moveLabel =
    isMultiSelected && multiSelectionSize > 1
      ? `Move ${multiSelectionSize} selected chats`
      : `Move ${conversation.title}`;
  const nodeStyle = {
    height: `${screenFootprint?.height ?? placement.height}px`,
    left: `${placement.x + (placement.width - (screenFootprint?.width ?? placement.width)) / 2}px`,
    top: `${placement.y + (placement.height - (screenFootprint?.height ?? placement.height)) / 2}px`,
    width: `${screenFootprint?.width ?? placement.width}px`,
    transform: `scale(${screenFootprint ? 1 / zoomScale : readableNodeSize(zoomScale, isPreview || isReader)})`,
    "--map-card-title-size": screenFootprint?.titleFontSize ? `${screenFootprint.titleFontSize}px` : undefined,
    "--map-card-title-lines": screenFootprint?.titleLines,
  } as CSSProperties;
  const nodeType =
    conversation.publicTopic ? "Saved topic" : isNote
      ? "Note"
      : conversation.parentId ? "Branch chat" : "Chat";

  return (
    <article
      className={[
        "conversation-graph-node",
        screenFootprint ? "is-group-compact" : "",
        screenFootprint?.titleLines === 0 ? "is-title-hidden" : "",
        isConnectionCenter ? "is-connection-center" : "",
        isSpaced ? "is-group-spread" : "",
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

      </button>

      <div
        aria-label={`Actions for ${conversation.title}`}
        className="conversation-graph-node-actions"
        role="toolbar"
      >
        <GraphNodeAction icon="open" label={`Open ${conversation.title} in chat view`} onClick={() => onOpen(conversation.id)} primary />
        {actions}
        <details className="graph-node-more" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.querySelector<HTMLElement>("summary")?.focus(); } }} onClick={(event) => event.stopPropagation()}>
          <summary aria-label={`More actions for ${conversation.title}`} title="More actions">•••</summary>
          <div>
        {menuActions}
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
        <ConversationGroupSelect
          className="is-graph"
          conversationId={conversation.id}
          groups={groups}
          onAssign={onAssignGroup}
        />
          </div>
        </details>
      </div>

      {isPreview ? (
        <div className="conversation-graph-node-preview">
          <span className="conversation-graph-node-source-label">{conversation.publicTopic ? "Public topic · Your private notes" : isNote ? conversation.parentId ? "Child note" : "Workspace note" : conversation.parentId ? "Branched from" : "Discussion"}</span>
          {conversation.branchAnchor ? <blockquote>{getSourceQuote(conversation)}</blockquote> : null}
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
  toolbarLeading,
  toolbarTrailing,
  explorerContainer,
  onOpenExplorer,
  onFocusCanvas,
  isVisible = true,
  renderNodeActions,
  renderNodeMenuActions,
  connectingConversationId,
  onConnectConversation,
  onRemoveConnection,
  workspaceKey,
  onFocusRequestHandled,
  relatedItems = EMPTY_RELATED_ITEMS,
  relatedStatus = "off",
  jev,
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
  const groupSemantics = useJevGroupCategories({ userId: jev?.userId ?? "", enabled: !!jev?.enabled,
    ready: !!jev?.ready && isVisible, conversations, groups });
  const territoryGroups = useMemo(() => Object.fromEntries(groupSemantics.orderedGroupIds
    .filter((id) => groups[id]).map((id) => [id, groups[id]])), [groups, groupSemantics.orderedGroupIds]);
  const navigation = useGraphExplorationNavigation(workspaceKey);
  const { scope, selectedConversationId, detailLevel, dockedConversationId, viewport, source, query, expandedGroups, showRelated, focusedTerritoryId, focusedTerritoryScale } = navigation.state;
  const focusedNodeId = scope.kind === "focus" ? scope.conversationId : null;
  const documentsOnly = navigation.state.overviewPresentation === "documents" || !!focusedNodeId;
  const setSelectedConversationId = (id: string | null) => navigation.update({ selectedConversationId: id });
  const setDetailLevel = (value: ConversationGraphDetail) => navigation.update({ detailLevel: value });
  const setDockedConversationId = (id: string | null) => navigation.update({ dockedConversationId: id, source: null });
  const setViewport = navigation.update;
  const [concepts, setConcepts] = useState<GraphConcept[]>(() => workspaceKey ? readGraphConcepts(workspaceKey) : []);
  const [conceptSaveError, setConceptSaveError] = useState(false);
  const [inspectedEdge, setInspectedEdge] = useState<GraphAggregatedEdge | null>(null);
  const [inspectedPersonalConnection, setInspectedPersonalConnection] = useState<[string, string] | null>(null);
  const [inspectedOverviewSources, setInspectedOverviewSources] = useState<string[]>([]);
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const deferredQuery = useDeferredValue(query);
  const dockBodyRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const keyboardHintId = useId();
  const [dockWidth, setDockWidth] = useState(380);
  const [dockCollapsed, setDockCollapsed] = useState(false);
  const dockResizeRef = useRef<{ pointerId: number; clientX: number; width: number } | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const viewportStateRef = useRef<GraphViewport>(viewport);
  viewportStateRef.current = viewport;
  const positionedInitialSceneRef = useRef(navigation.restored);
  const revealedSelectionKeyRef = useRef<string | null>(navigation.restored && selectedConversationId ? `${selectedConversationId}:${detailLevel}` : null);
  const preserveSelectionViewRef = useRef<string | null>(null);
  const handledFocusRequestIdRef = useRef<number | null>(null);
  const restoringHistoryRef = useRef(false);
  const [restoreRevision, setRestoreRevision] = useState(0);
  const [viewportSize, setViewportSize] = useState({ height: 0, width: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const backgroundPressRef = useRef<{ pointerId: number; x: number; y: number; moved: boolean; territoryId?: string } | null>(null);
  const touchPointersRef = useRef(new Map<number, GraphPointer>());
  const suppressTouchClickRef = useRef(false);
  const [isMultiSelectActive, setIsMultiSelectActive] = useState(false);
  const [multiSelectedConversationIds, setMultiSelectedConversationIds] =
    useState<Set<string>>(() => new Set());
  const [marqueeBounds, setMarqueeBounds] =
    useState<GraphSelectionBounds | null>(null);
  const [isAutoArranging, setIsAutoArranging] = useState(false);
  const [autoArrangeError, setAutoArrangeError] = useState<string | null>(null);
  const [fitAfterArrange, setFitAfterArrange] = useState(false);
  const fitAsOverviewRef = useRef(false);
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
        semanticLevel: "compact",
        selectedConversationId: sceneConversationId,
        treeLayouts: graphLayouts,
      }),
    [
      conversations,
      graphLayouts,
      groups,
      sceneConversationId,
    ],
  );
  const minimumZoomScale = useMemo(() => {
    const bounds = getGraphWorldBounds([...completeScene.nodes, ...completeScene.groups], 24);
    // A fraction of viewport/world size can be
    // larger than that fit and lock zoom-out. Base the floor on authored extent
    // alone, with enough headroom for every fit and subsequent zoom-out.
    return Math.max(Number.EPSILON, Math.min(GRAPH_SCALE_MIN,
      1 / (Math.max(1, bounds.width, bounds.height) * 1024)));
  }, [completeScene]);
  const allDocumentConnections = useMemo(() => Object.values(conversations).flatMap((conversation) => [
    ...(conversation.parentId ? [{ sourceId: conversation.parentId, targetId: conversation.id }] : []),
    ...(conversation.linkedConversationIds ?? []).map((targetId) => ({ sourceId: conversation.id, targetId })),
  ]), [conversations]);
  const scopedIds = useMemo(() => {
    const ids = scope.kind === "focus"
      ? getGraphNeighborhoodIds(Object.keys(conversations), allDocumentConnections, scope.conversationId, scope.depth)
      : getGraphScopeConversationIds({ scope, conversations, groups, threads: categorizedThreads, concepts });
    if (showRelated && scope.kind === "focus" && scope.conversationId === activeConversationId) {
      for (const item of relatedItems) if (conversations[item.id]) ids.add(item.id);
    }
    return ids;
  }, [scope, conversations, groups, categorizedThreads, concepts, showRelated, relatedItems, activeConversationId, allDocumentConnections]);
  const canExpandNeighborhood = useMemo(() => scope.kind === "focus" && getGraphNeighborhoodIds(Object.keys(conversations), allDocumentConnections,
    scope.conversationId, scope.depth + 1).size > scopedIds.size, [scope, conversations, allDocumentConnections, scopedIds]);
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
  const territories = useMemo(() => buildMapTerritories(unfocusedScene, territoryGroups), [unfocusedScene, territoryGroups]);
  const focusedTerritory = territories.find((territory) => territory.id === focusedTerritoryId) ?? null;
  const browsingGroups = viewportSize.width > 0 && navigation.state.overviewPresentation === "map" && scope.kind === "all" && !focusedTerritory
    && (territories.some((territory) => territory.id !== "__ungrouped__") || unfocusedScene.nodes.length > 4);
  const browsingLayout = useMemo(() => browsingGroups
    ? layoutMapTerritoryOverview(territories, { x: 0, y: 0, scale: viewport.scale }, viewportSize.width || 1000) : [],
  [browsingGroups, territories, viewport.scale, viewportSize.width]);
  const browsingFootprints = useMemo(() => new Map(browsingLayout.flatMap((territory) => territory.contentsVisible
    ? territory.nodes.map((node) => [node.conversationId, territory.nodeFootprint] as const) : [])), [browsingLayout]);
  const focusedLayout = useMemo(() => focusedTerritory ? layoutFocusedMapTerritory(focusedTerritory,
    viewportSize.width && viewportSize.height ? viewportSize : { width: 1000, height: 700 }) : null,
  [focusedTerritory, viewportSize]);
  const compactTerritoryNodes = Boolean(focusedTerritoryId) && (viewport.scale < 0.7 || !!focusedLayout?.arranged) && detailLevel !== "reader";
  const compactFootprint = focusedLayout?.arranged ? focusedLayout.nodeFootprint! : GROUP_NODE_FOOTPRINT;
  const documentConnections = useMemo(() => {
    const ids = new Set(unfocusedScene.nodes.map((node) => node.conversationId));
    return [
      ...allDocumentConnections.filter(({ sourceId, targetId }) => ids.has(sourceId) && ids.has(targetId)),
    ];
  }, [unfocusedScene.nodes, allDocumentConnections]);
  const documentLayoutMode = navigation.state.documentLayoutMode;
  const documentLayout = useMemo(() => documentsOnly ? layoutDocumentMap(unfocusedScene.nodes,
    viewportSize.width && viewportSize.height ? viewportSize : { width: 1000, height: 700 },
    { mode: documentLayoutMode, connections: documentConnections, centerNodeId: focusedNodeId ?? undefined }) : null,
  [documentsOnly, unfocusedScene.nodes, viewportSize, documentLayoutMode, documentConnections, focusedNodeId]);
  const documentFootprint = useMemo(() => getDocumentNodeFootprint(viewport.scale), [viewport.scale]);
  const displayScene = useMemo(() => documentLayout
    ? replaceConversationGraphNodes(unfocusedScene, documentLayout.nodes)
    : focusedLayout
    ? replaceConversationGraphNodes(unfocusedScene, focusedLayout.territory.nodes)
    : browsingGroups ? replaceConversationGraphNodes(unfocusedScene, browsingLayout.flatMap((territory) => territory.contentsVisible ? territory.displayNodes : territory.nodes))
    : unfocusedScene, [unfocusedScene, focusedLayout, browsingGroups, browsingLayout, documentLayout]);
  const scene = useMemo(() => {
    if (!selectedConversation || detailLevel === "compact" || compactTerritoryNodes || browsingGroups || documentsOnly) return displayScene;
    const placements = displayScene.nodes.map((node) => node.conversationId === selectedConversation.id ? {
      ...node,
      ...getConversationGraphNodeDimensions({ conversation: selectedConversation, detailLevel, isSelected: true, mode: "overview", semanticLevel }),
    } : node);
    const footprints = placements.map((node) => {
      const factor = readableNodeSize(viewport.scale, node.conversationId === selectedConversation.id);
      return { ...node, x: node.x + node.width * (1 - factor) / 2, y: node.y + node.height * (1 - factor) / 2, width: node.width * factor, height: node.height * factor };
    });
    const adjusted = resolveGraphFocusLayout({ placements: footprints, selectedConversationId: selectedConversation.id, gapX: 24 / viewport.scale, gapY: 24 / viewport.scale });
    const originalById = new Map(placements.map((node) => [node.conversationId, node]));
    return replaceConversationGraphNodes(displayScene, adjusted.map((node) => {
      const original = originalById.get(node.conversationId)!;
      return { ...original, x: node.x + (node.width - original.width) / 2, y: node.y + (node.height - original.height) / 2 };
    }));
  }, [displayScene, selectedConversation, detailLevel, semanticLevel, viewport.scale, compactTerritoryNodes, browsingGroups, documentsOnly]);
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
  const canvasTerritories = useMemo(() => buildMapTerritories(scene, territoryGroups), [scene, territoryGroups]);
  const crowdedLabels = useMemo(() => mapLabelsOverlap(unfocusedScene.nodes, viewport.scale), [unfocusedScene.nodes, viewport.scale]);
  // A few distant notes should remain discoverable after Fit instead of
  // disappearing into one uninformative Ungrouped card. Their titles already
  // retain a readable screen size; aggregate only when they collide or the
  // user deliberately zooms farther out.
  const sparseUngroupedMap = unfocusedScene.nodes.length > 0 && unfocusedScene.nodes.length <= 4 && !unfocusedScene.groups.length;
  const groupScaleThreshold = sparseUngroupedMap ? GRAPH_SPARSE_GROUP_SCALE : 0.7;
  const showTerritories = !documentsOnly && (browsingGroups ? !browsingFootprints.size : !showThemeOverview && !focusedTerritory && (viewport.scale < groupScaleThreshold || (!selectedConversation && crowdedLabels)));
  const mapScale = showTerritories ? "groups" : viewport.scale >= 1.25 ? "working" : "titles";
  const hasRelatedFilter = relatedStatus === "ready" && relatedItems.length > 0;
  const hasMapFilters = hasRelatedFilter;
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
          !documentsOnly && !browsingGroups && scope.kind === "all" && !expandedGroups.includes(placement.groupId) &&
          groups[placement.groupId]?.collapsed && !placement.conversationIds.includes(selectedConversationId ?? ""),
      ),
    [groups, scene.groups, scope.kind, expandedGroups, selectedConversationId, browsingGroups, documentsOnly],
  );
  const hiddenConversationIds = useMemo(
    () => {
      const conversationIds = new Set<string>();
      if (browsingGroups) for (const node of scene.nodes) if (!browsingFootprints.has(node.conversationId)) conversationIds.add(node.conversationId);

      for (const placement of collapsedGroupPlacements) {
        for (const conversationId of placement.conversationIds) {
          conversationIds.add(conversationId);
        }
      }

      return conversationIds;
    },
    [collapsedGroupPlacements, browsingGroups, browsingFootprints, scene.nodes],
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
    const edges: Array<(typeof scene.edges)[number] & { path?: string }> = [];

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
        ...(documentsOnly ? documentConnectionGeometry(parentPlacement, childPlacement, documentLayoutMode) : {}),
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
    documentsOnly,
    documentLayoutMode,
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
      const geometry = documentsOnly ? documentConnectionGeometry(origin, target, documentLayoutMode)
        : { startX: origin.x + origin.width, startY: origin.y + origin.height / 2, endX: target.x, endY: target.y + target.height / 2, path: undefined };
      return [{ id: item.id, ...geometry }];
    });
  }, [showRelated, relatedStatus, activeConversationId, relatedItems, placementByConversationId, hiddenConversationIds, documentsOnly, documentLayoutMode]);
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
  const showMinimap = scene.nodes.length > 4 && !focusedLayout?.arranged && !browsingGroups && !documentsOnly;
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

  const applyManualViewport = useCallback((nextViewport: GraphViewport) => {
    const previous = viewportStateRef.current;
    const canvas = viewportRef.current;
    if (browsingGroups || documentsOnly) { applyViewport(nextViewport); return; }
    if (!focusedTerritoryId && !showTerritories && nextViewport.scale < previous.scale && nextViewport.scale < groupScaleThreshold && canvas) {
      interactions.cancel();
      const overview = fitMapTerritoryOverview(territories, { width: canvas.clientWidth, height: canvas.clientHeight });
      viewportStateRef.current = overview;
      navigation.update({ viewport: overview, selectedConversationId: null, dockedConversationId: null, source: null, detailLevel: "compact", overviewPresentation: "map" });
      return;
    }
    const returnToAtlas = focusedTerritoryId && focusedTerritoryScale
      && nextViewport.scale < previous.scale && nextViewport.scale < focusedTerritoryScale * 0.8;
    if (!returnToAtlas) { applyViewport(nextViewport); return; }
    const returningFromGrid = !!focusedLayout;
    const atlasViewport = returningFromGrid && canvas ? fitMapTerritoryOverview(buildMapTerritories(completeScene, territoryGroups),
      { width: canvas.clientWidth, height: canvas.clientHeight }, { maxScale: 0.65 }) : nextViewport;
    viewportStateRef.current = atlasViewport;
    setInspectedEdge(null);
    setInspectedPersonalConnection(null);
    setSearchOpen(false);
    setExplorerOpen(false);
    navigation.update({ viewport: atlasViewport, ...(returningFromGrid ? { scope: { kind: "all" } as GraphScope } : {}), focusedTerritoryId: null, focusedTerritoryScale: null,
      selectedConversationId: null, dockedConversationId: null, source: null,
      detailLevel: "compact", expandedGroups: [] });
    if (returningFromGrid) { fitAsOverviewRef.current = true; setFitAfterArrange(true); }
  }, [applyViewport, focusedTerritoryId, focusedTerritoryScale, focusedLayout, completeScene, territoryGroups, navigation.update, showTerritories, groupScaleThreshold, territories, browsingGroups, documentsOnly]);

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
    onViewport: applyManualViewport,
    onPanning: setIsPanning,
    onNodePreview: setMovingNodePosition,
    onNodeCommit: commitNodeMove,
    onMarquee: setMarqueeBounds,
    onSelection: setMultiSelectedConversationIds,
  });

  const fitGraph = useCallback(() => {
    const viewportElement = viewportRef.current;

    if (!isVisible || !viewportElement?.clientWidth || !viewportElement.clientHeight) {
      return;
    }

    const canvas = { width: viewportElement.clientWidth, height: viewportElement.clientHeight };
    if (documentsOnly) {
      applyViewport(layoutDocumentMap(unfocusedScene.nodes, canvas, { mode: documentLayoutMode, connections: documentConnections, centerNodeId: focusedNodeId ?? undefined }).viewport);
      fitAsOverviewRef.current = false;
      return;
    }
    if (browsingGroups) { applyViewport(fitMapTerritoryOverview(territories, canvas)); fitAsOverviewRef.current = false; return; }
    const territory = canvasTerritories.find((item) => item.id === focusedTerritoryId);
    if (territory) {
      const fitted = detailLevel === "reader" ? fitMapTerritory(territory, canvas, { selectedNodeId: selectedConversationId })
        : layoutFocusedMapTerritory(focusedTerritory ?? territory, canvas).viewport;
      applyViewport(fitted);
      navigation.update({ focusedTerritoryScale: fitted.scale });
    } else {
      const standardFit = canvasTerritories.length ? fitMapTerritories(canvasTerritories, canvas, { maxScale: 0.96, selectedNodeId: selectedConversationId })
        : calculateFitViewport(scene, viewportElement);
      const aggregate = fitAsOverviewRef.current || showTerritories || standardFit.scale < groupScaleThreshold || (!selectedConversation && mapLabelsOverlap(unfocusedScene.nodes, standardFit.scale));
      applyViewport(aggregate && canvasTerritories.length ? fitMapTerritoryOverview(canvasTerritories, canvas,
        { maxScale: Math.min(0.69, groupScaleThreshold - 0.01) }) : standardFit);
    }
    fitAsOverviewRef.current = false;
  }, [applyViewport, scene, canvasTerritories, focusedTerritory, focusedTerritoryId, selectedConversationId, detailLevel, isVisible, groupScaleThreshold, selectedConversation, unfocusedScene.nodes, navigation.update, showTerritories, browsingGroups, territories, documentsOnly, documentLayoutMode, documentConnections, focusedNodeId]);

  useEffect(() => {
    if (!isVisible || !viewportSize.width || !viewportSize.height || navigation.state.groupOverviewVersion === 1) return;
    // Cameras saved for the former scattered regions use a different origin.
    // Refit each legacy overview once, including entries restored by Back.
    navigation.update({ groupOverviewVersion: 1 });
    if (showTerritories) { fitAsOverviewRef.current = true; setFitAfterArrange(true); }
  }, [isVisible, viewportSize, navigation.state.groupOverviewVersion, navigation.update, showTerritories]);

  useEffect(() => {
    if (!isVisible || !focusedLayout?.arranged || !focusedTerritoryScale || Math.abs(focusedTerritoryScale - focusedLayout.viewport.scale) < 0.000001) return;
    applyViewport(focusedLayout.viewport);
    navigation.update({ focusedTerritoryScale: focusedLayout.viewport.scale });
  }, [isVisible, focusedLayout, focusedTerritoryScale, applyViewport, navigation.update]);

  useEffect(() => {
    if (!isVisible || !documentsOnly || !viewportSize.width || !viewportSize.height || navigation.state.documentLayoutVersion === 1) return;
    // Older document cameras were fitted to distant authored positions. Migrate
    // once; subsequent manual zoom and history restores keep their exact camera.
    navigation.update({ documentLayoutVersion: 1 });
    fitGraph();
  }, [isVisible, documentsOnly, viewportSize, navigation.state.documentLayoutVersion, navigation.update, fitGraph]);

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
    if (focusedNodeId) { fitGraph(); return; }
    const viewportElement = viewportRef.current;
    if (!isVisible || !viewportElement?.clientWidth || !viewportElement.clientHeight) return;

    if (!viewportElement || !selectedConversation) {
      fitGraph();
      return;
    }

    const scale = detailLevel === "reader" ? 0.9 : Math.max(0.82, Math.min(viewportStateRef.current.scale, 1.12));
    const placements = browsingGroups
      ? layoutMapTerritoryOverview(territories, { x: 0, y: 0, scale }, viewportElement.clientWidth).flatMap((territory) => territory.displayNodes)
      : scene.nodes;
    const selectedPlacement = placements.find(
      (placement) => placement.conversationId === selectedConversation.id,
    );

    if (!selectedPlacement) {
      fitGraph();
      return;
    }

    applyViewport(centerNodeInCanvas(selectedPlacement, viewportElement.getBoundingClientRect(), scale));
  }, [applyViewport, detailLevel, fitGraph, scene, selectedConversation, isVisible, browsingGroups, territories, focusedNodeId]);
  const keepConversationVisible = useCallback((conversationId: string) => {
    const element = viewportRef.current;
    const placement = scene.nodes.find((node) => node.conversationId === conversationId);
    if (!isVisible || !element?.clientWidth || !element.clientHeight || !placement) return;
    const current = viewportStateRef.current;
    if (browsingGroups && !browsingFootprints.has(conversationId)) return;
    const factor = readableNodeSize(current.scale, conversationId === selectedConversationId && detailLevel !== "compact");
    const footprint = documentsOnly ? documentFootprint : browsingFootprints.get(conversationId) ?? (compactTerritoryNodes ? compactFootprint : undefined);
    const width = footprint ? footprint.width / current.scale : placement.width * factor;
    const height = footprint ? footprint.height / current.scale : placement.height * factor;
    const next = revealGraphBounds({
      x: placement.x + (placement.width - width) / 2,
      y: placement.y + (placement.height - height) / 2 - 40 / current.scale,
      width, height: height + 40 / current.scale,
    }, current, { width: element.clientWidth, height: element.clientHeight });
    if (next.x !== current.x || next.y !== current.y) applyViewport(next);
  }, [applyViewport, detailLevel, isVisible, scene.nodes, selectedConversationId, compactTerritoryNodes, compactFootprint, browsingGroups, browsingFootprints, documentsOnly, documentFootprint]);
  const focusedCanvasSizeRef = useRef<{ id: string; width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const viewId = focusedTerritoryId ?? (documentsOnly ? "__documents__" : browsingGroups ? "__groups__" : null);
    const previous = focusedCanvasSizeRef.current;
    focusedCanvasSizeRef.current = viewId ? { id: viewId, ...viewportSize } : null;
    if (!previous?.width || !previous.height || previous.id !== viewId
      || (previous.width === viewportSize.width && previous.height === viewportSize.height)) return;
    if (!isVisible || (!focusedLayout?.arranged && !browsingGroups && !documentsOnly) || restoringHistoryRef.current) return;
    // ResizeObserver fires before the new grid columns are committed. Reveal
    // the selection here, against the placements that are actually rendered.
    if (focusedNodeId) fitGraph();
    else if (selectedConversation) keepConversationVisible(selectedConversation.id);
    else if (documentsOnly) fitGraph();
    else if (browsingGroups && browsingFootprints.size) applyViewport({ ...viewportStateRef.current,
      x: viewportStateRef.current.x + (viewportSize.width - previous.width) / 2,
      y: viewportStateRef.current.y + (viewportSize.height - previous.height) / 2 });
    else if (browsingGroups) fitGraph();
    else if (focusedLayout) applyViewport(focusedLayout.viewport);
  }, [focusedTerritoryId, viewportSize, focusedLayout, isVisible, selectedConversation, keepConversationVisible, applyViewport, browsingGroups, fitGraph, browsingFootprints.size, documentsOnly, focusedNodeId]);
  const revealOnResize = useEffectEvent(() => {
    if (restoringHistoryRef.current) return;
    if (focusedNodeId) fitGraph();
    else if (selectedConversation) keepConversationVisible(selectedConversation.id);
    else if (focusedTerritory || showTerritories) fitGraph();
  });
  const neighborhoodShape = useMemo(() => focusedNodeId ? JSON.stringify([
    focusedNodeId, unfocusedScene.nodes.map((node) => node.conversationId), documentConnections,
  ]) : null, [focusedNodeId, unfocusedScene.nodes, documentConnections]);
  const previousNeighborhoodShape = useRef(neighborhoodShape);
  useLayoutEffect(() => {
    const previous = previousNeighborhoodShape.current;
    previousNeighborhoodShape.current = neighborhoodShape;
    if (isVisible && neighborhoodShape && neighborhoodShape !== previous && !restoringHistoryRef.current) fitGraph();
  }, [neighborhoodShape, isVisible, fitGraph]);

  useEffect(() => {
    if (focusedTerritoryId && !focusedTerritory) navigation.update({ focusedTerritoryId: null, focusedTerritoryScale: null });
  }, [focusedTerritoryId, focusedTerritory, navigation.update]);

  useEffect(() => {
    if (selectedConversationId && !selectedConversation) {
      setSelectedConversationId(null);
      setDetailLevel("compact");
    }
  }, [selectedConversation, selectedConversationId]);

  useEffect(() => {
    if (
      !isVisible || !focusRequest ||
      handledFocusRequestIdRef.current === focusRequest.requestId ||
      !conversations[focusRequest.conversationId]
    ) {
      return;
    }

    handledFocusRequestIdRef.current = focusRequest.requestId;
    preserveSelectionViewRef.current = null;
    const neighborhoodDepth = focusRequest.neighborhoodDepth;
    if (neighborhoodDepth) {
      focusConnections(focusRequest.conversationId, neighborhoodDepth);
      onFocusRequestHandled?.(focusRequest.requestId);
      return;
    }
    revealedSelectionKeyRef.current = null;
    if (documentsOnly) setDockCollapsed(false);
    navigation.navigate({
      focusedTerritoryId: null, focusedTerritoryScale: null,
      overviewPresentation: documentsOnly ? "documents" : "canvas",
      scope: neighborhoodDepth ? { kind: "focus", conversationId: focusRequest.conversationId, depth: neighborhoodDepth } : { kind: "all" }, selectedConversationId: focusRequest.conversationId, detailLevel: focusRequest.openReader && !documentsOnly ? "reader" : "preview", query: "",
      ...(documentsOnly ? { dockedConversationId: focusRequest.conversationId, readerScroll: 0 } : {}),
      expandedGroups: Object.values(groups).filter((group) => group.conversationIds.includes(focusRequest.conversationId)).map((group) => group.id),
    });
    setFitAfterArrange(false);
    onFocusRequestHandled?.(focusRequest.requestId);
  }, [conversations, focusRequest, groups, navigation.navigate, onFocusRequestHandled, isVisible, documentsOnly]);

  useEffect(() => {
    if (dockedConversationId && !dockedConversation) {
      setDockedConversationId(null);
    }
  }, [dockedConversation, dockedConversationId]);

  useEffect(() => {
    if (!isVisible || positionedInitialSceneRef.current) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      positionedInitialSceneRef.current = true;
      revealedSelectionKeyRef.current = null;
      fitGraph();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [fitGraph, isVisible]);

  useEffect(() => {
    if (!isVisible || !fitAfterArrange) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      fitGraph();
      setFitAfterArrange(false);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [fitAfterArrange, fitGraph, isVisible]);

  useEffect(() => {
    const selectionKey = selectedConversation
      ? `${selectedConversation.id}:${detailLevel}`
      : null;
    if (!isVisible) return;

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
      if (focusedNodeId) fitGraph();
      else if (preserveSelectionViewRef.current === selectionKey && selectedConversation) keepConversationVisible(selectedConversation.id);
      else revealSelectedConversation();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [
    detailLevel,
    revealSelectedConversation,
    keepConversationVisible,
    selectedConversation,
    navigation.state,
    isVisible,
    focusedNodeId,
    fitGraph,
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

    if (!isVisible || !viewportElement || typeof ResizeObserver === "undefined") {
      return;
    }

    let measuredSize = {
      height: viewportElement.clientHeight,
      width: viewportElement.clientWidth,
    };
    setViewportSize(measuredSize);
    const responsiveResizeObserver = new ResizeObserver(() => {
      const nextSize = {
        height: viewportElement.clientHeight,
        width: viewportElement.clientWidth,
      };
      // Observing a canvas always produces an initial notification. A restored
      // camera should move only when the available canvas actually changes.
      if (nextSize.width === measuredSize.width && nextSize.height === measuredSize.height) return;
      measuredSize = nextSize;
      setViewportSize(nextSize);
      revealOnResize();
    });

    responsiveResizeObserver.observe(viewportElement);
    return () => responsiveResizeObserver.disconnect();
  }, [isVisible]);

  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (!isVisible || event.key !== "Escape") {
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
        return;
      }
      if (focusedTerritoryId) showAllGroups();
    }

    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [
    detailLevel,
    dockedConversationId,
    isMultiSelectActive,
    isVisible,
    interactions,
    selectedConversationId,
    focusedTerritoryId,
  ]);

  function setScaleAtPoint(nextScale: number, localX: number, localY: number) {
    const current = viewportStateRef.current;
    const scale = clamp(nextScale, minimumZoomScale, GRAPH_SCALE_MAX);

    if (scale === current.scale) {
      return;
    }

    const worldX = (localX - current.x) / current.scale;
    const worldY = (localY - current.y) / current.scale;

    applyManualViewport({
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

  function handleCanvasKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget || event.ctrlKey || event.metaKey || event.altKey || showThemeOverview) return;
    const current = viewportStateRef.current;
    const step = event.shiftKey ? 120 : 60;
    const direction = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[event.key];
    if (direction) applyManualViewport({ ...current, x: current.x + direction[0], y: current.y + direction[1] });
    else if (event.key === "+" || event.key === "=") zoomByStep("in");
    else if (event.key === "-" || event.key === "_") zoomByStep("out");
    else if (event.key === "Home" || event.key === "0") showAllGroups();
    else return;
    event.preventDefault();
  }

  function startTouchGesture(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType !== "touch") suppressTouchClickRef.current = false;
    const target = event.target as Element;
    if (event.pointerType !== "touch" || showThemeOverview || target.closest("[data-graph-reader-scroll]") || (target.closest("[data-graph-ui]") && !target.closest(".graph-territory"))) return;
    const touches = touchPointersRef.current;
    if (!touches.size) suppressTouchClickRef.current = false;
    if (touches.size >= 2) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    touches.set(event.pointerId, { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY });
    if (touches.size !== 2) return;
    const [first, second] = [...touches.values()];
    event.preventDefault();
    event.stopPropagation();
    backgroundPressRef.current = null;
    suppressTouchClickRef.current = true;
    interactions.startPinch(first, second, minimumZoomScale, GRAPH_SCALE_MAX);
    event.currentTarget.setPointerCapture(first.pointerId);
    event.currentTarget.setPointerCapture(second.pointerId);
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

    // Group headings and clickable SVG edges belong to the pannable canvas;
    // only overlays and controls should keep ordinary wheel events for themselves.
    const isMapSurface = graphUiRoot?.closest(".graph-territory, .conversation-graph-edges");
    if (graphUiRoot && !isMapSurface && !event.ctrlKey && !event.metaKey) {
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

    applyManualViewport({
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
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    if (isMultiSelectActive) {
      interactions.startMarquee(event, event.shiftKey, multiSelectedConversationIds);
    } else {
      const region = browsingGroups || showTerritories ? (event.target as Element).closest<HTMLElement>(".graph-territory-region") : null;
      backgroundPressRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false,
        territoryId: region?.dataset.territoryId };
      interactions.startPan(event);
    }
  }

  function startNodeMove(
    event: ReactPointerEvent<HTMLButtonElement>,
    conversationId: string,
  ) {
    if (documentsOnly || event.button !== 0 || interactions.isActive()) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const conversationIds = multiSelectedConversationIds.has(conversationId)
      ? [...multiSelectedConversationIds].filter((id) => conversations[id])
      : [conversationId];
    interactions.startNode(event, conversationId, conversationIds);
  }

  function commitNodeMove(move: GraphNodeMove) {
    if (documentsOnly) return;
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
    if (touchPointersRef.current.has(event.pointerId)) touchPointersRef.current.set(event.pointerId, { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY });
    const press = backgroundPressRef.current;
    if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4) press.moved = true;
    if (interactions.move(event)) event.preventDefault();
  }

  function handleViewportPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const press = backgroundPressRef.current;
    backgroundPressRef.current = null;
    interactions.end(event);
    if (touchPointersRef.current.delete(event.pointerId) && suppressTouchClickRef.current) {
      const remaining = [...touchPointersRef.current.values()][0];
      if (remaining) interactions.startPan(remaining);
      return;
    }
    if (press?.pointerId === event.pointerId && !press.moved && Math.hypot(event.clientX - press.x, event.clientY - press.y) <= 4) {
      const territory = press.territoryId && territories.find((candidate) => candidate.id === press.territoryId);
      if (territory) fitTerritory(territory);
      else if (selectedConversationId) navigation.navigate({ selectedConversationId: null, detailLevel: "compact" });
    }
  }

  function handleViewportPointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.type === "lostpointercapture" && event.currentTarget.hasPointerCapture(event.pointerId)) return;
    // Releasing an already finished capture must not cancel the remaining finger.
    if (event.pointerType === "touch" && !touchPointersRef.current.has(event.pointerId)) return;
    touchPointersRef.current.delete(event.pointerId);
    backgroundPressRef.current = null;
    interactions.end(event, false);
  }

  function resizeDock(width: number) {
    const available = workspaceRef.current?.clientWidth ?? 1000;
    setDockWidth(clamp(width, 280, Math.max(280, Math.min(640, available - 280))));
  }

  function handleDockResizeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowLeft") resizeDock(dockWidth + 24);
    else if (event.key === "ArrowRight") resizeDock(dockWidth - 24);
    else if (event.key === "Home") resizeDock(280);
    else if (event.key === "End") resizeDock(640);
    else return;
    event.preventDefault();
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

    if (scope.kind === "focus") {
      if (scope.conversationId !== conversationId) focusConnections(conversationId, scope.depth, documentLayoutMode);
      return;
    }

    if (selectedConversationId === conversationId && !((compactTerritoryNodes || browsingGroups || documentsOnly) && dockedConversationId !== conversationId)) {
      navigation.navigate({ selectedConversationId: null, detailLevel: "compact" });
      return;
    }

    setInspectedEdge(null);
    setSearchOpen(false);
    setExplorerOpen(false);
    if (compactTerritoryNodes || browsingGroups || documentsOnly) setDockCollapsed(false);
    onFocusCanvas?.();
    const outsideGroup = !!focusedTerritory && !focusedTerritory.nodes.some((node) => node.conversationId === conversationId);
    preserveSelectionViewRef.current = outsideGroup ? null : `${conversationId}:preview`;
    navigation.navigate({ selectedConversationId: conversationId, detailLevel: "preview", source: null,
      ...(!scopedIds.has(conversationId) ? { scope: { kind: "all" } as GraphScope } : {}),
      ...(outsideGroup
        ? { focusedTerritoryId: null, focusedTerritoryScale: null, overviewPresentation: "canvas" as const } : {}),
      ...(compactTerritoryNodes || browsingGroups || documentsOnly ? { dockedConversationId: conversationId, readerScroll: 0 } : {}) });
  }

  function expandConversation(conversationId: string) {
    if (!conversations[conversationId]) {
      return;
    }
    if (documentsOnly) { dockConversation(conversationId); return; }

    preserveSelectionViewRef.current = null;
    navigation.navigate({ selectedConversationId: conversationId, detailLevel: "reader", source: null });
  }

  function dockConversation(conversationId: string) {
    if (!conversations[conversationId]) {
      return;
    }

    setDockCollapsed(false);
    preserveSelectionViewRef.current = `${conversationId}:preview`;
    navigation.navigate({ dockedConversationId: conversationId, selectedConversationId: conversationId, detailLevel: "preview", source: null, readerScroll: 0 });
  }

  function addChildConversation(parentConversationId: string) {
    const childConversationId = onCreateChildConversation(
      parentConversationId,
    );

    if (!childConversationId) {
      return;
    }

    navigation.navigate({ scope: { kind: "all" }, focusedTerritoryId: null, focusedTerritoryScale: null, selectedConversationId: childConversationId, detailLevel: "preview", expandedGroups: [] });
  }

  function changeScope(nextScope: GraphScope) {
    if (nextScope.kind === "focus") { focusConnections(nextScope.conversationId, nextScope.depth); return; }
    setInspectedEdge(null);
    setInspectedOverviewSources([]);
    setMultiSelectedConversationIds(new Set());
    setIsMultiSelectActive(false);
    navigation.navigate({ scope: nextScope, focusedTerritoryId: null, focusedTerritoryScale: null, query: "", selectedConversationId: null,
      detailLevel: "compact", expandedGroups: [], overviewPresentation: documentsOnly ? "documents" : "map" });
    setFitAfterArrange(true);
  }

  function focusConnections(conversationId: string, depth = 1, mode: DocumentLayoutMode = "connections") {
    if (!conversations[conversationId]) return;
    interactions.cancel();
    setInspectedEdge(null);
    setInspectedPersonalConnection(null);
    setInspectedOverviewSources([]);
    setMultiSelectedConversationIds(new Set());
    setIsMultiSelectActive(false);
    setSearchOpen(false);
    setExplorerOpen(false);
    fitAsOverviewRef.current = false;
    revealedSelectionKeyRef.current = `${conversationId}:compact`;
    preserveSelectionViewRef.current = null;
    navigation.navigate({ scope: { kind: "focus", conversationId, depth: Math.max(1, Math.floor(depth)) },
      selectedConversationId: conversationId, dockedConversationId: null, detailLevel: "compact", source: null,
      focusedTerritoryId: null, focusedTerritoryScale: null, overviewPresentation: "documents", documentLayoutMode: mode,
      documentLayoutVersion: 1, query: "", expandedGroups: [], showRelated: false });
    onFocusCanvas?.();
    setFitAfterArrange(true);
  }

  function openGroup(placement: ConversationGraphGroupPlacement) {
    const territory = territories.find((item) => item.id === placement.groupId);
    if (territory) fitTerritory(territory);
  }

  function fitTerritory(territory: MapTerritory) {
    interactions.cancel();
    setInspectedEdge(null);
    setInspectedPersonalConnection(null);
    setInspectedOverviewSources([]);
    setMultiSelectedConversationIds(new Set());
    setIsMultiSelectActive(false);
    navigation.navigate({ focusedTerritoryId: territory.id, focusedTerritoryScale: null, selectedConversationId: null,
      dockedConversationId: null, source: null, detailLevel: "compact", overviewPresentation: "map",
      expandedGroups: [...new Set([...expandedGroups, territory.id])] });
    // Wait for a closing reader to give its space back before computing the fit.
    setFitAfterArrange(true);
  }

  function showAllGroups() {
    interactions.cancel();
    setInspectedEdge(null);
    setInspectedPersonalConnection(null);
    setInspectedOverviewSources([]);
    setMultiSelectedConversationIds(new Set());
    setIsMultiSelectActive(false);
    fitAsOverviewRef.current = true;
    navigation.navigate({ scope: { kind: "all" }, focusedTerritoryId: null, focusedTerritoryScale: null,
      selectedConversationId: null, dockedConversationId: null, source: null,
      detailLevel: "compact", expandedGroups: [], overviewPresentation: "map", query: "" });
    setFitAfterArrange(true);
  }

  function showDocuments() {
    interactions.cancel();
    setInspectedEdge(null);
    setInspectedPersonalConnection(null);
    setInspectedOverviewSources([]);
    setMultiSelectedConversationIds(new Set());
    setIsMultiSelectActive(false);
    setSearchOpen(false);
    setExplorerOpen(false);
    fitAsOverviewRef.current = false;
    navigation.navigate({ scope: { kind: "all" }, focusedTerritoryId: null, focusedTerritoryScale: null,
      selectedConversationId: null, dockedConversationId: null, source: null, detailLevel: "compact",
      expandedGroups: [], overviewPresentation: "documents", documentLayoutVersion: 1, query: "" });
    setFitAfterArrange(true);
  }

  function chooseDocumentLayout(mode: DocumentLayoutMode) {
    interactions.cancel();
    setInspectedEdge(null);
    setInspectedPersonalConnection(null);
    setAutoArrangeError(null);
    navigation.navigate({ documentLayoutMode: mode, selectedConversationId: focusedNodeId,
      dockedConversationId: null, source: null, detailLevel: "compact" });
    setFitAfterArrange(true);
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
    preserveSelectionViewRef.current = null;
    setDockCollapsed(false);
    const withinFocusedTerritory = focusedTerritory?.nodes.some((node) => node.conversationId === evidence.conversationId);
    navigation.navigate({
      scope: scopedIds.has(evidence.conversationId) ? scope : { kind: "all" },
      overviewPresentation: documentsOnly ? "documents" : withinFocusedTerritory ? "map" : "canvas",
      focusedTerritoryId: withinFocusedTerritory ? focusedTerritoryId : null,
      focusedTerritoryScale: withinFocusedTerritory ? focusedTerritoryScale : null,
      selectedConversationId: evidence.conversationId, dockedConversationId: evidence.conversationId,
      detailLevel: "preview", source: evidence, readerScroll: 0,
      expandedGroups: [...new Set([...expandedGroups, ...Object.values(groups).filter((group) => group.conversationIds.includes(evidence.conversationId)).map((group) => group.id)])],
    });
  }

  function branchEvidence(conversation: Conversation): GraphEvidenceRef | null {
    const anchor = conversation.branchAnchor;
    return anchor ? { conversationId: anchor.sourceConversationId, sourceKind: anchor.sourceBlockId ? "document" : "message", sourceBlockId: anchor.sourceBlockId, messageId: anchor.sourceMessageId, quote: anchor.quote, startOffset: anchor.startOffset, endOffset: anchor.endOffset } : conversation.parentId ? { conversationId: conversation.parentId, sourceKind: "conversation" } : null;
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
    fitAsOverviewRef.current = false;
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
  const scenePlacementsById = new Map(scene.nodes.map((node) => [node.conversationId, previewPlacementByConversationId.get(node.conversationId) ?? node]));

  function openExplorer() {
    setSearchOpen(false);
    if (onOpenExplorer) onOpenExplorer();
    else setExplorerOpen((open) => !open);
  }
  const explorationContent = <div className="graph-map-explorer-content" hidden={!isVisible}>
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
  </div>;

  return (
    <section className="conversation-graph graph-map-exploration semantic-map" aria-label="Conversation graph" data-map-scale={mapScale} data-map-presentation={documentsOnly ? "documents" : navigation.state.overviewPresentation} data-focused-node-id={focusedNodeId ?? undefined} data-has-selection={Boolean(selectedConversation)}>
      <div className={`graph-map-navigation${toolbarLeading ? " has-workspace-controls" : ""}`} role="toolbar" aria-label="Map exploration">
        {toolbarLeading}
        <div className="graph-map-history">
          <button type="button" aria-label="Back in map" title="Back in map" disabled={!navigation.canGoBack} onClick={() => restoreHistory("back")}><span aria-hidden="true">←</span></button>
          <button type="button" aria-label="Forward in map" title="Forward in map" disabled={!navigation.canGoForward} onClick={() => restoreHistory("forward")}><span aria-hidden="true">→</span></button>
        </div>
        <button type="button" className="graph-map-all-groups" aria-label="Zoom out to all groups" onClick={showAllGroups}>All groups</button>
        <span className={`graph-map-scope${focusedNodeId || scope.kind === "all" && !focusedTerritory ? " is-overview" : ""}`} aria-live="polite">{focusedTerritory ? `${focusedTerritory.label} · ${focusedTerritory.nodes.length} sources` : `${scopeLabel} · ${scopedIds.size} of ${Object.keys(conversations).length} sources`}</span>
        <div className="graph-map-search" ref={searchRef} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setSearchOpen(false); }}>
          <input type="search" aria-label="Search this map" placeholder="Search this map…" value={query}
            onFocus={() => setSearchOpen(true)} onChange={(event) => { navigation.update({ query: event.target.value }); setSearchOpen(true); }}
            onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setSearchOpen(false); } }} />
          {searchOpen && query.trim() ? <div className="graph-map-search-results" aria-label="Map search results">
            {sourceItems.slice(0, 5).map((item) => <button type="button" key={item.id} onClick={() => { setSearchOpen(false); onFocusCanvas?.(); openEvidence(item.evidence); }}>
              <strong>{item.title}</strong><span>{item.preview}</span>
            </button>)}
            {!sourceItems.length ? <p>No matching chats or notes in this view.</p> : null}
            <button type="button" onClick={openExplorer}>View all results · {sourceItems.length}</button>
          </div> : null}
        </div>
        <button type="button" aria-label="Explore map collections and sources" onClick={openExplorer}>Explore</button>
        <details className="graph-map-view-options" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.querySelector<HTMLElement>("summary")?.focus(); } }}>
          <summary aria-label="Map view options" title="Map view options"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="2" /><circle cx="15" cy="17" r="2" /></svg></summary>
          <div>
            <button type="button" aria-pressed={navigation.state.overviewPresentation === "map"} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); showAllGroups(); }}>Groups and documents</button>
            <button type="button" aria-pressed={documentsOnly} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); showDocuments(); }}>Documents and connections</button>
            {scope.kind === "all" && !selectedConversation && !focusedTerritory ? <button type="button" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); setInspectedOverviewSources([]); navigation.navigate({ overviewPresentation: showThemeOverview ? "map" : "themes", focusedTerritoryId: null, focusedTerritoryScale: null }); }}>{showThemeOverview ? "Show map" : "Show themes"}</button> : null}
          </div>
        </details>
        {hasMapFilters ? <details className="graph-map-filters" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.querySelector<HTMLElement>("summary")?.focus(); } }}><summary>Filters</summary><div className="graph-map-context-controls" data-graph-ui="true">
            {hasRelatedFilter ? <label><input type="checkbox" checked={showRelated} onChange={(event) => { navigation.update({ showRelated: event.target.checked }); setFitAfterArrange(true); }} /> Possibly related to {conversations[activeConversationId]?.title}</label> : null}
            {showRelated && relatedStatus === "ready" ? <small>Suggestions from up to 40 recent items; relevance is not a factual relationship.</small> : null}
          </div></details> : null}
        {toolbarTrailing}
      </div>
      {scope.kind === "focus" ? <div className="graph-map-neighborhood" role="region" aria-label="Focused connections">
        <div><strong>Around {conversations[scope.conversationId]?.title ?? "this document"}</strong>
          <span>{unfocusedScene.nodes.length} document{unfocusedScene.nodes.length === 1 ? "" : "s"} · {scope.depth} {scope.depth === 1 ? "step" : "steps"} away</span></div>
        <button type="button" disabled={!canExpandNeighborhood} onClick={() => focusConnections(scope.conversationId, scope.depth + 1, documentLayoutMode)}>Show more connections</button>
        <button type="button" onClick={showDocuments}>All nodes</button>
      </div> : null}
      {explorerContainer ? createPortal(explorationContent, explorerContainer) : explorerOpen ?
        <div className="graph-map-explorer-popover" data-graph-ui="true" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setExplorerOpen(false); } }}>
          <button type="button" className="graph-map-explorer-close" onClick={() => setExplorerOpen(false)}>Close explorer</button>
          {explorationContent}
        </div> : null}
      <div
        className={
          `conversation-graph-workspace${dockedConversation ? " has-docked-chat" : ""}`
        }
        ref={workspaceRef}
        style={{ "--personal-map-dock-width": `${dockWidth}px` } as CSSProperties}
      >
        <div
          className={`conversation-graph-viewport${isPanning ? " is-panning" : ""}${showThemeOverview ? " is-theme-overview" : ""}${movingNodePosition ? " is-moving-nodes" : ""}`}
          aria-label="Personal map canvas"
          aria-describedby={keyboardHintId}
          tabIndex={0}
          onKeyDown={handleCanvasKeyDown}
          onFocusCapture={(event) => {
            const node = (event.target as HTMLElement).closest<HTMLElement>("[data-conversation-id]");
            if (node?.dataset.conversationId) keepConversationVisible(node.dataset.conversationId);
          }}
          onClickCapture={(event) => { if (suppressTouchClickRef.current && event.detail > 0) { event.preventDefault(); event.stopPropagation(); } }}
          onLostPointerCapture={handleViewportPointerCancel}
          onPointerCancel={handleViewportPointerCancel}
          onPointerDown={startPan}
          onPointerDownCapture={startTouchGesture}
          onPointerMove={handleViewportPointerMove}
          onPointerUp={handleViewportPointerUp}
          ref={viewportRef}
          style={viewportStyle}
        >
          {showThemeOverview ? <GraphOverviewCanvas items={overviewItems} memberships={overviewMemberships} conversations={conversations} selectedTopicId={navigation.state.overviewTopicId} onSelectTopic={(id) => navigation.update({ overviewTopicId: id })} onOpen={openOverviewItem} onInspectConnection={setInspectedOverviewSources} /> : null}
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

          {!showThemeOverview && !documentsOnly ? <GraphTerritoryLayer territories={browsingGroups || showTerritories ? territories : canvasTerritories} conversations={conversations} viewport={viewport}
            semanticLabels={groupSemantics.categoryLabels}
            mode={browsingGroups || showTerritories ? "overview" : "canvas"} activeTerritoryId={focusedTerritory?.id}
            selectedNodeId={selectedConversationId}
            nodeFootprint={showTerritories ? GROUP_NODE_FOOTPRINT : compactTerritoryNodes ? compactFootprint : undefined}
            onOpen={fitTerritory} /> : null}
          <div
            className="conversation-graph-stage"
            data-group-layout={focusedLayout?.arranged ? "spaced" : undefined}
            data-document-layout={documentsOnly ? documentLayout?.arranged ? "spaced" : "authored" : undefined}
            data-document-layout-mode={documentsOnly ? documentLayoutMode : undefined}
            data-document-center-node-id={documentsOnly ? documentLayout?.centerNodeId ?? undefined : undefined}
            data-focused-node-id={focusedNodeId ?? undefined}
            hidden={showTerritories}
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

            {renderedGroupPlacements.filter((placement) => collapsedGroupPlacements.some((item) => item.groupId === placement.groupId)).map((placement) => {
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
              {[...scenePlacementsById.values()].flatMap((placement) => (conversations[placement.conversationId]?.linkedConversationIds ?? []).flatMap((targetId) => {
                const target = scenePlacementsById.get(targetId);
                if (!target || hiddenConversationIds.has(placement.conversationId) || hiddenConversationIds.has(targetId)) return [];
                const x1 = placement.x + placement.width / 2;
                const y1 = placement.y + placement.height / 2;
                const x2 = target.x + target.width / 2;
                const y2 = target.y + target.height / 2;
                const geometry = documentsOnly ? documentConnectionGeometry(placement, target, documentLayoutMode)
                  : curvedGraphConnection({ startX: x1, startY: y1, endX: x2, endY: y2 });
                return [<g key={`personal-${placement.conversationId}-${targetId}`} className="graph-personal-connection" data-graph-ui="true" role="button" tabIndex={0} aria-label={`My connection: ${conversations[placement.conversationId].title} and ${conversations[targetId].title}`} onClick={() => setInspectedPersonalConnection([placement.conversationId, targetId])} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setInspectedPersonalConnection([placement.conversationId, targetId]); } }}>
                  <path className="graph-map-edge-hit" d={geometry.path} />
                  <path className="graph-personal-connection-line" d={geometry.path} />
                  <text x={geometry.labelX} y={geometry.labelY - 8}>My connection</text>
                </g>];
              }))}
              {aggregateEdges.map((edge) => {
                const geometry = curvedGraphConnection(edge);
                return <g key={edge.id} className="graph-map-aggregate-edge" data-graph-ui="true" role="button" tabIndex={0} aria-label={`Inspect ${edge.count} branch relationship${edge.count === 1 ? "" : "s"}`} onClick={() => setInspectedEdge(edge)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setInspectedEdge(edge); } }}>
                  <path className="conversation-graph-edge" d={geometry.path} />
                  <path className="graph-map-edge-hit" d={geometry.path} />
                  <text x={geometry.labelX} y={geometry.labelY - 8}>{edge.count} branch{edge.count === 1 ? "" : "es"}</text>
                </g>;
              })}
              {relatedEdges.map((edge) => <g key={`related-${edge.id}`} className="graph-map-related-edge"><path d={edge.path ?? buildConnectorPath(edge)} /><title>Possibly related: {conversations[edge.id].title}</title></g>)}
              {renderedEdges.map((edge) => (
                <g key={`${edge.parentConversationId}-${edge.childConversationId}`}>
                  <path className="graph-map-edge-hit" data-graph-ui="true" d={edge.path ?? buildConnectorPath(edge)} role="button" tabIndex={0} aria-label={`Show branch source for ${conversations[edge.childConversationId]?.title}`} onClick={() => { const evidence = branchEvidence(conversations[edge.childConversationId]); if (evidence) openEvidence(evidence); }} onKeyDown={(event) => { if (event.key === "Enter") { const evidence = branchEvidence(conversations[edge.childConversationId]); if (evidence) openEvidence(evidence); } }} />
                  <path
                    className={
                      edge.isSelectedPath
                        ? "conversation-graph-edge is-selected-path"
                        : "conversation-graph-edge"
                    }
                    d={edge.path ?? buildConnectorPath(edge)}
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
                  zoomScale={viewport.scale}
                  screenFootprint={documentsOnly ? documentFootprint : browsingFootprints.get(placement.conversationId) ?? (compactTerritoryNodes ? compactFootprint : undefined)}
                  isConnectionCenter={documentsOnly && documentLayout?.centerNodeId === placement.conversationId}
                  isSpaced={documentsOnly || browsingGroups || focusedLayout?.arranged}
                  actions={renderNodeActions?.(conversation)}
                  menuActions={renderNodeMenuActions?.(conversation)}
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
                  onSelect={(id) => connectingConversationId && onConnectConversation ? onConnectConversation(connectingConversationId, id) : selectConversation(id)}
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

          {inspectedPersonalConnection && conversations[inspectedPersonalConnection[0]] && conversations[inspectedPersonalConnection[1]] ? <section className="graph-map-edge-inspector" data-graph-ui="true" aria-label="My connection details">
            <header><strong>My connection</strong><button type="button" aria-label="Close my connection" onClick={() => setInspectedPersonalConnection(null)}>×</button></header>
            <p>{conversations[inspectedPersonalConnection[0]].title} ↔ {conversations[inspectedPersonalConnection[1]].title}</p>
            <p>You added this relationship to your workspace.</p>
            {onRemoveConnection ? <button type="button" onClick={() => { onRemoveConnection(...inspectedPersonalConnection); setInspectedPersonalConnection(null); }}>Remove connection</button> : null}
          </section> : null}
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
          {scene.nodes.length === 0 ? <p className="graph-map-empty">{scope.kind === "concept" ? "Add a source to this concept from the overview or search results." : "No discussions in this view. Return to All groups to explore."}</p> : null}
          <p className="conversation-graph-pan-hint" id={keyboardHintId}>
            {isMultiSelectActive
              ? multiSelectedConversationIds.size
                ? "Drag a selected chat's move handle to move the group · Shift-drag to add more"
                : "Drag across chats to select them · Shift-drag adds to the selection"
              : detailLevel === "compact"
              ? "Click a chat for a preview · Drag to pan · Pinch to zoom"
              : detailLevel === "preview"
                ? "Expand to read here · Dock to keep the graph interactive"
                : "Scroll inside the chat · Minimize or dock when ready"}
            <span>Arrow keys pan · + / − zoom · Home shows all groups · Tab explores chats</span>
          </p>

          <div
            className="conversation-graph-zoom is-floating"
            data-graph-ui="true"
            role="group"
            aria-label="Graph navigation"
          >
            <details className="graph-map-layout-options" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.querySelector<HTMLElement>("summary")?.focus(); } }}><summary>Arrange</summary><div>
            {documentsOnly ? <>
              {([
                ["auto", "Auto layout"],
                ["tree-right", "Tree: left to right"],
                ["tree-down", "Tree: top down"],
                ["connections", focusedNodeId ? "Around focused node" : "Most connections"],
              ] as const).map(([mode, label]) => <button type="button" key={mode} aria-pressed={documentLayoutMode === mode}
                onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); chooseDocumentLayout(mode); }}>{label}</button>)}
              {documentLayout?.centerNodeId ? <small className="graph-map-layout-context">Centered on {conversations[documentLayout.centerNodeId]?.title}</small> : null}
            </> : <>
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
            </>}
            </div></details>
            {selectedConversation && !focusedNodeId ? <button type="button" onClick={() => focusConnections(selectedConversation.id)}>Focus connections</button> : null}
            {selectedConversation ? <button type="button" onClick={revealSelectedConversation}>Center</button> : null}
            <button
              aria-label="Zoom out"
              onClick={() => zoomByStep("out")}
              type="button"
            >
              −
            </button>
            <button onClick={fitGraph} type="button">{focusedTerritory ? "Fit group" : "Fit"}</button>
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
              applyManualViewport({ scale: viewport.scale, x: viewportSize.width / 2 - x * viewport.scale, y: viewportSize.height / 2 - y * viewport.scale });
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
          <>
          <div className="conversation-graph-dock-resize" role="separator" tabIndex={0}
            aria-label="Resize docked chat" aria-orientation="vertical" aria-valuemin={280} aria-valuemax={640} aria-valuenow={dockWidth}
            title="Drag to resize; use Left and Right arrow keys"
            onKeyDown={handleDockResizeKeyDown}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.focus({ preventScroll: true });
              event.currentTarget.setPointerCapture(event.pointerId);
              dockResizeRef.current = { pointerId: event.pointerId, clientX: event.clientX, width: dockBodyRef.current?.parentElement?.getBoundingClientRect().width || dockWidth };
            }}
            onPointerMove={(event) => {
              const resize = dockResizeRef.current;
              if (resize?.pointerId === event.pointerId) resizeDock(resize.width + resize.clientX - event.clientX);
            }}
            onPointerUp={() => { dockResizeRef.current = null; }}
            onPointerCancel={() => { dockResizeRef.current = null; }}
            onLostPointerCapture={() => { dockResizeRef.current = null; }}
          />
          <aside
            aria-label={`Docked chat: ${dockedConversation.title}`}
            className={`conversation-graph-dock${dockCollapsed ? " is-collapsed" : ""}`}
          >
            <div className="conversation-graph-dock-controls">
              {dockCollapsed ? <strong>{dockedConversation.title}</strong> : null}
              <button className="conversation-graph-dock-collapse" type="button" aria-expanded={!dockCollapsed}
                aria-label={dockCollapsed ? "Expand docked chat" : "Collapse docked chat"} onClick={() => setDockCollapsed((value) => !value)}>
                {dockCollapsed ? "Expand" : "Collapse"}
              </button>
              <button
                aria-label={`Close ${dockedConversation.title} split view`}
                onClick={() => setDockedConversationId(null)}
                type="button"
              >
                ×
              </button>
            </div>
            {source && resolvedSource ? <section className="graph-map-evidence" aria-label="Source passage">
              <div><strong>{source.sourceKind === "document" ? "Document passage" : source.sourceKind === "message" ? "Source message" : source.sourceKind === "standalone-note" ? "Source note" : "Selected discussion"}</strong><button type="button" onClick={() => navigation.update({ source: null })}>Close passage</button></div>
              {resolvedSource.status === "missing" || resolvedSource.status === "stale" ? <p role="status">{resolvedSource.status === "missing" ? "The source has been removed." : "The quoted passage has changed. Review the current text; the old quote is not highlighted."}</p> : null}
              {resolvedSource.status === "recovered" ? <p>Passage found at its updated position.</p> : null}
              {source.quote && !resolvedSource.highlight ? <blockquote>{source.quote}</blockquote> : null}
              {resolvedSource.content ? <p className="graph-map-source-text">{resolvedSource.highlight ? <>{resolvedSource.content.slice(Math.max(0, resolvedSource.highlight.startOffset - 180), resolvedSource.highlight.startOffset)}<mark>{resolvedSource.content.slice(resolvedSource.highlight.startOffset, resolvedSource.highlight.endOffset)}</mark>{resolvedSource.content.slice(resolvedSource.highlight.endOffset, resolvedSource.highlight.endOffset + 220)}</> : excerpt(resolvedSource.content, 460)}</p> : null}
            </section> : null}
            <div className="conversation-graph-dock-body" ref={dockBodyRef} onScrollCapture={(event) => { if (event.target instanceof HTMLElement) navigation.update({ readerScroll: event.target.scrollTop }); }}>
              {renderDockedConversation?.(dockedConversation.id, resolvedSource?.evidence ?? source ?? undefined) ?? (
                <div className="conversation-graph-dock-fallback">
                  {getPrimaryDocumentSources(dockedConversation).map((item) => (
                    <p key={item.sourceBlockId ?? item.messageId ?? item.noteId}>{item.content}</p>
                  ))}
                </div>
              )}
            </div>
          </aside>
          </>
        ) : null}
      </div>
    </section>
  );
}
