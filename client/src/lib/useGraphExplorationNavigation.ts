import { useCallback, useEffect, useState } from "react";
import type { ConversationGraphDetail } from "./conversationGraph";
import { normalizeEvidence, type GraphEvidenceRef, type GraphScope } from "./graphExploration";
import type { GraphViewport } from "./graphInteractions";
import type { DocumentLayoutMode } from "./documentMapLayout";
import { isGraphViewMode, normalizeGraphModeCameras, normalizeNetworkPins, type GraphContentLens, type GraphModeCameras, type GraphRelationKind, type GraphViewMode } from "./graphViewModes";

export interface GraphExplorationLocation {
  viewMode: GraphViewMode | null;
  contentLens: GraphContentLens;
  documentViewMode: GraphViewMode;
  relationKinds: GraphRelationKind[];
  modeCameras: GraphModeCameras;
  scopeBeforeFocus: GraphScope | null;
  selectedConceptId: string | null;
  networkIteration: number;
  networkPins: Record<string, { x: number; y: number }>;
  scope: GraphScope;
  selectedConversationId: string | null;
  dockedConversationId: string | null;
  detailLevel: ConversationGraphDetail;
  source: GraphEvidenceRef | null;
  query: string;
  viewport: GraphViewport;
  expandedGroups: string[];
  readerScroll: number;
  showRelated: boolean;
  overviewPresentation: "themes" | "map" | "canvas" | "documents";
  overviewTopicId: string | null;
  focusedTerritoryId: string | null;
  focusedTerritoryScale: number | null;
  groupOverviewVersion: number;
  documentLayoutVersion: number;
  documentLayoutMode: DocumentLayoutMode;
}

export const defaultGraphLocation = (): GraphExplorationLocation => ({
  viewMode: null, contentLens: "documents", documentViewMode: "topics", relationKinds: ["branch", "link"], modeCameras: {}, scopeBeforeFocus: null,
  selectedConceptId: null, networkIteration: 0, networkPins: {},
  scope: { kind: "all" }, selectedConversationId: null, dockedConversationId: null,
  detailLevel: "compact", source: null, query: "", viewport: { scale: 1, x: 0, y: 0 },
  expandedGroups: [], readerScroll: 0, showRelated: false, overviewPresentation: "map", overviewTopicId: null, focusedTerritoryId: null, focusedTerritoryScale: null,
  groupOverviewVersion: 1,
  documentLayoutVersion: 1,
  documentLayoutMode: "auto",
});

