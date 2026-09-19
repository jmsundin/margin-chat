import type { Conversation, ConversationGroup, ThreadCategoryId, ThreadSummary } from "../types";
import type {
  ConversationGraphEdgePlacement,
  ConversationGraphGroupPlacement,
  ConversationGraphScene,
} from "./conversationGraph";
import { getStandaloneNote } from "./standaloneNotes";

export type GraphScope =
  | { kind: "all" }
  | { kind: "ungrouped" }
  | { kind: "group"; groupId: string }
  | { kind: "category"; categoryId: ThreadCategoryId }
  | { kind: "focus"; conversationId: string; depth: number }
  | { kind: "concept"; conceptId: string };

/** Source IDs identify the canonical workspace item, never a copied passage. */
export interface GraphEvidenceRef {
  conversationId: string;
  sourceKind: "conversation" | "message" | "standalone-note";
  messageId?: string;
  noteId?: string;
  quote?: string;
  startOffset?: number;
  endOffset?: number;
}

export interface GraphConcept {
  id: string;
  label: string;
  description: string;
  members: GraphEvidenceRef[];
}

export interface GraphSearchResult {
  id: string;
  title: string;
  preview: string;
  sourceLabel: string;
  evidence: GraphEvidenceRef;
  updatedAt: string;
}

export interface GraphEvidenceResolution {
  status: "exact" | "recovered" | "stale" | "missing";
  conversationId: string;
  content: string | null;
  highlight: { startOffset: number; endOffset: number } | null;
  evidence: GraphEvidenceRef;
}

export function getGraphConceptConversationIds(
  concept: GraphConcept,
  conversations: Record<string, Conversation>,
): Set<string> {
  return new Set(concept.members.map((member) => member.conversationId).filter((id) => Object.hasOwn(conversations, id)));
}

export function getGraphScopeConversationIds(args: {
  scope: GraphScope;
  conversations: Record<string, Conversation>;
  groups?: Record<string, ConversationGroup>;
  threads?: ThreadSummary[];
  concepts?: GraphConcept[];
}): Set<string> {
  const { conversations, scope, groups = {}, threads = [], concepts = [] } = args;
  const allIds = Object.keys(conversations);
  if (scope.kind === "all") return new Set(allIds);
  if (scope.kind === "ungrouped") {
    const grouped = new Set(Object.values(groups).flatMap((group) => group.conversationIds));
    return new Set(allIds.filter((id) => !grouped.has(id)));
  }
  if (scope.kind === "group") {
    return new Set((groups[scope.groupId]?.conversationIds ?? []).filter((id) => Object.hasOwn(conversations, id)));
  }
  if (scope.kind === "concept") {
    const concept = concepts.find((candidate) => candidate.id === scope.conceptId);
    return concept ? getGraphConceptConversationIds(concept, conversations) : new Set();
  }

  // The parent pointer is authoritative even if a cached child list is incomplete.
  const children = new Map<string, string[]>();
  for (const conversation of Object.values(conversations)) {
    if (conversation.parentId && Object.hasOwn(conversations, conversation.parentId)) {
      const siblings = children.get(conversation.parentId) ?? [];
      siblings.push(conversation.id);
      children.set(conversation.parentId, siblings);
    }
  }
  const result = new Set<string>();
  if (scope.kind === "category") {
    const queue = threads.filter((thread) => thread.categoryId === scope.categoryId).map((thread) => thread.id);
    for (let index = 0; index < queue.length; index += 1) {
      const id = queue[index];
      if (!Object.hasOwn(conversations, id) || result.has(id)) continue;
      result.add(id);
      queue.push(...(children.get(id) ?? []));
    }
    return result;
  }
  if (!Object.hasOwn(conversations, scope.conversationId)) return result;
  const depth = Number.isFinite(scope.depth) ? Math.max(0, Math.floor(scope.depth)) : 1;
  const visited = new Set<string>();
  const queue = [{ id: scope.conversationId, depth: 0 }];
  for (let index = 0; index < queue.length; index += 1) {
    const entry = queue[index];
    if (!Object.hasOwn(conversations, entry.id) || visited.has(entry.id)) continue;
    visited.add(entry.id);
    result.add(entry.id);
    if (entry.depth >= depth) continue;
    const parentId = conversations[entry.id].parentId;
    const neighbors = [...(children.get(entry.id) ?? []), ...(parentId ? [parentId] : [])];
    queue.push(...neighbors.map((id) => ({ id, depth: entry.depth + 1 })));
  }
  // Keep the full breadcrumb ancestry regardless of the local expansion depth.
  const ancestry = new Set<string>();
  let ancestorId: string | null = scope.conversationId;
  while (ancestorId && Object.hasOwn(conversations, ancestorId) && !ancestry.has(ancestorId)) {
    ancestry.add(ancestorId);
    result.add(ancestorId);
    ancestorId = conversations[ancestorId].parentId;
  }
  return result;
}

