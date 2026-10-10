import type { GraphScope } from "./graphExploration";
import type { GraphViewport } from "./graphInteractions";

export const GRAPH_VIEW_MODES = [
  { id: "canvas", label: "Canvas", description: "Place documents, compare passages, and edit in place." },
  { id: "focus", label: "Focus", description: "Explore the selected document and its immediate connections." },
  { id: "clusters", label: "Clusters", description: "See documents gather around their most connected hubs, labeled by topic." },
  { id: "lineage", label: "Lineage", description: "Follow branch ancestry from parent to child." },
  { id: "network", label: "Network", description: "Find hubs and bridges among explicit relationships." },
  { id: "evidence", label: "Evidence", description: "Organize claims and exact passages by their evidence roles." },
  { id: "timeline", label: "Timeline", description: "Browse document creation and editing dates." },
  { id: "matrix", label: "Matrix", description: "Inspect directed relationships from rows to columns." },
  { id: "flow", label: "Link flow", description: "Count explicit relationships between groups." },
  // Reached from a tab rather than listed: Topics is Clusters grouped by your
  // groups, and Document layouts is Focus showing every document.
  { id: "topics", label: "Topics", description: "Browse your groups, then zoom into their documents." },
  { id: "documents", label: "All documents", description: "Lay out every document using its explicit connections." },
] as const;

export type GraphViewMode = typeof GRAPH_VIEW_MODES[number]["id"];
export type GraphRelationKind = "branch" | "link";
export type GraphContentLens = "documents" | "concepts";
export interface GraphModeCamera {
  viewport: GraphViewport;
  scopeKey: string;
  focusedTerritoryId: string | null;
  focusedTerritoryScale: number | null;
}
export type GraphModeCameras = Partial<Record<GraphViewMode, GraphModeCamera>>;

/** The three toolbar tabs; each answers a different question about the map. */
export const GRAPH_VIEW_TABS = ["canvas", "focus", "clusters"] as const;
export type GraphViewTab = typeof GRAPH_VIEW_TABS[number];
/** Views listed under More views. */
export const MORE_GRAPH_VIEW_MODES = GRAPH_VIEW_MODES.filter((mode) =>
  !(GRAPH_VIEW_TABS as readonly string[]).includes(mode.id) && mode.id !== "topics" && mode.id !== "documents");

/** The toolbar tab a mode belongs to, or null for views under More views. */
export function getGraphViewTab(mode: GraphViewMode): GraphViewTab | null {
  if (mode === "topics") return "clusters";
  if (mode === "documents") return "focus";
  return (GRAPH_VIEW_TABS as readonly string[]).includes(mode) ? mode as GraphViewTab : null;
}


export function isGraphViewMode(value: unknown): value is GraphViewMode {
  return GRAPH_VIEW_MODES.some((mode) => mode.id === value);
}

/** Older saved maps retain their layout until the user explicitly changes modes. */
export function getGraphViewMode(location: {
  viewMode: GraphViewMode | null; scope: GraphScope; overviewPresentation: string; documentLayoutMode: string;
}): GraphViewMode {
  if (location.viewMode) return location.viewMode;
  if (location.scope.kind === "focus") return "focus";
  if (location.overviewPresentation === "documents") return "documents";
  return location.overviewPresentation === "canvas" ? "canvas" : "topics";
}

export function isGraphPanelMode(mode: GraphViewMode) {
  return mode === "evidence" || mode === "timeline" || mode === "matrix" || mode === "flow";
}

export function normalizeGraphModeCameras(value: unknown): GraphModeCameras {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).flatMap(([mode, camera]) => {
    if (!isGraphViewMode(mode) || !camera || typeof camera !== "object") return [];
    const { viewport, scopeKey, focusedTerritoryId, focusedTerritoryScale } = camera;
    if (!viewport || ![viewport.x, viewport.y, viewport.scale].every(Number.isFinite) || viewport.scale <= 0 || typeof scopeKey !== "string") return [];
    return [[mode, { viewport: { x: viewport.x, y: viewport.y, scale: viewport.scale }, scopeKey,
      focusedTerritoryId: typeof focusedTerritoryId === "string" ? focusedTerritoryId : null,
      focusedTerritoryScale: Number.isFinite(focusedTerritoryScale) && focusedTerritoryScale > 0 ? focusedTerritoryScale : null }]];
  }));
}

export function normalizeNetworkPins(value: unknown): Record<string, { x: number; y: number }> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).filter(([, point]) => point && Number.isFinite(point.x) && Number.isFinite(point.y))
    .map(([id, point]) => [id, { x: point.x, y: point.y }]));
}
