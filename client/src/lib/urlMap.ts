import type { AISettings, AppState, BackendServiceId, Conversation } from "../types";
import { createStandaloneNoteConversation } from "../initialState";
import { addRootConversation } from "./workspaceCommands";
import { ApiError } from "./apiError";

export interface UrlMapEvidence { quote: string; start: number; end: number }
export interface UrlMapNode { id: string; label: string; summary: string; evidence: UrlMapEvidence }
export interface UrlMapEdge { id: string; sourceId: string; targetId: string; label: string; kind: "stated" | "suggested"; evidence: UrlMapEvidence | null }
export interface UrlMapGraph {
  rootId: string;
  nodes: UrlMapNode[];
  edges: UrlMapEdge[];
  source: { url: string; title: string; byline: string | null; retrievedAt: string; truncated: boolean; links: Array<{ url: string; label: string }> };
  warnings: string[];
}
export interface UrlMapAIOptions { serviceId?: BackendServiceId; modelId?: string; ai?: AISettings }

export function isUrlMapGraph(value: unknown): value is UrlMapGraph {
  if (!value || typeof value !== "object") return false;
  const graph = value as UrlMapGraph;
  const evidence = (item: UrlMapEvidence) => item && typeof item.quote === "string" && Number.isInteger(item.start) && Number.isInteger(item.end);
  const webUrl = (url: string) => { try { return ["https:", "http:"].includes(new URL(url).protocol); } catch { return false; } };
  if (!Array.isArray(graph.nodes) || graph.nodes.length < 2 || graph.nodes.length > 8 || !graph.nodes.every((node) => node && /^[a-f0-9]{32}$/.test(node.id) && typeof node.label === "string" && typeof node.summary === "string" && evidence(node.evidence))) return false;
  const ids = new Set(graph.nodes.map((node) => node.id));
  return ids.size === graph.nodes.length && ids.has(graph.rootId) && Array.isArray(graph.edges) && graph.edges.length <= 12
    && graph.edges.every((edge) => edge && typeof edge.id === "string" && typeof edge.label === "string" && ids.has(edge.sourceId) && ids.has(edge.targetId) && ["stated", "suggested"].includes(edge.kind) && (edge.kind === "suggested" || evidence(edge.evidence!)))
    && Boolean(graph.source && webUrl(graph.source.url) && typeof graph.source.title === "string" && typeof graph.source.retrievedAt === "string" && Array.isArray(graph.source.links) && graph.source.links.length <= 24 && graph.source.links.every((link) => link && webUrl(link.url) && typeof link.label === "string"))
    && Array.isArray(graph.warnings) && graph.warnings.every((warning) => typeof warning === "string");
}

export async function requestUrlMap(args: UrlMapAIOptions & { url: string; focus?: string; expectedUserId: string; signal: AbortSignal; onProgress: (message: string) => void }): Promise<UrlMapGraph> {
  const { expectedUserId, signal, onProgress, ...payload } = args;
  const response = await fetch("/api/graph/url", { method: "POST", credentials: "same-origin", signal,
    headers: { "Content-Type": "application/json", Accept: "application/x-ndjson", "X-Margin-Vault-User": expectedUserId }, body: JSON.stringify(payload) });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(response.status, typeof body?.error === "string" ? body.error : "The webpage could not be mapped. Try again.");
  }
  if (!response.body) throw new Error("The map response was empty. Try again.");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = "", total = 0, result: UrlMapGraph | null = null;
  function event(line: string) {
    if (!line.trim()) return;
    const value = JSON.parse(line);
    if (value.type === "error") throw new ApiError(value.statusCode ?? 502, typeof value.error === "string" ? value.error : "The map could not be completed.");
    if (value.type === "progress" && typeof value.message === "string") onProgress(value.message);
    if (value.type === "done") {
      if (!isUrlMapGraph(value.graph)) throw new Error("The AI returned an invalid map. Try again.");
      result = value.graph;
    }
  }
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      total += value?.length ?? 0;
      if (total > 200_000) throw new Error("The map response was too large.");
      const lines = pending.split("\n"); pending = lines.pop() ?? "";
      for (const line of lines) event(line);
      if (done) { event(pending); break; }
    }
    signal.throwIfAborted();
    if (!result) throw new Error("The connection ended before the map was complete. Try again.");
    return result;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export const urlMapConversationId = (node: UrlMapNode) => `url-topic-${node.id}`;