function evidenceKey(evidence: GraphEvidenceRef) {
  return JSON.stringify([
    evidence.conversationId, evidence.sourceKind, evidence.messageId ?? evidence.noteId ?? null,
    evidence.startOffset ?? null, evidence.endOffset ?? null, evidence.quote ?? null,
  ]);
}

/** Searches every local source. It does not inherit the related-item service's 40-item limit. */
export function searchGraphSources(
  conversations: Record<string, Conversation>,
  query: string,
): GraphSearchResult[] {
  const term = query.trim();
  if (!term) {
    return Object.values(conversations).map((conversation): GraphSearchResult => {
      const note = getStandaloneNote(conversation);
      const message = conversation.kind !== "note" ? [...conversation.messages].reverse().find((entry) => entry.content.trim()) : undefined;
      const evidence: GraphEvidenceRef = note
        ? { conversationId: conversation.id, sourceKind: "standalone-note", noteId: note.id }
        : message
          ? { conversationId: conversation.id, sourceKind: "message", messageId: message.id }
          : { conversationId: conversation.id, sourceKind: "conversation" };
      const content = note?.content ?? message?.content ?? conversation.title;
      return {
        id: evidenceKey(evidence), evidence, title: conversation.title,
        preview: content.length > 192 ? `${content.slice(0, 192)}…` : content,
        sourceLabel: note ? "Note" : message ? `${message.role[0].toUpperCase()}${message.role.slice(1)} message` : "Title",
        updatedAt: conversation.updatedAt,
      };
    }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
  }
  // Matching the original string preserves UTF-16 offsets when Unicode case folding changes length.
  const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
  const results: GraphSearchResult[] = [];
  const addSource = (conversation: Conversation, content: string, sourceLabel: string, source: GraphEvidenceRef, updatedAt: string) => {
    const match = pattern.exec(content);
    if (!match) return;
    const startOffset = match.index;
    const endOffset = startOffset + match[0].length;
    const evidence: GraphEvidenceRef = { ...source, startOffset, endOffset, quote: match[0] };
    const start = Math.max(0, startOffset - 64);
    const end = Math.min(content.length, endOffset + 128);
    results.push({
      evidence,
      id: evidenceKey(evidence),
      preview: `${start > 0 ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}`,
      sourceLabel,
      title: conversation.title,
      updatedAt,
    });
  };
  for (const conversation of Object.values(conversations)) {
    addSource(conversation, conversation.title, "Title", { conversationId: conversation.id, sourceKind: "conversation" }, conversation.updatedAt);
    if (conversation.kind === "note") {
      const note = getStandaloneNote(conversation);
      if (note) addSource(conversation, note.content, "Note", { conversationId: conversation.id, sourceKind: "standalone-note", noteId: note.id }, note.updatedAt);
      continue;
    }
    for (const message of conversation.messages) {
      addSource(conversation, message.content, `${message.role[0].toUpperCase()}${message.role.slice(1)} message`, {
        conversationId: conversation.id, sourceKind: "message", messageId: message.id,
      }, message.createdAt);
    }
  }
  return results.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
}

/** Never highlight stale offsets or guess between multiple occurrences of an edited quote. */
export function resolveGraphEvidence(
  conversations: Record<string, Conversation>,
  evidence: GraphEvidenceRef,
): GraphEvidenceResolution {
  const result: GraphEvidenceResolution = {
    status: "missing", conversationId: evidence.conversationId, content: null, highlight: null, evidence,
  };
  if (!Object.hasOwn(conversations, evidence.conversationId)) return result;
  const conversation = conversations[evidence.conversationId];
  if (evidence.sourceKind === "conversation") {
    return { ...result, status: "exact", content: conversation.title };
  }
  let content: string | undefined;
  if (evidence.sourceKind === "message" && conversation.kind !== "note") {
    content = conversation.messages.find((message) => message.id === evidence.messageId)?.content;
  } else if (evidence.sourceKind === "standalone-note") {
    const note = getStandaloneNote(conversation);
    if (note && note.id === evidence.noteId) content = note.content;
  }
  if (content === undefined) return result;
  result.content = content;
  const { quote, startOffset, endOffset } = evidence;
  if (!quote) {
    return { ...result, status: startOffset === undefined && endOffset === undefined ? "exact" : "stale" };
  }
  if (
    Number.isInteger(startOffset) && Number.isInteger(endOffset) &&
    startOffset! >= 0 && endOffset! > startOffset! && endOffset! <= content.length &&
    content.slice(startOffset, endOffset) === quote
  ) {
    return { ...result, status: "exact", highlight: { startOffset: startOffset!, endOffset: endOffset! } };
  }
  const recoveredOffset = content.indexOf(quote);
  if (recoveredOffset >= 0 && content.indexOf(quote, recoveredOffset + 1) === -1) {
    const highlight = { startOffset: recoveredOffset, endOffset: recoveredOffset + quote.length };
    return { ...result, status: "recovered", highlight, evidence: { ...evidence, ...highlight } };
  }
  return { ...result, status: "stale" };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input);
}

