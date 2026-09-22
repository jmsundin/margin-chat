import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { fitFocusedMapTerritory, fitMapTerritories, fitMapTerritoryOverview, layoutMapTerritoryOverview, layoutFocusedMapTerritory, OVERVIEW_NODE_FOOTPRINT, readableNodeSize, type MapTerritory } from "../lib/graphPresentation";
import { DEFAULT_PUBLIC_RELATION_FILTERS, type PublicRelationFilters, type PublicRelationFilter } from "../lib/publicRelationFilters";
import { publicMapNeighborhoods, publicMapNodePlacements } from "../lib/publicMapPresentation";
import { getDocumentNodeFootprint, layoutDocumentMap, type DocumentLayoutMode } from "../lib/documentMapLayout";
import { documentConnectionGeometry } from "../lib/documentMapConnections";
import { getGraphNeighborhoodIds } from "../lib/graphNeighborhood";
import GraphTerritoryLayer from "./GraphTerritoryLayer";
import { expandPublicTopic, getPublicTopic, searchPublicTopics } from "../lib/publicKnowledge";
import type { PublicTopic } from "../lib/publicKnowledge";
import {
  addPublicGraphRoot, appendPublicGraphExpansion, emptyPublicGraph,
  setPublicExpansionVisible, visiblePublicGraph, PUBLIC_NODE_WIDTH, PUBLIC_NODE_HEIGHT,
} from "../lib/publicGraphScene";
import type { PublicGraphState } from "../lib/publicGraphScene";
import "./PublicKnowledgeMap.css";
import "./GraphSemanticMap.css";

export interface PublicKnowledgeMapProps {
  isVisible?: boolean;
  explorerContainer?: HTMLElement | null;
  onOpenExplorer?: () => void;
  onFocusCanvas?: () => void;
  workspaceKey: string;
  focusRequest?: { id: string; requestId: number } | null;
  searchRequest?: { query: string; requestId: number } | null;
  onFocusRequestHandled(requestId: number): void;
  onSearchRequestHandled(requestId: number): void;
  savedTopics: Record<string, string>;
  onSave(topic: PublicTopic): void;
  onShowInMyMap(conversationId: string, topic?: PublicTopic): void;
}

interface Viewport { x: number; y: number; scale: number }
interface MapLocation { graph: PublicGraphState; selectedId: string | null; neighborhoodId: string | null; neighborhoodScale: number | null; viewport: Viewport; query: string; filters: PublicRelationFilters; groupOverviewVersion: number; presentation: "groups" | "canvas" | "documents"; documentLayoutMode: DocumentLayoutMode; graphFocusId: string | null; graphFocusDepth: number }
interface TopicError { id: string; message: string; action: "open" | "expand" }
const INITIAL_VIEWPORT = { x: 80, y: 120, scale: 0.85 };
const PUBLIC_MAP_LIMIT = 240;
const SEEDS = [ { id: "Q11023", label: "Engineering" }, { id: "Q7150", label: "Ecology" }, { id: "Q23404", label: "Anthropology" } ];
const isQid = (value: unknown): value is string => typeof value === "string" && /^Q[1-9]\d*$/.test(value);

function readLocation(workspaceKey: string): MapLocation {
  const fallback: MapLocation = { graph: emptyPublicGraph(), selectedId: null, neighborhoodId: null, neighborhoodScale: null, viewport: INITIAL_VIEWPORT, query: "", filters: DEFAULT_PUBLIC_RELATION_FILTERS, groupOverviewVersion: 1, presentation: "groups", documentLayoutMode: "auto", graphFocusId: null, graphFocusDepth: 1 };
  try {
    const raw = sessionStorage.getItem(`margin-public-map:${workspaceKey}`);
    if (!raw) return fallback;
    const stored = JSON.parse(raw);
    const graph = stored.graph as PublicGraphState;
    if (stored.version !== 1 || !graph || !Array.isArray(graph.roots) || !graph.topics || !graph.positions || !graph.expansions) return fallback;
    if (Object.keys(graph.topics).length > 1200 || graph.roots.some((id: unknown) => !isQid(id))) return fallback;
    for (const [id, topic] of Object.entries(graph.topics)) {
      const point = graph.positions[id];
      if (!isQid(id) || topic.id !== id || typeof topic.label !== "string" || typeof topic.description !== "string" || !Array.isArray(topic.aliases) ||
        !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return fallback;
    }
    for (const [id, expansion] of Object.entries(graph.expansions)) {
      if (!isQid(id) || !Array.isArray(expansion.topicIds) || !Array.isArray(expansion.relations) || typeof expansion.visible !== "boolean" ||
        !Number.isFinite(expansion.nextOffset) || expansion.relations.some((relation) => !isQid(relation.sourceId) || !isQid(relation.targetId) || typeof relation.label !== "string")) return fallback;
    }
    const viewport = stored.viewport;
    if (!viewport || ![viewport.x, viewport.y, viewport.scale].every(Number.isFinite) || viewport.scale <= 0 || viewport.scale > 1.6) return fallback;
    const filters: PublicRelationFilters = { relation: ["all", "types", "parts", "other"].includes(stored.filters?.relation) ? stored.filters.relation : "all", includeMetadata: stored.filters?.includeMetadata === true };
    const neighborhoodId = isQid(stored.neighborhoodId) && graph.topics[stored.neighborhoodId] ? stored.neighborhoodId : null;
    const neighborhoodScale = neighborhoodId ? Number.isFinite(stored.neighborhoodScale) && stored.neighborhoodScale > 0 ? stored.neighborhoodScale : viewport.scale : null;
    const presentation = ["groups", "canvas", "documents"].includes(stored.presentation) ? stored.presentation : viewport.scale < 0.7 && !neighborhoodId ? "groups" : "canvas";
    const documentLayoutMode: DocumentLayoutMode = ["auto", "tree-right", "tree-down", "connections"].includes(stored.documentLayoutMode) ? stored.documentLayoutMode : "auto";
    const graphFocusId = presentation === "documents" && isQid(stored.graphFocusId) && visiblePublicGraph(graph).topics.some((topic) => topic.id === stored.graphFocusId) ? stored.graphFocusId : null;
    const graphFocusDepth = Number.isInteger(stored.graphFocusDepth) ? Math.max(1, Math.min(PUBLIC_MAP_LIMIT, stored.graphFocusDepth)) : 1;
    return { graph, viewport, filters, selectedId: isQid(stored.selectedId) && graph.topics[stored.selectedId] ? stored.selectedId : null, neighborhoodId, neighborhoodScale, query: typeof stored.query === "string" ? stored.query.slice(0, 200) : "", groupOverviewVersion: stored.groupOverviewVersion === 1 ? 1 : 0, presentation, documentLayoutMode, graphFocusId, graphFocusDepth };
  } catch { return fallback; }
}

function publicDocumentView(location: MapLocation, canvas: { width: number; height: number }) {
  const options = { filters: location.filters, selectedId: location.graphFocusId ?? location.selectedId };
  const loaded = visiblePublicGraph(location.graph, options);
  const ids = location.graphFocusId
    ? getGraphNeighborhoodIds(loaded.topics.map((topic) => topic.id), loaded.relations, location.graphFocusId, location.graphFocusDepth)
    : new Set(loaded.topics.map((topic) => topic.id));
  const topics = loaded.topics.filter((topic) => ids.has(topic.id));
  const relations = loaded.relations.filter((relation) => ids.has(relation.sourceId) && ids.has(relation.targetId));
  const layout = layoutDocumentMap(publicMapNodePlacements(location.graph, options).filter((node) => ids.has(node.conversationId)), canvas,
    { mode: location.documentLayoutMode, connections: relations, centerNodeId: location.graphFocusId ?? undefined });
  return { ...layout, topics, relations };
}

function safeSourceUrl(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "www.wikidata.org" || /(^|\.)wikipedia\.org$/.test(url.hostname)) ? url.href : undefined;
  } catch { return undefined; }
}

function messageForError(error: unknown) {
  return error instanceof Error ? error.message : "This topic could not be loaded. Please try again.";
}