export function findSavedUrlMapNode(conversations: Record<string, Conversation>, node: UrlMapNode) {
  return conversations[urlMapConversationId(node)] ?? null;
}
const markdownText = (text: string) => text.replace(/[\\`*_{}\[\]<>#]/g, "\\$&");

/** Page-scoped identity avoids guessing that equally named concepts on different sites are the same. */
export function saveUrlMapNode(state: AppState, graph: UrlMapGraph, nodeId: string): AppState {
  const node = graph.nodes.find((item) => item.id === nodeId);
  if (!node || !isUrlMapGraph(graph)) return state;
  const id = urlMapConversationId(node);
  if (state.conversations[id]) return state;
  const note = createStandaloneNoteConversation({ id, noteId: `${id}-body`, serviceId: state.defaultServiceId, modelId: state.defaultModelId, createdAt: graph.source.retrievedAt });
  note.title = node.label;
  const related = graph.edges.filter((edge) => edge.sourceId === nodeId || edge.targetId === nodeId);
  note.notes![0].content = [
    `Source: <${graph.source.url.replace(/[<>]/g, (character) => encodeURIComponent(character))}>`,
    `Page: ${markdownText(graph.source.title)}${graph.source.byline ? ` · ${markdownText(graph.source.byline)}` : ""}\n\nRead ${markdownText(graph.source.retrievedAt)}. AI-generated topic summary; check the source before relying on it.`,
    markdownText(node.summary),
    `## Supporting passage\n\n> ${markdownText(node.evidence.quote)}`,
    ...(related.length ? [`## Relationships\n\n${related.map((edge) => {
      const source = graph.nodes.find((item) => item.id === edge.sourceId)!.label;
      const target = graph.nodes.find((item) => item.id === edge.targetId)!.label;
      return `- ${markdownText(source)} → ${markdownText(edge.label)} → ${markdownText(target)} (${edge.kind === "suggested" ? "AI-suggested connection" : "AI-extracted from source"})${edge.evidence ? `\n\n  > ${markdownText(edge.evidence.quote)}` : ""}`;
    }).join("\n\n")}`] : []),
    ...(graph.source.truncated ? ["Only the first 12,000 characters of readable page text were analyzed."] : []),
    "## My notes\n\n",
  ].join("\n\n");
  const next = addRootConversation(state, note);
  return { ...next, rootId: state.rootId, activeConversationId: state.activeConversationId };
}

/** Stable breadth-first columns keep a small graph legible without a physics simulation. */
export function layoutUrlMap(graph: UrlMapGraph) {
  const depth = new Map([[graph.rootId, 0]]), pending = [graph.rootId];
  for (let index = 0; index < pending.length; index += 1) {
    const id = pending[index];
    for (const edge of graph.edges) {
      const other = edge.sourceId === id ? edge.targetId : edge.targetId === id ? edge.sourceId : null;
      if (other && !depth.has(other)) { depth.set(other, Math.min(3, depth.get(id)! + 1)); pending.push(other); }
    }
  }
  const rows = new Map<number, number>();
  const nodes = [...graph.nodes].sort((a, b) => (depth.get(a.id) ?? 1) - (depth.get(b.id) ?? 1)).map((node) => {
    const column = depth.get(node.id) ?? 1, row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    return { ...node, x: 36 + column * 360, y: 36 + row * 220 };
  });
  const maximumRows = Math.max(...rows.values());
  for (const node of nodes) node.y += (maximumRows - rows.get(depth.get(node.id) ?? 1)!) * 110;
  return { nodes, width: Math.max(...nodes.map((node) => node.x)) + 286, height: Math.max(...nodes.map((node) => node.y)) + 208 };
}

export const URL_MAP_MIN_ZOOM = 0.5;
export const URL_MAP_MAX_ZOOM = 1.6;
export function clampUrlMapZoom(zoom: number) { return Math.max(URL_MAP_MIN_ZOOM, Math.min(URL_MAP_MAX_ZOOM, zoom)); }

/** Screen-space cards keep titles and hit targets readable in the overview. */
export function projectUrlMap(layout: ReturnType<typeof layoutUrlMap>, zoom: number) {
  const width = Math.max(140, 250 * zoom), height = 166 * zoom;
  const nodes = layout.nodes.map((node) => ({ ...node, x: node.x * zoom, y: node.y * zoom, width, height }));
  return {
    nodes,
    width: Math.max(...nodes.map((node) => node.x + width)) + 36 * zoom,
    height: Math.max(...nodes.map((node) => node.y + height)) + 36 * zoom,
  };
}

export function fitUrlMapZoom(layout: ReturnType<typeof layoutUrlMap>, width: number, height: number) {
  let low = URL_MAP_MIN_ZOOM, high = 1;
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const middle = (low + high) / 2, scene = projectUrlMap(layout, middle);
    if (scene.width <= width - 20 && scene.height <= height - 20) low = middle;
    else high = middle;
  }
  return Math.abs(low - 1) < 0.00001 ? 1 : low;
}