function nonemptyString(input: unknown): input is string {
  return typeof input === "string" && input.trim().length > 0;
}

export function normalizeEvidence(input: unknown): GraphEvidenceRef | null {
  if (!isRecord(input) || !nonemptyString(input.conversationId)) return null;
  if (input.sourceKind !== "conversation" && input.sourceKind !== "message" && input.sourceKind !== "standalone-note") return null;
  if (input.sourceKind === "message" && !nonemptyString(input.messageId)) return null;
  if (input.sourceKind === "standalone-note" && !nonemptyString(input.noteId)) return null;
  const evidence: GraphEvidenceRef = { conversationId: input.conversationId, sourceKind: input.sourceKind };
  if (input.sourceKind === "message") evidence.messageId = input.messageId as string;
  if (input.sourceKind === "standalone-note") evidence.noteId = input.noteId as string;
  if (typeof input.quote === "string" && input.quote.length) evidence.quote = input.quote;
  if (typeof input.startOffset === "number" && Number.isInteger(input.startOffset) && input.startOffset >= 0 &&
      typeof input.endOffset === "number" && Number.isInteger(input.endOffset) && input.endOffset > input.startOffset) {
    evidence.startOffset = input.startOffset;
    evidence.endOffset = input.endOffset;
  }
  return evidence;
}

/** Keep stale references for inspection; only malformed or duplicate membership is discarded. */
export function normalizeGraphConcepts(input: unknown): GraphConcept[] {
  if (!Array.isArray(input)) return [];
  const ids = new Set<string>();
  const concepts: GraphConcept[] = [];
  for (const candidate of input) {
    if (!isRecord(candidate) || !nonemptyString(candidate.id) || !nonemptyString(candidate.label) || ids.has(candidate.id)) continue;
    ids.add(candidate.id);
    const memberKeys = new Set<string>();
    const members: GraphEvidenceRef[] = [];
    for (const item of Array.isArray(candidate.members) ? candidate.members : []) {
      const member = normalizeEvidence(item);
      if (!member) continue;
      const key = evidenceKey(member);
      if (memberKeys.has(key)) continue;
      memberKeys.add(key);
      members.push(member);
    }
    concepts.push({ id: candidate.id, label: candidate.label.trim(), description: typeof candidate.description === "string" ? candidate.description : "", members });
  }
  return concepts;
}

export interface GraphConceptStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function graphConceptStorageKey(accountId: string): string {
  return `margin-chat:graph-concepts:v1:${encodeURIComponent(accountId)}`;
}

function defaultStorage(): GraphConceptStorage | undefined {
  try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; }
}

export function readGraphConcepts(accountId: string, storage: GraphConceptStorage | undefined = defaultStorage()): GraphConcept[] {
  if (!accountId.trim() || !storage) return [];
  try {
    const serialized = storage.getItem(graphConceptStorageKey(accountId));
    if (!serialized) return [];
    const parsed: unknown = JSON.parse(serialized);
    return isRecord(parsed) && parsed.version === 1 ? normalizeGraphConcepts(parsed.concepts) : [];
  } catch { return []; }
}

export function writeGraphConcepts(accountId: string, concepts: GraphConcept[], storage: GraphConceptStorage | undefined = defaultStorage()): boolean {
  if (!accountId.trim() || !storage) return false;
  try {
    storage.setItem(graphConceptStorageKey(accountId), JSON.stringify({ version: 1, concepts: normalizeGraphConcepts(concepts) }));
    return true;
  } catch { return false; }
}

