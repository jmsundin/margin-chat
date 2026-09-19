import type { Conversation } from "../types";
import type { SearchFacet, SearchPassageResult } from "./searchExploration";
import { getStandaloneNote, getStandaloneNoteContextMessageId } from "./standaloneNotes";

export interface JevSearchItem {
  id: string;
  title: string;
  content: string;
  sourceKind: "conversation" | "message" | "standalone-note";
  role?: "user" | "assistant";
}
export interface JevSearchSnapshot {
  query: string;
  items: JevSearchItem[];
  facets: Array<{ id: string; label: string; itemIds: string[] }>;
  current?: { title: string; content: string };
}
export interface JevSearchResult {
  available: boolean;
  scores: Array<{ id: string; score: number; confidence: number }>;
  suggestedFacetIds: string[];
  model?: string;
  warning?: string;
}
const CONTEXT_PREFIX = getStandaloneNoteContextMessageId("");
const probability = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

/** Reconstruct primary text from canonical source references; result previews are never trusted. */
function primaryPassage(result: SearchPassageResult, conversations: Record<string, Conversation>): JevSearchItem | null {
  const { evidence } = result;
  if (result.localOnly || evidence.sourceKind === "annotation") return null;
  const conversation = conversations[evidence.conversationId];
  if (!conversation) return null;
  let content: string | undefined;
  let role: "user" | "assistant" | undefined;
  if (evidence.sourceKind === "conversation") content = conversation.title;
  else if (evidence.sourceKind === "standalone-note") {
    const note = getStandaloneNote(conversation);
    if (note && note.id === evidence.noteId) content = note.content;
  } else if (evidence.sourceKind === "message" && conversation.kind !== "note") {
    const message = conversation.messages.find((item) => item.id === evidence.messageId);
    if (message && (message.role === "user" || message.role === "assistant") && !message.id.startsWith(CONTEXT_PREFIX)) {
      content = message.content;
      role = message.role;
    }
  }
  const start = evidence.startOffset, end = evidence.endOffset;
  if (content === undefined || !Number.isInteger(start) || !Number.isInteger(end) || start! < 0 || end! <= start! || end! > content.length) return null;
  const passage = content.slice(start, end);
  // Edits can invalidate a result while a request is being prepared. Re-run local
  // retrieval rather than sending unrelated text under an old result ID.
  if (passage !== evidence.quote) return null;
  return { id: result.id, title: conversation.title.slice(0, 200), content: passage.slice(0, 1200), sourceKind: evidence.sourceKind, ...(role ? { role } : {}) };
}

function currentContext(conversation?: Conversation): JevSearchSnapshot["current"] {
  if (!conversation) return undefined;
  const content = conversation.kind === "note" ? getStandaloneNote(conversation)?.content ?? "" : conversation.messages
    .filter((message) => (message.role === "user" || message.role === "assistant") && !message.id.startsWith(CONTEXT_PREFIX))
    .slice(-4).map((message) => `${message.role}: ${message.content.slice(-800)}`).join("\n").slice(-800);
  return { title: conversation.title.slice(0, 200), content: content.slice(0, 800) };
}

/** This is an assistance shortlist, never the search corpus or a source of result counts. */
export function buildJevSearchSnapshot({ conversations, query, results, facets, currentConversationId }: {
  conversations: Record<string, Conversation>;
  query: string;
  results: SearchPassageResult[];
  facets: SearchFacet[];
  currentConversationId?: string;
}): JevSearchSnapshot | null {
  const current = currentContext(currentConversationId ? conversations[currentConversationId] : undefined);
  if (!query.trim() && !current?.content.trim()) return null;
  const items: JevSearchItem[] = [];
  const selectedResults = new Map<string, SearchPassageResult>();
  for (const result of results) {
    if (selectedResults.has(result.id)) continue;
    const item = primaryPassage(result, conversations);
    if (!item) continue;
    items.push(item);
    selectedResults.set(item.id, result);
    if (items.length === 20) break;
  }
  if (!items.length) return null;
  const seenFacets = new Set<string>();
  const supportedFacets = facets.filter((facet) => !facet.selected && facet.kind !== "type").flatMap((facet) => {
    if (seenFacets.has(facet.id)) return [];
    seenFacets.add(facet.id);
    const itemIds = items.filter((item) => selectedResults.get(item.id)!.facetIds.includes(facet.id)).map((item) => item.id);
    return itemIds.length ? [{ id: facet.id, label: facet.label.slice(0, 100), itemIds }] : [];
  }).slice(0, 12);
  return { query: query.trim().slice(0, 2000), items, facets: supportedFacets, ...(current ? { current } : {}) };
}

export function parseJevSearchResult(value: unknown, snapshot: JevSearchSnapshot): JevSearchResult {
  if (!value || typeof value !== "object" || typeof (value as JevSearchResult).available !== "boolean") throw new Error("Jev returned an invalid search response.");
  const payload = value as JevSearchResult;
  if (payload.available && (!Array.isArray(payload.scores) || !Array.isArray(payload.suggestedFacetIds))) throw new Error("Jev returned invalid search judgments.");
  const itemIds = new Set(snapshot.items.map((item) => item.id));
  const facetIds = new Set(snapshot.facets.filter((facet) => facet.itemIds.some((id) => itemIds.has(id))).map((facet) => facet.id));
  const scores = new Map<string, JevSearchResult["scores"][number]>();
  for (const score of payload.available ? payload.scores : []) {
    if (score && itemIds.has(score.id) && probability(score.score) && probability(score.confidence) && score.confidence >= 0.35) {
      scores.set(score.id, { id: score.id, score: score.score, confidence: score.confidence });
    }
  }
  return { available: payload.available, scores: [...scores.values()],
    suggestedFacetIds: [...new Set(payload.available ? payload.suggestedFacetIds.filter((id) => facetIds.has(id)) : [])].slice(0, 3),
    ...(typeof payload.model === "string" ? { model: payload.model.slice(0, 100) } : {}),
    ...(typeof payload.warning === "string" ? { warning: payload.warning.slice(0, 240) } : {}) };
}

/** Unreviewed/private results keep their slots. Assistance changes order, never membership. */
export function applyJevSearchRanking<T extends { id: string; localOnly?: boolean }>(results: T[], scores: Record<string, number>): T[] {
  const scored = (result: T) => !result.localOnly && Object.hasOwn(scores, result.id) && probability(scores[result.id]);
  const ranked = results.map((result, index) => ({ result, index })).filter(({ result }) => scored(result))
    .sort((a, b) => scores[b.result.id] - scores[a.result.id] || a.index - b.index);
  let next = 0;
  return results.map((result) => scored(result) ? ranked[next++].result : result);
}

export async function requestJevSearch(userId: string, snapshot: JevSearchSnapshot, signal: AbortSignal): Promise<JevSearchResult> {
  const response = await fetch("/api/jev/search", {
    credentials: "same-origin", method: "POST", signal,
    headers: { "Content-Type": "application/json", "X-Margin-Vault-User": userId },
    body: JSON.stringify({ enabled: true, ...snapshot }),
  });
  if (!response.ok) throw new Error("Search assistance is temporarily unavailable.");
  return parseJevSearchResult(await response.json(), snapshot);
}