export function PublicKnowledgeMap({ isVisible = true, explorerContainer, onOpenExplorer, onFocusCanvas, workspaceKey, focusRequest, searchRequest, onFocusRequestHandled, onSearchRequestHandled, savedTopics, onSave, onShowInMyMap }: PublicKnowledgeMapProps) {
  const [location, setLocation] = useState<MapLocation>(() => readLocation(workspaceKey));
  const locationRef = useRef(location);
  locationRef.current = location;
  const [searchResults, setSearchResults] = useState<PublicTopic[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchRevision, setSearchRevision] = useState(0);
  const [loadingTopics, setLoadingTopics] = useState<string[]>([]);
  const [topicError, setTopicError] = useState<TopicError | null>(null);
  const [notice, setNotice] = useState("");
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [showRelations, setShowRelations] = useState(false);
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [detailsCollapsed, setDetailsCollapsed] = useState(false);
  const [detailsWidth, setDetailsWidth] = useState(340);
  const [detailsMaxWidth, setDetailsMaxWidth] = useState(560);
  const [history, setHistory] = useState<{ past: MapLocation[]; future: MapLocation[] }>({ past: [], future: [] });
  const historyRef = useRef(history);
  const fitAfterClosingDetails = useRef(false);
  const resizeStart = useRef<{ x: number; width: number } | null>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const [searchResultsOpen, setSearchResultsOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const sidebarScrollRef = useRef<HTMLDivElement>(null);
  const searchFormRef = useRef<HTMLFormElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const explorerTriggerRef = useRef<HTMLButtonElement>(null);
  const openController = useRef<AbortController | null>(null);
  const expansionControllers = useRef(new Map<string, AbortController>());
  const handledFocus = useRef<number | null>(null);
  const handledSearch = useRef<number | null>(null);
  const pointer = useRef<{ id: number; x: number; y: number; viewport: Viewport; moved: boolean; territoryId?: string } | null>(null);
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ x: number; y: number; distance: number; viewport: Viewport } | null>(null);
  const suppressTap = useRef(false);
  const documentsOnly = location.presentation === "documents";
  const visibilityOptions = useMemo(() => ({ filters: location.filters, selectedId: location.graphFocusId ?? location.selectedId }), [location.filters, location.selectedId, location.graphFocusId]);
  const filteredVisible = useMemo(() => visiblePublicGraph(location.graph, visibilityOptions), [location.graph, visibilityOptions]);
  const documentLayout = useMemo(() => documentsOnly ? publicDocumentView(location,
    viewportSize.width && viewportSize.height ? viewportSize : { width: 1000, height: 700 }) : null,
    [documentsOnly, location.graph, location.filters, location.selectedId, location.graphFocusId, location.graphFocusDepth, location.documentLayoutMode, viewportSize]);
  const visible = documentLayout ?? filteredVisible;
  const unfiltered = useMemo(() => visiblePublicGraph(location.graph), [location.graph]);
  const hiddenTopicCount = unfiltered.topics.length - filteredVisible.topics.length;
  const neighborhoods = useMemo(() => publicMapNeighborhoods(location.graph, visibilityOptions), [location.graph, visibilityOptions]);
  const neutralNeighborhoods = useMemo(() => publicMapNeighborhoods(location.graph, { filters: location.filters }), [location.graph, location.filters]);
  const minimumZoomScale = useMemo(() => {
    const points = Object.keys(location.graph.topics).map((id) => location.graph.positions[id]);
    if (!points.length) return 0.02;
    const width = Math.max(...points.map((point) => point.x)) - Math.min(...points.map((point) => point.x)) + PUBLIC_NODE_WIDTH;
    const height = Math.max(...points.map((point) => point.y)) - Math.min(...points.map((point) => point.y)) + PUBLIC_NODE_HEIGHT;
    // Keep zoom-out available independently of the overview
    // camera, the inspector size, and reversible relationship filters.
    return Math.max(Number.EPSILON, Math.min(0.02, 1 / (Math.max(1, width, height) * 1024)));
  }, [location.graph.positions, location.graph.topics]);
  const activeNeighborhood = !documentsOnly ? neutralNeighborhoods.territories.find((territory) => territory.id === location.neighborhoodId) : undefined;
  const focusedLayout = useMemo(() => activeNeighborhood ? layoutFocusedMapTerritory(activeNeighborhood,
    viewportSize.width && viewportSize.height ? viewportSize : { width: 1000, height: 700 }, { padding: 64 }) : null,
    [activeNeighborhood, viewportSize]);
  const showNeighborhoods = location.presentation === "groups" && !activeNeighborhood;
  const overviewLayout = useMemo(() => showNeighborhoods ? layoutMapTerritoryOverview(neutralNeighborhoods.territories,
    { x: 0, y: 0, scale: location.viewport.scale }, viewportSize.width || 1000) : [],
  [showNeighborhoods, neutralNeighborhoods.territories, location.viewport.scale, viewportSize.width]);
  const overviewFootprints = useMemo(() => new Map(overviewLayout.flatMap((territory) => territory.contentsVisible
    ? territory.displayNodes.map((node) => [node.conversationId, territory.nodeFootprint] as const) : [])), [overviewLayout]);
  const compactNeighborhood = !!activeNeighborhood && (location.viewport.scale < 0.7 || !!focusedLayout?.arranged);
  const compactFootprint = focusedLayout?.arranged ? focusedLayout.nodeFootprint! : OVERVIEW_NODE_FOOTPRINT;
  const placements = useMemo(() => documentLayout ? documentLayout.nodes : focusedLayout ? focusedLayout.territory.nodes : showNeighborhoods
    ? overviewLayout.flatMap((territory) => territory.contentsVisible ? territory.displayNodes : [])
    : publicMapNodePlacements(location.graph, visibilityOptions), [documentLayout, location.graph, visibilityOptions, focusedLayout, showNeighborhoods, overviewLayout]);
  const displayTerritories = focusedLayout ? [focusedLayout.territory] : showNeighborhoods ? neutralNeighborhoods.territories : neighborhoods.territories;
  const placementById = useMemo(() => Object.fromEntries(placements.map((placement) => [placement.conversationId, placement])), [placements]);
  const renderedBoundsById = useMemo(() => Object.fromEntries(placements.map((placement) => {
    const selected = placement.conversationId === location.selectedId;
    const footprint = documentsOnly ? getDocumentNodeFootprint(location.viewport.scale)
      : overviewFootprints.get(placement.conversationId) ?? (compactNeighborhood ? compactFootprint : undefined);
    // Cards retain readable screen sizes in grouped views. Route in world
    // coordinates using that displayed rectangle, including selection growth.
    const factor = footprint ? 1 / location.viewport.scale : readableNodeSize(location.viewport.scale, selected);
    const width = (footprint?.width ?? placement.width) * factor;
    const height = (footprint?.height ?? (selected ? placement.height : 96)) * factor;
    return [placement.conversationId, { x: placement.x + (placement.width - width) / 2,
      y: placement.y + (placement.height - height) / 2, width, height }];
  })), [placements, location.selectedId, location.viewport.scale, documentsOnly, overviewFootprints, compactNeighborhood, compactFootprint]);
  const selected = location.selectedId ? location.graph.topics[location.selectedId] : null;
  const selectedExpansion = selected ? location.graph.expansions[selected.id] : null;
  const selectedRelations = selected ? visible.relations.filter((relation) => relation.sourceId === selected.id || relation.targetId === selected.id) : [];
  const moreFocusIds = location.graphFocusId ? getGraphNeighborhoodIds(filteredVisible.topics.map((topic) => topic.id), filteredVisible.relations, location.graphFocusId, location.graphFocusDepth + 1) : null;
  const canShowMoreFocus = !!moreFocusIds && moreFocusIds.size > visible.topics.length;

  const updateLocation = useCallback((update: (previous: MapLocation) => MapLocation) => {
    const next = update(locationRef.current);
    locationRef.current = next;
    setLocation(next);
  }, []);
  const refitDocumentLocation = useCallback((next: MapLocation): MapLocation => {
    if (next.presentation !== "documents") return next;
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect?.width || !rect.height) return next;
    return { ...next, viewport: publicDocumentView(next, rect).viewport };
  }, []);
  useEffect(() => {
    if (!isVisible || !viewportSize.width || !viewportSize.height || location.groupOverviewVersion === 1) return;
    updateLocation((previous) => ({ ...previous, groupOverviewVersion: 1,
      ...(showNeighborhoods ? { viewport: fitMapTerritoryOverview(neighborhoods.territories, viewportSize, { padding: 64 }) } : {}) }));
  }, [isVisible, viewportSize, location.groupOverviewVersion, showNeighborhoods, neighborhoods.territories, updateLocation]);
  useEffect(() => {
    if (!isVisible || !focusedLayout?.arranged || !location.neighborhoodScale || Math.abs(location.neighborhoodScale - focusedLayout.viewport.scale) < 0.000001) return;
    updateLocation((previous) => ({ ...previous, viewport: focusedLayout.viewport, neighborhoodScale: focusedLayout.viewport.scale }));
  }, [isVisible, focusedLayout, location.neighborhoodScale, updateLocation]);
  const navigate = useCallback((update: (previous: MapLocation) => MapLocation) => {
    const previous = locationRef.current;
    const next = update(previous);
    const trail = { past: [...historyRef.current.past, previous].slice(-30), future: [] };
    historyRef.current = trail;
    setHistory(trail);
    updateLocation(() => next);
  }, [updateLocation]);
  function restoreHistory(direction: "back" | "forward") {
    const trail = historyRef.current;
    const stack = direction === "back" ? trail.past : trail.future;
    const next = stack.at(-1);
    if (!next) return;
    openController.current?.abort();
    for (const controller of expansionControllers.current.values()) controller.abort();
    expansionControllers.current.clear();
    setOpeningId(null); setLoadingTopics([]); setTopicError(null); setNotice(""); setSearchResultsOpen(false);
    const restored = direction === "back"
      ? { past: trail.past.slice(0, -1), future: [...trail.future, locationRef.current] }
      : { past: [...trail.past, locationRef.current], future: trail.future.slice(0, -1) };
    historyRef.current = restored;
    setHistory(restored);
    updateLocation(() => next);
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try { sessionStorage.setItem(`margin-public-map:${workspaceKey}`, JSON.stringify({ version: 1, ...location })); }
      catch { /* The map remains usable when browser session storage is full or unavailable. */ }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [location, workspaceKey]);

  useEffect(() => () => {
    openController.current?.abort();
    for (const controller of expansionControllers.current.values()) controller.abort();
  }, []);

  useEffect(() => {
    const query = location.query.trim();
    const controller = new AbortController();
    setSearchError(null);
    if (query.length < 2) { setSearchResults([]); setSearchLoading(false); return; }
    setSearchLoading(true);
    const timer = window.setTimeout(() => {
      void searchPublicTopics(query, controller.signal).then((results) => {
        if (!controller.signal.aborted) setSearchResults(results);
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) { setSearchResults([]); setSearchError(messageForError(error)); }
      }).finally(() => { if (!controller.signal.aborted) setSearchLoading(false); });
    }, 300);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [location.query, searchRevision]);

  useEffect(() => { if (sidebarScrollRef.current) sidebarScrollRef.current.scrollTop = 0; }, [location.selectedId, location.query]);
  useEffect(() => {
    if (explorerOpen && isVisible) sidebarScrollRef.current?.focus({ preventScroll: true });
  }, [explorerOpen, isVisible]);

  const centeredViewport = useCallback((graph: PublicGraphState, id: string, previous: Viewport, useFocusedLayout = true): Viewport => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect || rect.width < 1) return previous;
    if (useFocusedLayout && locationRef.current.presentation === "documents") {
      const layout = publicDocumentView({ ...locationRef.current, graph }, rect);
      if (locationRef.current.graphFocusId) return layout.viewport;
      const point = layout.nodes.find((node) => node.conversationId === id);
      return point ? { ...previous, x: rect.width / 2 - (point.x + point.width / 2) * previous.scale,
        y: rect.height / 2 - (point.y + point.height / 2) * previous.scale } : previous;
    }
    const territory = useFocusedLayout ? publicMapNeighborhoods(graph, { filters: locationRef.current.filters }).territories.find((item) => item.id === locationRef.current.neighborhoodId) : undefined;
    const layout = territory ? layoutFocusedMapTerritory(territory, rect, { padding: 64 }) : null;
    const groupedBrowse = useFocusedLayout && !territory && locationRef.current.presentation === "groups";
    const displayScale = groupedBrowse ? Math.max(0.75, previous.scale) : previous.scale;
    const overview = groupedBrowse
      ? layoutMapTerritoryOverview(publicMapNeighborhoods(graph, { filters: locationRef.current.filters }).territories,
        { x: 0, y: 0, scale: displayScale }, rect.width) : [];
    const displayed = layout?.arranged ? layout.territory.nodes.find((node) => node.conversationId === id)
      : overview.flatMap((item) => item.displayNodes).find((node) => node.conversationId === id);
    if (displayed) return { scale: displayScale, x: rect.width / 2 - (displayed.x + displayed.width / 2) * displayScale,
      y: rect.height / 2 - (displayed.y + displayed.height / 2) * displayScale };
    const point = graph.positions[id];
    if (!point) return previous;
    const scale = Math.max(0.85, Math.min(previous.scale, 1));
    return { scale, x: rect.width / 2 - (point.x + 124) * scale, y: rect.height / 2 - (point.y + 76) * scale };
  }, []);
  const revealTopicViewport = useCallback((graph: PublicGraphState, id: string, previous: Viewport): Viewport => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (locationRef.current.presentation === "documents" && rect) {
      const point = publicDocumentView({ ...locationRef.current, graph }, rect).nodes.find((node) => node.conversationId === id);
      if (!point) return previous;
      const footprint = getDocumentNodeFootprint(previous.scale);
      const x = previous.x + (point.x + point.width / 2) * previous.scale;
      const y = previous.y + (point.y + point.height / 2) * previous.scale;
      const nextX = Math.max(footprint.width / 2 + 16, Math.min(x, rect.width - footprint.width / 2 - 16));
      const nextY = Math.max(footprint.height / 2 + 64, Math.min(y, rect.height - footprint.height / 2 - 80));
      return { ...previous, x: previous.x + (nextX - x), y: previous.y + (nextY - y) };
    }
    const territory = publicMapNeighborhoods(graph, { filters: locationRef.current.filters }).territories.find((item) => item.id === locationRef.current.neighborhoodId);
    const layout = territory && rect ? layoutFocusedMapTerritory(territory, rect, { padding: 64 }) : null;
    const overview = !territory && rect && locationRef.current.presentation === "groups"
      ? layoutMapTerritoryOverview(publicMapNeighborhoods(graph, { filters: locationRef.current.filters }).territories,
        { x: 0, y: 0, scale: previous.scale }, rect.width) : [];
    const packed = overview.find((item) => item.displayNodes.some((node) => node.conversationId === id));
    if (!territory && locationRef.current.presentation === "groups" && !packed) return previous;
    const point = (packed?.displayNodes ?? (layout?.arranged ? layout.territory.nodes : publicMapNodePlacements(graph, { filters: locationRef.current.filters, selectedId: id }))).find((node) => node.conversationId === id);
    if (!rect || !point || rect.width < 1 || rect.height < 1) return previous;
    const x = previous.x + (point.x + point.width / 2) * previous.scale;
    const y = previous.y + (point.y + point.height / 2) * previous.scale;
    const compact = !!locationRef.current.neighborhoodId && (previous.scale < 0.7 || !!layout?.arranged);
    const footprint = packed?.nodeFootprint ?? (compact ? layout?.nodeFootprint ?? OVERVIEW_NODE_FOOTPRINT : undefined);
    const width = footprint?.width ?? point.width;
    const height = footprint?.height ?? point.height;
    const clampCenter = (value: number, min: number, max: number, size: number) => min > max ? size / 2 : Math.max(min, Math.min(value, max));
    const nextX = clampCenter(x, width / 2 + 16, rect.width - width / 2 - 16, rect.width);
    const nextY = clampCenter(y, height / 2 + 64, rect.height - height / 2 - 80, rect.height);
    return { ...previous, x: previous.x + (nextX - x), y: previous.y + (nextY - y) };
  }, []);
  const centerAfterResize = useEffectEvent((resized: boolean, previousSize: { width: number; height: number }) => {
    const current = locationRef.current;
    if (resized && current.presentation === "documents") {
      updateLocation(refitDocumentLocation);
    } else if (current.selectedId) {
      updateLocation((previous) => ({ ...previous, viewport: revealTopicViewport(previous.graph, previous.selectedId!, previous.viewport) }));
    } else if (resized && !current.neighborhoodId && current.presentation === "groups") {
      const rect = viewportRef.current?.getBoundingClientRect();
      if (rect) updateLocation((previous) => ({ ...previous, viewport: !overviewFootprints.size
        ? fitMapTerritoryOverview(publicMapNeighborhoods(previous.graph, { filters: previous.filters }).territories, rect, { padding: 64 })
        : { ...previous.viewport, x: previous.viewport.x + (rect.width - previousSize.width) / 2,
          y: previous.viewport.y + (rect.height - previousSize.height) / 2 } }));
    }
  });
  const focusedCanvasSizeRef = useRef<{ id: string; width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const previous = focusedCanvasSizeRef.current;
    focusedCanvasSizeRef.current = location.neighborhoodId ? { id: location.neighborhoodId, ...viewportSize } : null;
    if (!previous?.width || !previous.height || previous.id !== location.neighborhoodId
      || (previous.width === viewportSize.width && previous.height === viewportSize.height)) return;
    if (!isVisible || !focusedLayout?.arranged) return;
    updateLocation((previous) => ({ ...previous, viewport: previous.selectedId
      ? revealTopicViewport(previous.graph, previous.selectedId, previous.viewport) : focusedLayout.viewport }));
  }, [location.neighborhoodId, viewportSize, focusedLayout, isVisible, updateLocation, revealTopicViewport]);
  useEffect(() => {
    const element = viewportRef.current;
    if (!element || !isVisible || typeof ResizeObserver === "undefined") return;
    let previous = element.getBoundingClientRect();
    setViewportSize({ width: previous.width, height: previous.height });
    const observer = new ResizeObserver(() => {
      const next = element.getBoundingClientRect();
      if (next.width !== previous.width || next.height !== previous.height) setViewportSize({ width: next.width, height: next.height });
      const maximum = Math.max(260, Math.min(560, (mapRef.current?.clientWidth ?? 1120) * 0.5));
      setDetailsMaxWidth(maximum);
      setDetailsWidth((width) => Math.min(width, maximum));
      if (next.width !== previous.width || next.height !== previous.height || next.left !== previous.left || next.top !== previous.top) centerAfterResize(next.width !== previous.width || next.height !== previous.height, previous);
      previous = next;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [isVisible]);

  const expandTopic = useCallback(async (id: string, more = false, recordHistory = true) => {
    const accept = recordHistory ? navigate : updateLocation;
    const existing = locationRef.current.graph.expansions[id];
    if (existing && !more) {
      accept((previous) => refitDocumentLocation({ ...previous, graph: setPublicExpansionVisible(previous.graph, id, true) }));
      setNotice("Expansion shown.");
      return;
    }
    if (expansionControllers.current.has(id)) return;
    if (visiblePublicGraph(locationRef.current.graph).topics.length >= PUBLIC_MAP_LIMIT) {
      setNotice("Hide an expansion before adding more topics to this view.");
      return;
    }
    const controller = new AbortController();
    expansionControllers.current.set(id, controller);
    setLoadingTopics((previous) => [...previous, id]);
    setTopicError(null);
    try {
      const result = await expandPublicTopic(id, more ? existing?.nextOffset ?? 0 : 0, controller.signal);
      if (controller.signal.aborted) return;
      accept((previous) => refitDocumentLocation({ ...previous, graph: appendPublicGraphExpansion(previous.graph, result) }));
      setNotice(result.topics.length ? `${result.topics.length} connections loaded. Filters control which topics are shown.` : "No additional direct topic connections were found.");
    } catch (error) {
      if (!controller.signal.aborted) setTopicError({ id, action: "expand", message: messageForError(error) });
    } finally {
      if (expansionControllers.current.get(id) === controller) expansionControllers.current.delete(id);
      if (!controller.signal.aborted) setLoadingTopics((previous) => previous.filter((topicId) => topicId !== id));
    }
  }, [navigate, updateLocation, refitDocumentLocation]);

  const openTopic = useCallback(async (id: string, expand = true) => {
    openController.current?.abort();
    const controller = new AbortController();
    openController.current = controller;
    setOpeningId(id);
    setTopicError(null);
    try {
      const topic = await getPublicTopic(id, controller.signal);
      if (controller.signal.aborted) return;
      const alreadyVisible = visiblePublicGraph(locationRef.current.graph).topics.some((item) => item.id === topic.id);
      navigate((previous) => {
        const graph = alreadyVisible ? { ...previous.graph, topics: { ...previous.graph.topics, [topic.id]: topic } } : addPublicGraphRoot(previous.graph, topic);
        return refitDocumentLocation({ ...previous, graph, selectedId: topic.id, graphFocusId: null, graphFocusDepth: 1, neighborhoodId: null, neighborhoodScale: null, presentation: previous.presentation === "documents" ? "documents" : "canvas", viewport: centeredViewport(graph, topic.id, previous.viewport, false), query: "" });
      });
      if (expand && !alreadyVisible) await expandTopic(topic.id, false, false);
    } catch (error) {
      if (!controller.signal.aborted) setTopicError({ id, action: "open", message: messageForError(error) });
    } finally { if (!controller.signal.aborted) setOpeningId(null); }
  }, [centeredViewport, expandTopic, navigate, refitDocumentLocation]);

  useEffect(() => {
    if (!focusRequest || handledFocus.current === focusRequest.requestId) return;
    handledFocus.current = focusRequest.requestId;
    void openTopic(focusRequest.id).finally(() => onFocusRequestHandled(focusRequest.requestId));
  }, [focusRequest, onFocusRequestHandled, openTopic]);

  useEffect(() => {
    if (!searchRequest || handledSearch.current === searchRequest.requestId) return;
    handledSearch.current = searchRequest.requestId;
    updateLocation((previous) => ({ ...previous, query: searchRequest.query }));
    setSearchResultsOpen(true);
    setSearchRevision((previous) => previous + 1);
    onSearchRequestHandled(searchRequest.requestId);
  }, [searchRequest, onSearchRequestHandled, updateLocation]);

  const applyManualViewport = useCallback((viewport: Viewport) => {
    const previous = locationRef.current;
    const returnToAtlas = viewport.scale < previous.viewport.scale && (previous.neighborhoodId && previous.neighborhoodScale
      ? viewport.scale < previous.neighborhoodScale * 0.8 : previous.presentation === "canvas" && previous.viewport.scale >= 0.7 && viewport.scale < 0.7);
    let nextViewport = viewport;
    if (returnToAtlas) {
      const rect = viewportRef.current?.getBoundingClientRect();
      if (rect) nextViewport = fitMapTerritoryOverview(publicMapNeighborhoods(previous.graph, { filters: previous.filters }).territories,
        rect, { maxScale: 0.65, padding: 64 });
      fitAfterClosingDetails.current = explorerOpen;
      setExplorerOpen(false); setSearchResultsOpen(false);
    }
    updateLocation(() => ({ ...previous, viewport: nextViewport, ...(returnToAtlas ? { neighborhoodId: null, neighborhoodScale: null, selectedId: null, presentation: "groups" as const } : {}) }));
  }, [updateLocation, explorerOpen]);

  const zoomAt = useCallback((factor: number, x?: number, y?: number) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    const previous = locationRef.current.viewport;
    const scale = Math.max(minimumZoomScale, Math.min(1.6, previous.scale * factor));
    const ratio = scale / previous.scale;
    const pointX = x ?? (rect?.width ?? 600) / 2;
    const pointY = y ?? (rect?.height ?? 500) / 2;
    applyManualViewport({ scale, x: pointX - (pointX - previous.x) * ratio, y: pointY - (pointY - previous.y) * ratio });
  }, [applyManualViewport, minimumZoomScale]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if ((event.target as HTMLElement).closest('.public-map-zoom')) return;
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        const rect = element.getBoundingClientRect();
        zoomAt(Math.exp(-event.deltaY * 0.008), event.clientX - rect.left, event.clientY - rect.top);
      } else {
        updateLocation((previous) => ({ ...previous, viewport: { ...previous.viewport, x: previous.viewport.x - event.deltaX, y: previous.viewport.y - event.deltaY } }));
      }
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [updateLocation, zoomAt]);

  const focusConnections = (id: string, depth = 1, mode: DocumentLayoutMode = "connections") => {
    openController.current?.abort();
    setOpeningId(null); setSearchResultsOpen(false);
    navigate((previous) => refitDocumentLocation({ ...previous, selectedId: id, graphFocusId: id, graphFocusDepth: depth,
      neighborhoodId: null, neighborhoodScale: null, presentation: "documents", documentLayoutMode: mode, query: "" }));
  };
  const chooseDocumentLayout = (mode: DocumentLayoutMode, clearFocus = false) => {
    navigate((previous) => refitDocumentLocation({ ...previous, presentation: "documents", documentLayoutMode: mode,
      neighborhoodId: null, neighborhoodScale: null, ...(clearFocus ? { graphFocusId: null, graphFocusDepth: 1 } : {}) }));
  };
  const selectTopic = (id: string, center = false, keepExplorer = false) => {
    openController.current?.abort();
    setOpeningId(null);
    if (locationRef.current.graphFocusId && !center) {
      focusConnections(id, locationRef.current.graphFocusDepth, locationRef.current.documentLayoutMode);
      return;
    }
    if (locationRef.current.graphFocusId && center && id !== locationRef.current.graphFocusId) {
      focusConnections(id, locationRef.current.graphFocusDepth, locationRef.current.documentLayoutMode);
      return;
    }
    if (!keepExplorer && !explorerOpen) onFocusCanvas?.();
    const accept = center && locationRef.current.selectedId === id ? updateLocation : navigate;
    const leavingGroup = !!activeNeighborhood && !activeNeighborhood.nodes.some((node) => node.conversationId === id);
    const useAuthoredCanvas = leavingGroup || (showNeighborhoods && !placementById[id] && !(center && locationRef.current.selectedId === id));
    accept((previous) => {
      const selectedId = previous.selectedId === id && !center && !((documentsOnly || compactNeighborhood || showNeighborhoods) && !explorerOpen) ? null : id;
      return { ...previous, selectedId, query: "",
        ...(useAuthoredCanvas ? { neighborhoodId: null, neighborhoodScale: null, presentation: "canvas" as const } : {}),
        viewport: selectedId ? useAuthoredCanvas ? centeredViewport(previous.graph, id, previous.viewport, false)
          : (center ? centeredViewport : revealTopicViewport)(previous.graph, id, previous.viewport) : previous.viewport };
    });
    if (!center && (documentsOnly || compactNeighborhood || showNeighborhoods) && locationRef.current.selectedId) showDetails();
  };

  const savedConversation = (topic: PublicTopic) => savedTopics[topic.id] ?? topic.aliases.map((id) => savedTopics[id]).find(Boolean);
  const saveOrShow = (topic: PublicTopic) => {
    const id = savedConversation(topic);
    if (id) onShowInMyMap(id, topic);
    else {
      onSave(topic);
      setNotice(`${topic.label} added to your map. Keep exploring, or choose Show in my map.`);
    }
  };
  const hideExpansion = (id: string) => {
    expansionControllers.current.get(id)?.abort();
    expansionControllers.current.delete(id);
    setLoadingTopics((previous) => previous.filter((topicId) => topicId !== id));
    navigate((previous) => refitDocumentLocation({ ...previous, graph: setPublicExpansionVisible(previous.graph, id, false), selectedId: id }));
    setNotice("Expansion hidden. Topics reached through other visible branches remain.");
  };
  const fitMap = (allGroups = false) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect || !visible.topics.length) return;
    if (!allGroups && documentsOnly) { updateLocation(refitDocumentLocation); return; }
    const fitOverview = allGroups || showNeighborhoods;
    if (fitOverview) { fitAfterClosingDetails.current = explorerOpen; setExplorerOpen(false); setSearchResultsOpen(false); }
    const accept = allGroups ? navigate : updateLocation;
    accept((previous) => {
      const selectedId = fitOverview ? null : previous.selectedId;
      const mapTerritories = publicMapNeighborhoods(previous.graph, { filters: previous.filters, selectedId }).territories;
      const fittedTerritories = !allGroups && activeNeighborhood ? mapTerritories.filter((territory) => territory.id === activeNeighborhood.id) : mapTerritories;
      let presentation = previous.presentation;
      let viewport = fitOverview ? fitMapTerritoryOverview(fittedTerritories, rect, { maxScale: 0.65, padding: 64 })
        : fitMapTerritories(fittedTerritories, rect, { maxScale: 1, padding: 64, selectedNodeId: selectedId });
      if (!allGroups && activeNeighborhood) viewport = fitFocusedMapTerritory(activeNeighborhood, rect, { maxScale: 1, padding: 64 });
      else if (fitOverview || viewport.scale < 0.7) {
        presentation = "groups";
        viewport = fitMapTerritoryOverview(fittedTerritories, rect, { maxScale: 0.65, padding: 64 });
      }
      return { ...previous, selectedId, neighborhoodId: allGroups ? null : previous.neighborhoodId,
        neighborhoodScale: allGroups ? null : activeNeighborhood ? viewport.scale : previous.neighborhoodScale,
        ...(allGroups ? { graphFocusId: null, graphFocusDepth: 1 } : {}), presentation, viewport };
    });
  };
  const showAllGroups = () => fitMap(true);
  useLayoutEffect(() => {
    if (explorerOpen || !fitAfterClosingDetails.current) return;
    fitAfterClosingDetails.current = false;
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    updateLocation((previous) => ({ ...previous, viewport: fitMapTerritoryOverview(
      publicMapNeighborhoods(previous.graph, { filters: previous.filters }).territories,
      rect, { maxScale: 0.65, padding: 64 },
    ) }));
  }, [explorerOpen, updateLocation]);
  const openNeighborhood = (territory: MapTerritory) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    openController.current?.abort();
    setOpeningId(null);
    setSearchResultsOpen(false);
    const neutralTerritory = publicMapNeighborhoods(locationRef.current.graph, { filters: locationRef.current.filters }).territories.find((item) => item.id === territory.id) ?? territory;
    const viewport = fitFocusedMapTerritory(neutralTerritory, rect, { maxScale: 1.15, padding: 64 });
    navigate((previous) => ({ ...previous, selectedId: null, graphFocusId: null, graphFocusDepth: 1, neighborhoodId: territory.id, neighborhoodScale: viewport.scale, query: "", presentation: "groups", viewport }));
  };
  const startPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('[data-graph-ui="true"]')) return;
    if (event.pointerType === "touch" && !(event.target as HTMLElement).closest(".public-map-context, .public-map-bottom, .public-map-feedback")) {
      if (!touches.current.has(event.pointerId) && touches.current.size >= 2) return;
      if (!touches.current.size) suppressTap.current = false;
      touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touches.current.size === 2) {
        const [a, b] = [...touches.current.values()];
        const rect = event.currentTarget.getBoundingClientRect();
        pinch.current = { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top, distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), viewport: locationRef.current.viewport };
        for (const id of touches.current.keys()) event.currentTarget.setPointerCapture(id);
        pointer.current = null; suppressTap.current = true; setDragging(true); event.preventDefault();
        return;
      }
      if (touches.current.size > 2) return;
    }
    if (event.button !== 0 || (event.target as HTMLElement).closest("button, a, input, .public-map-node, label")) return;
    suppressTap.current = false;
    const territoryId = showNeighborhoods ? (event.target as HTMLElement).closest<HTMLElement>(".graph-territory-region")?.dataset.territoryId : undefined;
    pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY, viewport: locationRef.current.viewport, moved: false, territoryId };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const movePan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (touches.current.has(event.pointerId)) touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch.current && touches.current.size >= 2) {
      const [a, b] = [...touches.current.values()];
      const start = pinch.current;
      const rect = event.currentTarget.getBoundingClientRect();
      const scale = Math.max(minimumZoomScale, Math.min(1.6, start.viewport.scale * Math.hypot(a.x - b.x, a.y - b.y) / start.distance));
      const ratio = scale / start.viewport.scale;
      applyManualViewport({ scale, x: (a.x + b.x) / 2 - rect.left - (start.x - start.viewport.x) * ratio, y: (a.y + b.y) / 2 - rect.top - (start.y - start.viewport.y) * ratio });
      event.preventDefault();
      return;
    }
    const active = pointer.current;
    if (!active || active.id !== event.pointerId) return;
    const dx = event.clientX - active.x;
    const dy = event.clientY - active.y;
    if (Math.abs(dx) + Math.abs(dy) > 5) { active.moved = true; suppressTap.current = true; setDragging(true); }
    if (active.moved) updateLocation((previous) => ({ ...previous, viewport: { ...active.viewport, x: active.viewport.x + dx, y: active.viewport.y + dy } }));
  };
  const stopPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const trackedTouch = touches.current.delete(event.pointerId);
    if (event.pointerType === "touch" && !trackedTouch && pointer.current?.id !== event.pointerId) return;
    if (pinch.current) {
      pinch.current = null;
      const remaining = [...touches.current.entries()][0];
      pointer.current = remaining ? { id: remaining[0], ...remaining[1], viewport: locationRef.current.viewport, moved: true } : null;
      setDragging(Boolean(remaining));
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
    if (pointer.current?.id !== event.pointerId) return;
    if (!pointer.current.moved) {
      const territory = pointer.current.territoryId ? neighborhoods.territories.find((item) => item.id === pointer.current?.territoryId) : undefined;
      if (territory) openNeighborhood(territory);
      else updateLocation((previous) => ({ ...previous, selectedId: null }));
    }
    pointer.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  function openExplorer() {
    setSearchResultsOpen(false);
    setDetailsCollapsed(false);
    if (explorerContainer && onOpenExplorer) { setExplorerOpen(false); onOpenExplorer(); }
    else setExplorerOpen((open) => !open);
  }
  function showDetails() {
    updateLocation((previous) => ({ ...previous, query: "" }));
    setSearchResultsOpen(false);
    setDetailsCollapsed(false);
    setExplorerOpen(true);
  }
  function closeExplorer() {
    setExplorerOpen(false);
    explorerTriggerRef.current?.focus({ preventScroll: true });
  }
  function resizeDetails(width: number) {
    setDetailsWidth(Math.max(260, Math.min(width, Math.min(560, (mapRef.current?.clientWidth ?? 1100) * 0.5))));
  }
  function cancelPan() {
    const captured = new Set([...touches.current.keys(), ...(pointer.current ? [pointer.current.id] : [])]);
    pointer.current = null; pinch.current = null; touches.current.clear(); setDragging(false);
    for (const id of captured) if (viewportRef.current?.hasPointerCapture(id)) viewportRef.current.releasePointerCapture(id);
  }
  useEffect(() => { if (!isVisible) cancelPan(); }, [isVisible]);
  function revealFocusedElement(element: HTMLElement) {
    if (!element.matches(":focus-visible")) return;
    const canvas = viewportRef.current?.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    if (!canvas) return;
    const dx = rect.left < canvas.left + 16 ? canvas.left + 16 - rect.left : rect.right > canvas.right - 16 ? canvas.right - 16 - rect.right : 0;
    const dy = rect.top < canvas.top + 56 ? canvas.top + 56 - rect.top : rect.bottom > canvas.bottom - 80 ? canvas.bottom - 80 - rect.bottom : 0;
    if (dx || dy) updateLocation((previous) => ({ ...previous, viewport: { ...previous.viewport, x: previous.viewport.x + dx, y: previous.viewport.y + dy } }));
  }
  function focusAdjacentTopic(id: string, key: string) {
    const origin = placementById[id];
    const horizontal = key === "ArrowLeft" || key === "ArrowRight";
    const direction = key === "ArrowLeft" || key === "ArrowUp" ? -1 : 1;
    const next = placements.filter((node) => node.conversationId !== id).map((node) => {
      const dx = node.x + node.width / 2 - origin.x - origin.width / 2;
      const dy = node.y + node.height / 2 - origin.y - origin.height / 2;
      return { node, forward: (horizontal ? dx : dy) * direction, cross: Math.abs(horizontal ? dy : dx) };
    }).filter((item) => item.forward > 0).sort((a, b) => a.forward + a.cross * 2 - b.forward - b.cross * 2)[0];
    if (next) viewportRef.current?.querySelector<HTMLButtonElement>(`[data-topic-id="${next.node.conversationId}"]`)?.focus({ preventScroll: true });
  }
  const explorer = <aside hidden={!isVisible} className="public-map-sidebar" aria-label="Public topic explorer">
      <header className="public-map-heading"><span className="public-map-eyebrow">Public knowledge</span><h2>Follow your curiosity</h2><p>Explore connected topics. Keep the ones that matter in your map.</p></header>
      <div className="public-map-sidebar-scroll" ref={sidebarScrollRef} tabIndex={0} aria-label="Public topic results and details">
        {location.query.trim().length >= 2 ? <section aria-label="Public search results">
          <div className="public-map-section-label">{searchLoading ? "Searching Wikidata…" : `${searchResults.length} public topics`}</div>
          {searchError && <div className="public-map-error" role="alert"><p>{searchError}</p><button type="button" onClick={() => setSearchRevision((previous) => previous + 1)}>Try search again</button></div>}
          {!searchLoading && !searchError && !searchResults.length && <p className="public-map-muted">No topics found. Try a broader term or a different name.</p>}
          <ul className="public-map-results" aria-busy={searchLoading}>{!searchLoading && searchResults.map((topic) => <li key={topic.id}><button type="button" onClick={() => void openTopic(topic.id)}><span className="public-map-result-meta">Wikidata · {topic.id}{savedConversation(topic) && <span>In my map</span>}</span><strong>{topic.label}</strong><span>{topic.description || "Open this public topic to explore its connections."}</span></button></li>)}</ul>
        </section> : selected ? <section className="public-map-inspector" aria-label={`Details for ${selected.label}`}>
          <div className="public-map-section-label">Wikidata topic · {selected.id}{savedConversation(selected) && <span className="public-map-saved">In my map</span>}</div>
          <h3>{selected.label}</h3><p>{selected.description || "This topic has no English description yet."}</p>
          <div className="public-map-inspector-actions"><button type="button" className="public-map-primary" onClick={() => saveOrShow(selected)}>{savedConversation(selected) ? "Show in my map" : "Add to my map"}</button><button type="button" onClick={() => focusConnections(selected.id)}>Focus connections</button><button type="button" disabled={loadingTopics.includes(selected.id) || !!selectedExpansion?.visible && !selectedExpansion.hasMore} onClick={() => void expandTopic(selected.id, !!selectedExpansion?.visible)}>{loadingTopics.includes(selected.id) ? "Loading…" : selectedExpansion?.visible ? selectedExpansion.hasMore ? "More connections" : "All connections shown" : "Expand connections"}</button>{selectedExpansion?.visible && <button type="button" onClick={() => hideExpansion(selected.id)}>Hide expansion</button>}</div>
          <p className="public-map-small">Adding keeps this topic and its source links. Your own notes stay yours.</p>
          <div className="public-map-sources"><h4>Read at the source</h4>{safeSourceUrl(selected.wikipediaUrl) && <a href={safeSourceUrl(selected.wikipediaUrl)} target="_blank" rel="noreferrer">Wikipedia ↗</a>}<a href={safeSourceUrl(selected.wikidataUrl) ?? `https://www.wikidata.org/wiki/${selected.id}`} target="_blank" rel="noreferrer">Wikidata ↗</a><span>Wikidata structured data · CC0{selected.retrievedAt && !Number.isNaN(Date.parse(selected.retrievedAt)) ? ` · Retrieved ${new Date(selected.retrievedAt).toLocaleDateString()}` : ""}</span></div>
          <h4>Connections in this view <span>{selectedRelations.length}</span></h4>
          <p className="public-map-small">Wikidata relationships · Dates, qualifiers, and references are available at the source.</p>
          {!selectedRelations.length && <p className="public-map-muted">{selectedExpansion?.visible ? "No connections match these filters. Choose All relationships or include Wikimedia metadata to see more." : "Expand this topic to discover its direct connections."}</p>}
          <ul className="public-map-relations">{selectedRelations.map((relation) => {
            const outbound = relation.sourceId === selected.id;
            const neighbor = location.graph.topics[outbound ? relation.targetId : relation.sourceId];
            return neighbor ? <li key={relation.id}><button type="button" onClick={() => selectTopic(neighbor.id, true, true)}><span>{outbound ? relation.label : `${relation.label} → ${selected.label}`}</span><strong>{neighbor.label}</strong></button><a href={safeSourceUrl(relation.sourceUrl) ?? `https://www.wikidata.org/wiki/${relation.sourceId}`} target="_blank" rel="noreferrer" aria-label={`View source for ${relation.label}`}>↗</a></li> : null;
          })}</ul>
        </section> : <section className="public-map-start"><div className="public-map-section-label">A place to begin</div><p>Choose a topic, then expand one neighborhood at a time.</p><div className="public-map-seeds">{SEEDS.map((seed) => <button type="button" key={seed.id} onClick={() => void openTopic(seed.id)}>{seed.label} <span>↗</span></button>)}</div>{visible.topics.length > 0 && <><h4>Topics in this view <span>{visible.topics.length}</span></h4><ul className="public-map-topic-list">{visible.topics.map((topic) => <li key={topic.id}><button type="button" onClick={() => selectTopic(topic.id, true)}>{topic.label}{savedConversation(topic) && <span>In my map</span>}</button></li>)}</ul></>}<p className="public-map-small">Connections come from Wikidata statements. Expand loads a small group of direct neighbors; it does not import them into your workspace.</p></section>}
      </div>
    </aside>;
  return <div ref={mapRef} className="public-knowledge-map semantic-public-map" style={{ "--public-details-width": `${detailsWidth}px` } as CSSProperties}>
    <header className="public-map-topbar">
      <nav className="public-map-history" aria-label="Public map history">
        <button type="button" aria-label="Back in public map" title="Back in public map" disabled={!history.past.length} onClick={() => restoreHistory("back")}>←</button>
        <button type="button" aria-label="Forward in public map" title="Forward in public map" disabled={!history.future.length} onClick={() => restoreHistory("forward")}>→</button>
      </nav>
      <button type="button" className={`public-map-all-groups${!activeNeighborhood && showNeighborhoods ? " is-active" : ""}`} onClick={showAllGroups} disabled={!visible.topics.length} title="Zoom out to fit every visible group">All groups</button>
      <form className="public-map-search" ref={searchFormRef} onSubmit={(event) => { event.preventDefault(); setSearchResultsOpen(true); setSearchRevision((previous) => previous + 1); }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation(); searchInputRef.current?.focus({ preventScroll: true });
            // Focusing the input opens results, so close them after its focus handler.
            setSearchResultsOpen(false);
          }
          if (!searchResultsOpen || !["ArrowDown", "ArrowUp"].includes(event.key)) return;
          const buttons = [...(searchFormRef.current?.querySelectorAll<HTMLButtonElement>(".graph-map-search-results button") ?? [])];
          if (!buttons.length) return;
          event.preventDefault();
          const current = buttons.indexOf(event.target as HTMLButtonElement);
          const next = current < 0 ? (event.key === "ArrowDown" ? 0 : buttons.length - 1) : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next].focus({ preventScroll: true });
        }}
        onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setSearchResultsOpen(false); }}>
        <label htmlFor="public-topic-search">Search public topics</label>
        <div><input ref={searchInputRef} id="public-topic-search" type="search" value={location.query} maxLength={200} placeholder="Search a topic or Wikidata ID"
          aria-controls={searchResultsOpen && location.query.trim().length >= 2 ? "public-topic-results" : undefined}
          onFocus={() => setSearchResultsOpen(true)} onChange={(event) => { updateLocation((previous) => ({ ...previous, query: event.target.value })); setSearchResultsOpen(true); }}
          autoComplete="off" /><button type="submit" aria-label="Search public topics" disabled={location.query.trim().length < 2}>↵</button></div>
        {searchResultsOpen && location.query.trim().length >= 2 ? <div id="public-topic-results" className="graph-map-search-results" aria-label="Public topic search results" aria-busy={searchLoading}>
          {searchLoading ? <p role="status">Searching public topics…</p> : searchError ? <p role="alert">{searchError}</p> : <>
            {searchResults.slice(0, 5).map((topic) => <button type="button" key={topic.id} onClick={() => { setSearchResultsOpen(false); void openTopic(topic.id); }}><strong>{topic.label}</strong><span>{topic.description}</span></button>)}
            {!searchResults.length ? <p>No matching topics. Try a different name.</p> : null}
          </>}
          <button type="button" onClick={openExplorer}>View all results</button>
        </div> : null}
      </form>
      <button type="button" ref={explorerTriggerRef} aria-expanded={explorerContainer ? undefined : explorerOpen} onClick={openExplorer}>Explore</button>
      <details className="graph-map-view-options" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.querySelector<HTMLElement>("summary")?.focus(); } }}>
        <summary aria-label="Map view options" title="Map view options"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="2" /><circle cx="15" cy="17" r="2" /></svg></summary>
        <div><button type="button" aria-pressed={location.presentation === "groups"} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); showAllGroups(); }}>Groups and topics</button>
          <button type="button" aria-pressed={documentsOnly} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); chooseDocumentLayout(location.documentLayoutMode, true); }}>Topics and connections</button></div>
      </details>
      <details className="public-map-filters" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }}>
        <summary>Filters{location.filters.relation !== "all" || location.filters.includeMetadata ? " •" : ""}</summary>
        <div><label>Relationships<select value={location.filters.relation} onChange={(event) => navigate((previous) => refitDocumentLocation({ ...previous, filters: { ...previous.filters, relation: event.target.value as PublicRelationFilter } }))}>
          <option value="all">All relationships</option><option value="types">Types & categories of ideas</option><option value="parts">Parts & wholes</option><option value="other">Other relationships</option>
        </select></label><label><input type="checkbox" checked={location.filters.includeMetadata} onChange={(event) => navigate((previous) => refitDocumentLocation({ ...previous, filters: { ...previous.filters, includeMetadata: event.target.checked } }))} />Include Wikimedia metadata</label><p>Category pages, portals, and templates are hidden by default. Your loaded topics stay available.</p></div>
      </details>
    </header>
    {location.graphFocusId ? <div className="public-map-focusbar" aria-label="Focused public connections">
      <span><strong>Around {location.graph.topics[location.graphFocusId]?.label}</strong><small>{visible.topics.length} topics · {location.graphFocusDepth} {location.graphFocusDepth === 1 ? "hop" : "hops"}</small></span>
      <button type="button" disabled={!canShowMoreFocus} title={canShowMoreFocus ? "Include the next level of loaded connections" : "All loaded connections in this branch are shown"} onClick={() => focusConnections(location.graphFocusId!, Math.min(PUBLIC_MAP_LIMIT, location.graphFocusDepth + 1), location.documentLayoutMode)}>Show more connections</button>
      <button type="button" onClick={() => chooseDocumentLayout(location.documentLayoutMode, true)}>All nodes</button>
    </div> : null}
    {explorerContainer && !explorerOpen ? createPortal(explorer, explorerContainer) : null}
    <div className="public-map-main">
    <div className={`public-map-viewport${dragging ? " is-panning" : ""}`} ref={viewportRef} role="region" aria-label="Public knowledge graph. Drag to pan, use zoom controls, or select a topic." aria-describedby="public-map-keyboard-help" tabIndex={0} onPointerDown={startPan} onPointerMove={movePan} onPointerUp={stopPan} onPointerCancel={(event) => { if (touches.current.has(event.pointerId) || pointer.current?.id === event.pointerId) cancelPan(); }} onLostPointerCapture={(event) => { if (!event.currentTarget.hasPointerCapture(event.pointerId) && (touches.current.has(event.pointerId) || pointer.current?.id === event.pointerId)) cancelPan(); }} onClickCapture={(event) => { if (suppressTap.current) { event.preventDefault(); event.stopPropagation(); suppressTap.current = false; } }} onKeyDown={(event) => {
      if (event.key === "Escape") { updateLocation((previous) => ({ ...previous, selectedId: null })); return; }
      if (event.target !== event.currentTarget) return;
      const step = event.shiftKey ? 120 : 60;
      const offsets: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
      if (offsets[event.key]) { event.preventDefault(); const [x, y] = offsets[event.key]; updateLocation((previous) => ({ ...previous, viewport: { ...previous.viewport, x: previous.viewport.x + x, y: previous.viewport.y + y } })); }
      if (event.key === "+" || event.key === "=") { event.preventDefault(); zoomAt(1.2); }
      if (event.key === "-") { event.preventDefault(); zoomAt(1 / 1.2); }
      if (event.key === "Home" || event.key === "0") { event.preventDefault(); showAllGroups(); }
    }}>
      <div className="public-map-context"><span>{activeNeighborhood ? <strong>{activeNeighborhood.label} <span aria-hidden="true">· </span></strong> : null}{visible.topics.length ? `${visible.topics.length} topics · ${visible.relations.length} connections${hiddenTopicCount ? ` · ${hiddenTopicCount} filtered` : ""}` : "Your window into public knowledge"}</span><label><input type="checkbox" checked={showRelations} onChange={(event) => setShowRelations(event.target.checked)} />All connection labels</label></div>
      {!visible.topics.length && <div className="public-map-empty"><div aria-hidden="true">✧</div><h2>Every topic opens another door.</h2><p>Search for something you’re curious about, or choose a starting topic.</p><div>{SEEDS.map((seed) => <button type="button" key={seed.id} onClick={() => void openTopic(seed.id)}>{seed.label}</button>)}</div></div>}
      {!documentsOnly ? <GraphTerritoryLayer territories={displayTerritories} conversations={neighborhoods.connections} viewport={location.viewport} itemLabel="topics" mode={showNeighborhoods ? "overview" : "canvas"} activeTerritoryId={activeNeighborhood?.id ?? null} selectedNodeId={location.selectedId} nodeFootprint={showNeighborhoods ? OVERVIEW_NODE_FOOTPRINT : compactNeighborhood ? compactFootprint : undefined} onOpen={openNeighborhood} /> : null}
      <div className="public-map-stage" data-group-layout={focusedLayout?.arranged ? "spaced" : undefined} data-presentation={showNeighborhoods ? "groups" : "canvas"} hidden={showNeighborhoods && !placements.length} style={{ transform: `translate(${location.viewport.x}px, ${location.viewport.y}px) scale(${location.viewport.scale})` }}>
        <svg className="public-map-edges" aria-hidden="true"><defs><marker id="public-map-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>{visible.relations.map((relation) => {
          const source = renderedBoundsById[relation.sourceId]; const target = renderedBoundsById[relation.targetId];
          if (!source || !target || source === target) return null;
          const geometry = documentConnectionGeometry(source, target, documentsOnly ? location.documentLayoutMode : "connections");
          return <g key={relation.id} className={selectedRelations.includes(relation) ? "is-active" : ""}><path d={geometry.path} markerEnd="url(#public-map-arrow)" />{(showRelations || selectedRelations.includes(relation)) && location.viewport.scale >= 0.7 && <text x={geometry.labelX} y={geometry.labelY - 8}>{relation.label}</text>}</g>;
        })}</svg>
        {visible.topics.map((topic) => {
          const placement = placementById[topic.id];
          if (!placement) return null;
          const isSelected = selected?.id === topic.id;
          const expansion = location.graph.expansions[topic.id];
          const loading = loadingTopics.includes(topic.id);
          const saved = savedConversation(topic);
          const overviewFootprint = overviewFootprints.get(topic.id);
          const documentFootprint = documentsOnly ? getDocumentNodeFootprint(location.viewport.scale) : undefined;
          const footprint = documentFootprint ?? overviewFootprint ?? (compactNeighborhood ? compactFootprint : undefined);
          const nodeWidth = footprint?.width ?? placement.width;
          const nodeHeight = footprint?.height ?? (isSelected ? placement.height : 96);
          return <article key={topic.id} onFocusCapture={(event) => revealFocusedElement(event.target as HTMLElement)} className={`public-map-node${isSelected ? " is-selected" : ""}${saved ? " is-saved" : ""}${footprint ? " is-compact" : ""}${documentsOnly ? " is-document" : ""}${focusedLayout?.arranged ? " is-group-spread" : ""}`} style={{ left: placement.x + (placement.width - nodeWidth) / 2, top: placement.y + (placement.height - nodeHeight) / 2, width: nodeWidth, height: nodeHeight, transform: `scale(${footprint ? 1 / location.viewport.scale : readableNodeSize(location.viewport.scale, isSelected)})`, transformOrigin: "center", "--map-card-title-size": documentFootprint ? `${documentFootprint.titleFontSize}px` : overviewFootprint ? `${overviewFootprint.titleFontSize}px` : undefined, "--map-card-title-lines": documentFootprint?.titleLines ?? overviewFootprint?.titleLines } as CSSProperties} aria-label={`${topic.label}${saved ? ", in my map" : ""}`}>
            <button type="button" className="public-map-node-body" data-topic-id={topic.id} aria-pressed={isSelected} onKeyDown={(event) => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); focusAdjacentTopic(topic.id, event.key); } }} onClick={() => selectTopic(topic.id)}><span className="public-map-node-meta"><span>Public topic</span>{saved && <span className="public-map-saved">✓ In my map</span>}</span><strong>{topic.label}</strong><span className="public-map-node-description">{topic.description || "Explore this topic’s connections."}</span><span className="public-map-node-footer">{expansion?.visible ? `${expansion.topicIds.length} related topics` : "Select to explore"}<span>{topic.id}</span></span></button>
            {isSelected && !footprint ? <button type="button" className="public-map-node-details" onClick={showDetails} aria-label={`Details and sources for ${topic.label}`}>Details & sources <span aria-hidden="true">↗</span></button> : null}
            <div className="public-map-node-actions" role="toolbar" aria-label={`Actions for ${topic.label}`}><button type="button" disabled={loading || !!expansion?.visible && !expansion.hasMore} aria-label={`${expansion?.visible ? "Load more connections for" : "Expand"} ${topic.label}`} title={expansion?.visible ? "Load more connections" : "Expand direct connections"} onClick={() => void expandTopic(topic.id, !!expansion?.visible)}>{loading ? "Loading…" : expansion?.visible ? expansion.hasMore ? "+ More" : "Expanded" : "+ Expand"}</button><button type="button" className="public-map-save" aria-label={`${saved ? "Show" : "Add"} ${topic.label} ${saved ? "in" : "to"} my map`} onClick={() => saveOrShow(topic)}>{saved ? "Show in my map ↗" : "Add to my map"}</button></div>
          </article>;
        })}
      </div>
      {(openingId || topicError) && <div className="public-map-feedback" role={topicError ? "alert" : "status"}>{openingId && !topicError ? "Opening public topic…" : topicError && <><p>{topicError.message}</p><button type="button" onClick={() => { const error = topicError; void (error.action === "open" ? openTopic(error.id) : expandTopic(error.id, !!location.graph.expansions[error.id])); }}>Try again</button><button type="button" onClick={() => setTopicError(null)}>Dismiss</button></>}</div>}
      <div className="public-map-bottom"><p role="status" aria-live="polite">{notice || (showNeighborhoods ? "Zoom to reveal topics · Select a group to focus" : "Drag to pan · Pinch to zoom")}<span id="public-map-keyboard-help">Arrow keys pan · +/− zoom · Home / 0 shows all groups</span></p>
        <div className="public-map-zoom" aria-label="Public map controls" data-graph-ui="true">
          <details className="public-map-arrange" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.querySelector<HTMLElement>("summary")?.focus(); } }}><summary>Arrange</summary><div>
            {([["auto", "Auto layout"], ["tree-right", "Tree: left to right"], ["tree-down", "Tree: top down"], ["connections", location.graphFocusId ? "Around focused node" : "Most connections"]] as const).map(([mode, label]) => <button type="button" key={mode} aria-pressed={documentsOnly && location.documentLayoutMode === mode} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); chooseDocumentLayout(mode); }}>{label}</button>)}
          </div></details>
          <button type="button" onClick={() => zoomAt(1 / 1.2)} aria-label="Zoom out" disabled={location.viewport.scale <= minimumZoomScale}>−</button><span>{Math.round(location.viewport.scale * 100)}%</span><button type="button" onClick={() => zoomAt(1.2)} aria-label="Zoom in" disabled={location.viewport.scale >= 1.6}>+</button>
          <button type="button" onClick={() => fitMap()} disabled={!visible.topics.length}>{location.graphFocusId ? "Fit connections" : activeNeighborhood ? "Fit group" : "Fit map"}</button>
          {selected ? <><button type="button" onClick={() => selectTopic(selected.id, true)}>Center topic</button><button type="button" onClick={() => focusConnections(selected.id)}>Focus connections</button></> : null}
        </div>
      </div>
    </div>
    {explorerOpen ? <section className={`public-map-details-dock${detailsCollapsed ? " is-collapsed" : ""}`} aria-label="Public map details" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); closeExplorer(); } }}>
      <div className="public-map-details-resize" role="separator" aria-label="Resize public map details" aria-orientation="vertical" aria-valuemin={260} aria-valuemax={Math.round(detailsMaxWidth)} aria-valuenow={Math.round(detailsWidth)} tabIndex={0}
        onPointerDown={(event) => { if (event.button !== 0) return; resizeStart.current = { x: event.clientX, width: detailsWidth }; event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); }}
        onPointerMove={(event) => { if (resizeStart.current) resizeDetails(resizeStart.current.width + resizeStart.current.x - event.clientX); }}
        onPointerUp={(event) => { resizeStart.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { resizeStart.current = null; }} onLostPointerCapture={() => { resizeStart.current = null; }}
        onKeyDown={(event) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); resizeDetails(event.key === "Home" ? 260 : event.key === "End" ? 560 : detailsWidth + (event.key === "ArrowLeft" ? 24 : -24)); } }} />
      <header className="public-map-details-header"><strong>{selected?.label ?? "Explore topics"}</strong><button type="button" className="public-map-sheet-toggle" aria-expanded={!detailsCollapsed} onClick={() => setDetailsCollapsed((collapsed) => !collapsed)}>{detailsCollapsed ? "Show details" : "Collapse details"}</button><button type="button" aria-label="Close explorer" title="Close details" onClick={closeExplorer}>×</button></header>
      {explorer}
    </section> : null}
    </div>
  </div>;
}

export default PublicKnowledgeMap;