export interface GraphWorldRect { x: number; y: number; width: number; height: number }
export interface GraphWorldBounds { left: number; top: number; right: number; bottom: number; width: number; height: number }

export function getGraphWorldBounds(rects: GraphWorldRect[], padding = 0): GraphWorldBounds {
  const valid = rects.filter((rect) => [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width >= 0 && rect.height >= 0);
  if (!valid.length) return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  const inset = Number.isFinite(padding) ? Math.max(0, padding) : 0;
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const rect of valid) {
    left = Math.min(left, rect.x - inset);
    top = Math.min(top, rect.y - inset);
    right = Math.max(right, rect.x + rect.width + inset);
    bottom = Math.max(bottom, rect.y + rect.height + inset);
  }
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

export function getCollapsedGraphGroupRect(placement: ConversationGraphGroupPlacement): GraphWorldRect {
  const width = Math.min(300, Math.max(230, placement.width * 0.56));
  const height = 112;
  return { x: placement.x + (placement.width - width) / 2, y: placement.y + (placement.height - height) / 2, width, height };
}

export interface GraphEdgeEndpoint { kind: "conversation" | "group"; id: string }
export interface GraphAggregatedEdge {
  id: string;
  source: GraphEdgeEndpoint;
  target: GraphEdgeEndpoint;
  memberEdges: ConversationGraphEdgePlacement[];
  memberEdgeIds: string[];
  count: number;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  isSelectedPath: boolean;
}

/** Project structural edges onto visible nodes/groups while retaining inspectable original edges. */
export function aggregateGraphEdges(
  scene: ConversationGraphScene,
  collapsedGroupPlacements: ConversationGraphGroupPlacement[],
): GraphAggregatedEdge[] {
  const membership = new Map<string, ConversationGraphGroupPlacement>();
  for (const group of collapsedGroupPlacements) {
    for (const conversationId of group.conversationIds) {
      if (!membership.has(conversationId)) membership.set(conversationId, group);
    }
  }
  const nodes = new Map(scene.nodes.map((node) => [node.conversationId, node]));
  const result = new Map<string, GraphAggregatedEdge>();
  for (const edge of scene.edges) {
    const sourceGroup = membership.get(edge.parentConversationId);
    const targetGroup = membership.get(edge.childConversationId);
    if (sourceGroup && targetGroup?.groupId === sourceGroup.groupId) continue;
    const source: GraphEdgeEndpoint = sourceGroup ? { kind: "group", id: sourceGroup.groupId } : { kind: "conversation", id: edge.parentConversationId };
    const target: GraphEdgeEndpoint = targetGroup ? { kind: "group", id: targetGroup.groupId } : { kind: "conversation", id: edge.childConversationId };
    const id = JSON.stringify([source.kind, source.id, target.kind, target.id]);
    const memberEdgeId = JSON.stringify([edge.parentConversationId, edge.childConversationId]);
    const existing = result.get(id);
    if (existing) {
      if (!existing.memberEdgeIds.includes(memberEdgeId)) {
        existing.memberEdges.push(edge);
        existing.memberEdgeIds.push(memberEdgeId);
        existing.count += 1;
      }
      existing.isSelectedPath ||= edge.isSelectedPath;
      continue;
    }
    const sourceRect = sourceGroup ? getCollapsedGraphGroupRect(sourceGroup) : nodes.get(edge.parentConversationId);
    const targetRect = targetGroup ? getCollapsedGraphGroupRect(targetGroup) : nodes.get(edge.childConversationId);
    let { startX, startY, endX, endY } = edge;
    if ((sourceGroup || targetGroup) && sourceRect && targetRect) {
      const forwards = sourceRect.x + sourceRect.width / 2 <= targetRect.x + targetRect.width / 2;
      startX = sourceRect.x + (forwards ? sourceRect.width : 0);
      startY = sourceRect.y + sourceRect.height / 2;
      endX = targetRect.x + (forwards ? 0 : targetRect.width);
      endY = targetRect.y + targetRect.height / 2;
    }
    result.set(id, {
      id, source, target, memberEdges: [edge], memberEdgeIds: [memberEdgeId], count: 1,
      startX, startY, endX, endY, isSelectedPath: edge.isSelectedPath,
    });
  }
  return [...result.values()];
}