function normalizeLocation(value: any): GraphExplorationLocation | null {
  try {
    if (!value || !value.viewport || ![value.viewport.x, value.viewport.y, value.viewport.scale].every(Number.isFinite) || value.viewport.scale <= 0) return null;
    const scope = value.scope;
    const validScope = scope && (scope.kind === "all" || scope.kind === "ungrouped" ||
      (scope.kind === "group" && typeof scope.groupId === "string") ||
      (scope.kind === "category" && typeof scope.categoryId === "string") ||
      (scope.kind === "concept" && typeof scope.conceptId === "string") ||
      (scope.kind === "focus" && typeof scope.conversationId === "string" && Number.isFinite(scope.depth)));
    if (!validScope) return null;
    return {
      ...defaultGraphLocation(), scope, viewport: value.viewport,
      viewMode: isGraphViewMode(value.viewMode) ? value.viewMode : null,
      contentLens: value.contentLens === "concepts" ? "concepts" : "documents",
      documentViewMode: isGraphViewMode(value.documentViewMode) && ["canvas", "focus", "topics", "lineage", "network", "documents"].includes(value.documentViewMode) ? value.documentViewMode : "topics",
      relationKinds: Array.isArray(value.relationKinds) ? [...new Set(value.relationKinds.filter((kind: unknown) => kind === "branch" || kind === "link"))] as GraphRelationKind[] : ["branch", "link"],
      modeCameras: normalizeGraphModeCameras(value.modeCameras),
      scopeBeforeFocus: value.scopeBeforeFocus && value.scopeBeforeFocus.kind !== "focus"
        ? normalizeLocation({ ...defaultGraphLocation(), scope: value.scopeBeforeFocus })?.scope ?? null : null,
      selectedConceptId: typeof value.selectedConceptId === "string" ? value.selectedConceptId : null,
      networkIteration: Number.isSafeInteger(value.networkIteration) && value.networkIteration >= 0 ? value.networkIteration : 0,
      networkPins: normalizeNetworkPins(value.networkPins),
      selectedConversationId: typeof value.selectedConversationId === "string" ? value.selectedConversationId : null,
      dockedConversationId: typeof value.dockedConversationId === "string" ? value.dockedConversationId : null,
      detailLevel: ["compact", "preview", "reader"].includes(value.detailLevel) ? value.detailLevel : "compact",
      source: normalizeEvidence(value.source),
      query: typeof value.query === "string" ? value.query : "",
      expandedGroups: Array.isArray(value.expandedGroups) ? value.expandedGroups.filter((id: unknown) => typeof id === "string") : [],
      readerScroll: Number.isFinite(value.readerScroll) ? Math.max(0, value.readerScroll) : 0,
      showRelated: value.showRelated === true,
      overviewPresentation: ["map", "canvas", "documents"].includes(value.overviewPresentation) ? value.overviewPresentation : "themes",
      overviewTopicId: typeof value.overviewTopicId === "string" ? value.overviewTopicId : null,
      focusedTerritoryId: typeof value.focusedTerritoryId === "string" ? value.focusedTerritoryId : null,
      groupOverviewVersion: value.groupOverviewVersion === 1 ? 1 : 0,
      documentLayoutVersion: value.documentLayoutVersion === 1 ? 1 : 0,
      documentLayoutMode: ["tree-right", "tree-down", "connections"].includes(value.documentLayoutMode) ? value.documentLayoutMode : "auto",
      focusedTerritoryScale: typeof value.focusedTerritoryId === "string"
        ? Number.isFinite(value.focusedTerritoryScale) && value.focusedTerritoryScale > 0 ? value.focusedTerritoryScale : value.viewport.scale
        : null,
    };
  } catch { return null; }
}

interface GraphHistory { past: GraphExplorationLocation[]; present: GraphExplorationLocation; future: GraphExplorationLocation[] }
function readHistory(key?: string): GraphHistory | null {
  if (!key) return null;
  try {
    const value = JSON.parse(sessionStorage.getItem(`margin-graph-location:${key}`) ?? "null");
    const present = normalizeLocation(value?.present ?? value);
    if (!present) return null;
    const locations = (values: unknown) => Array.isArray(values) ? values.slice(-50).map(normalizeLocation).filter((item): item is GraphExplorationLocation => Boolean(item)) : [];
    return { present, past: locations(value?.past), future: locations(value?.future) };
  } catch { return null; }
}

export function useGraphExplorationNavigation(workspaceKey?: string) {
  const [initial] = useState(() => readHistory(workspaceKey));
  const [history, setHistory] = useState<GraphHistory>(() => initial ?? ({
    past: [], present: defaultGraphLocation(), future: [],
  }));
  const update = useCallback((patch: Partial<GraphExplorationLocation> | ((current: GraphExplorationLocation) => Partial<GraphExplorationLocation>)) => {
    setHistory((current) => ({ ...current, present: { ...current.present, ...(typeof patch === "function" ? patch(current.present) : patch) } }));
  }, []);
  const navigate = useCallback((patch: Partial<GraphExplorationLocation>) => {
    setHistory((current) => ({
      past: [...current.past.slice(-49), current.present],
      present: { ...current.present, ...patch }, future: [],
    }));
  }, []);
  const back = useCallback(() => setHistory((current) => current.past.length ? {
    past: current.past.slice(0, -1), present: current.past.at(-1)!, future: [current.present, ...current.future],
  } : current), []);
  const forward = useCallback(() => setHistory((current) => current.future.length ? {
    past: [...current.past, current.present], present: current.future[0], future: current.future.slice(1),
  } : current), []);
  useEffect(() => {
    if (!workspaceKey) return;
    try { sessionStorage.setItem(`margin-graph-location:${workspaceKey}`, JSON.stringify(history)); }
    catch { /* Navigation remains available when session storage is unavailable. */ }
  }, [history, workspaceKey]);
  return { state: history.present, update, navigate, back, forward, canGoBack: history.past.length > 0, canGoForward: history.future.length > 0, restored: Boolean(initial) };
}
