import type { Conversation, ConversationGroup } from "../types";
import { getDocumentKind } from "./documentBreadcrumbs";
import { getCurrentDocumentText } from "./documentSources";
import { isStandaloneNoteConversation } from "./standaloneNotes";

/**
 * A lens narrows the map to the documents that match every filter. Documents
 * outside it stay on the map, greyed, so the shape of the vault is kept.
 */
export type MapDocumentType = "document" | "side" | "branch" | "marginNote" | "note" | "file" | "topic";
export type MapLensHas = "marginNotes" | "children" | "aiReplies" | "relations";
export type MapLensDateField = "edited" | "created";

export type MapLensFilter =
  | { id: string; kind: MapLensDateField; from: number | null; to: number | null }
  | { id: string; kind: "connections"; min: number; max: number | null }
  | { id: string; kind: "type"; values: MapDocumentType[] }
  | { id: string; kind: "tag"; values: string[] }
  | { id: string; kind: "nodeType"; values: string[] }
  | { id: string; kind: "group"; values: string[] }
  | { id: string; kind: "has"; value: MapLensHas }
  | { id: string; kind: "text"; query: string }
  | { id: string; kind: "words"; min: number; max: number | null }
  /** Documents within `depth` lines of one document; the rest of the map greys out around it. */
  | { id: string; kind: "near"; documentId: string; depth: number };

export type MapLensFilterKind = MapLensFilter["kind"];

export interface MapLens {
  filters: MapLensFilter[];
}

export interface SavedMapLens extends MapLens {
  id: string;
  name: string;
}

export const EMPTY_MAP_LENS: MapLens = { filters: [] };

export const MAP_LENS_FILTER_KINDS: Array<{ kind: MapLensFilterKind; label: string }> = [
  { kind: "edited", label: "Last edited" },
  { kind: "created", label: "Created" },
  { kind: "connections", label: "Connections" },
  { kind: "type", label: "Kind of document" },
  { kind: "tag", label: "Tag" },
  { kind: "nodeType", label: "Type property" },
  { kind: "group", label: "Group" },
  { kind: "has", label: "Has…" },
  { kind: "text", label: "Contains words" },
  { kind: "words", label: "Length" },
  { kind: "near", label: "Near the selected document" },
];

export const MAP_DOCUMENT_TYPES: Array<{ value: MapDocumentType; label: string }> = [
  { value: "document", label: "Main documents" },
  { value: "side", label: "Side documents" },
  { value: "branch", label: "Branches" },
  { value: "marginNote", label: "Margin notes" },
  { value: "note", label: "Notes" },
  { value: "file", label: "PDFs and images" },
  { value: "topic", label: "Saved topics" },
];

export const MAP_LENS_HAS: Array<{ value: MapLensHas; label: string }> = [
  { value: "marginNotes", label: "Margin notes" },
  { value: "children", label: "Children" },
  { value: "aiReplies", label: "AI replies" },
  { value: "relations", label: "Typed relations" },
];

export const MAP_LENS_CONNECTIONS: Array<{ min: number; max: number | null; label: string }> = [
  { min: 0, max: 0, label: "No connections" },
  { min: 1, max: null, label: "1 or more" },
  { min: 3, max: null, label: "3 or more" },
  { min: 10, max: null, label: "10 or more" },
];

export const MAP_LENS_LENGTHS: Array<{ min: number; max: number | null; label: string }> = [
  { min: 0, max: 0, label: "Empty" },
  { min: 1, max: 99, label: "Under 100 words" },
  { min: 100, max: 999, label: "100 to 999 words" },
  { min: 1000, max: null, label: "1,000 words or more" },
];

const DAY = 86_400_000;

export function mapDocumentType(conversation: Conversation): MapDocumentType {
  if (conversation.publicTopic) return "topic";
  if (conversation.vaultFile) return "file";
  if (isStandaloneNoteConversation(conversation)) return "note";
  const kind = getDocumentKind(conversation);
  return kind === "main" ? "document" : kind === "note" ? "marginNote" : kind;
}

const textCache = new WeakMap<Conversation, { lower: string; words: number }>();
function documentText(conversation: Conversation) {
  let cached = textCache.get(conversation);
  if (!cached) {
    const text = `${conversation.title}\n${getCurrentDocumentText(conversation)}`;
    const body = text.slice(conversation.title.length + 1).trim();
    cached = { lower: text.toLowerCase(), words: body ? body.split(/\s+/).length : 0 };
    textCache.set(conversation, cached);
  }
  return cached;
}

function time(value: string) {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function lensDate(conversation: Conversation, field: MapLensDateField) {
  return time(field === "edited" ? conversation.updatedAt : conversation.createdAt);
}

export interface MapLensContext {
  conversations: Record<string, Conversation>;
  groups: Record<string, ConversationGroup>;
  /** Number of map lines touching each document. */
  connectionCounts: Map<string, number>;
  /** Documents within `depth` map lines of a document, itself included. Needed only for "near" filters. */
  neighborhood?: (documentId: string, depth: number) => Set<string>;
}

function matchesFilter(conversation: Conversation, filter: MapLensFilter, context: MapLensContext, groupsOf: Map<string, Set<string>>,
  near: Map<string, Set<string>>) {
  switch (filter.kind) {
    case "near":
      return near.get(filter.id)?.has(conversation.id) ?? false;
    case "edited":
    case "created": {
      const at = lensDate(conversation, filter.kind);
      if (at === null) return false;
      return (filter.from === null || at >= filter.from) && (filter.to === null || at < filter.to);
    }
    case "connections": {
      const count = context.connectionCounts.get(conversation.id) ?? 0;
      return count >= filter.min && (filter.max === null || count <= filter.max);
    }
    case "type":
      return !filter.values.length || filter.values.includes(mapDocumentType(conversation));
    case "tag":
      return !filter.values.length || filter.values.some((tag) => conversation.tags?.includes(tag));
    case "nodeType":
      return !filter.values.length || (!!conversation.nodeType && filter.values.includes(conversation.nodeType));
    case "group":
      return !filter.values.length || filter.values.some((id) => groupsOf.get(conversation.id)?.has(id));
    case "has":
      if (filter.value === "children") return conversation.childIds.some((id) => context.conversations[id]);
      if (filter.value === "marginNotes") return !!conversation.notes?.length
        || conversation.childIds.some((id) => context.conversations[id]?.document?.marginNote);
      if (filter.value === "aiReplies") return conversation.messages.some((message) => message.role === "assistant");
      return !!conversation.relations?.length;
    case "text": {
      const terms = filter.query.toLowerCase().split(/\s+/).filter(Boolean);
      if (!terms.length) return true;
      const { lower } = documentText(conversation);
      return terms.every((term) => lower.includes(term));
    }
    case "words": {
      const { words } = documentText(conversation);
      return words >= filter.min && (filter.max === null || words <= filter.max);
    }
  }
}

/** The ids among `ids` that pass every filter, or null when the lens has no filters. */
export function matchMapLens(ids: Iterable<string>, lens: MapLens, context: MapLensContext): Set<string> | null {
  if (!lens.filters.length) return null;
  const groupsOf = new Map<string, Set<string>>();
  if (lens.filters.some((filter) => filter.kind === "group")) {
    for (const group of Object.values(context.groups)) for (const id of group.conversationIds) {
      const set = groupsOf.get(id);
      if (set) set.add(group.id); else groupsOf.set(id, new Set([group.id]));
    }
  }
  const near = new Map<string, Set<string>>();
  for (const filter of lens.filters) if (filter.kind === "near") near.set(filter.id, context.neighborhood?.(filter.documentId, filter.depth) ?? new Set([filter.documentId]));
  const matched = new Set<string>();
  for (const id of ids) {
    const conversation = context.conversations[id];
    if (conversation && lens.filters.every((filter) => matchesFilter(conversation, filter, context, groupsOf, near))) matched.add(id);
  }
  return matched;
}

export function countConnections(edges: Iterable<{ sourceId: string; targetId: string }>) {
  const counts = new Map<string, number>();
  for (const { sourceId, targetId } of edges) {
    counts.set(sourceId, (counts.get(sourceId) ?? 0) + 1);
    counts.set(targetId, (counts.get(targetId) ?? 0) + 1);
  }
  return counts;
}

/** Values in use across the vault, most common first, for tag and type pickers. */
export function lensValueCounts(conversations: Iterable<Conversation>, pick: (conversation: Conversation) => string[] | undefined) {
  const counts = new Map<string, number>();
  for (const conversation of conversations) for (const value of pick(conversation) ?? []) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export interface LensTimelineBin {
  start: number;
  end: number;
  total: number;
  matched: number;
}

/** Equal-width time bins (whole days, at most `maxBins`) over the documents' dates, with how many pass the lens. */
export function lensTimeline(ids: Iterable<string>, conversations: Record<string, Conversation>, field: MapLensDateField,
  matched: Set<string> | null, maxBins = 52): LensTimelineBin[] {
  const dated: Array<[string, number]> = [];
  let first = Infinity, last = -Infinity;
  for (const id of ids) {
    const conversation = conversations[id];
    const at = conversation ? lensDate(conversation, field) : null;
    if (at === null) continue;
    dated.push([id, at]);
    if (at < first) first = at;
    if (at > last) last = at;
  }
  if (!dated.length) return [];
  const start = Math.floor(first / DAY) * DAY;
  const days = Math.max(1, Math.ceil((last + 1 - start) / DAY));
  const width = Math.ceil(days / Math.min(maxBins, days)) * DAY;
  const count = Math.max(1, Math.ceil((last + 1 - start) / width));
  const bins = Array.from({ length: count }, (_, index) => ({ start: start + index * width, end: start + (index + 1) * width, total: 0, matched: 0 }));
  for (const [id, at] of dated) {
    const bin = bins[Math.min(count - 1, Math.floor((at - start) / width))];
    bin.total++;
    if (!matched || matched.has(id)) bin.matched++;
  }
  return bins;
}

export const MAP_LENS_NEAR_DEPTHS = [1, 2, 3];

/** A new filter of `kind`; a "near" filter centers on `documentId`. */
export function newLensFilter(kind: MapLensFilterKind, now = Date.now(), documentId = ""): MapLensFilter {
  const id = `${kind}-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  switch (kind) {
    case "edited":
    case "created": return { id, kind, from: Math.floor((now - 30 * DAY) / DAY) * DAY, to: null };
    case "connections": return { id, kind, min: 3, max: null };
    case "type": return { id, kind, values: ["document"] };
    case "tag": case "nodeType": case "group": return { id, kind, values: [] };
    case "has": return { id, kind, value: "marginNotes" };
    case "text": return { id, kind, query: "" };
    case "words": return { id, kind, min: 1000, max: null };
    case "near": return { id, kind, documentId, depth: 1 };
  }
}

const shortDate = (value: number) => new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

export function describeLensFilter(filter: MapLensFilter, groups: Record<string, ConversationGroup> = {},
  conversations: Record<string, Conversation> = {}): string {
  const list = (values: string[], empty: string) => !values.length ? empty : values.length <= 2 ? values.join(", ") : `${values.slice(0, 2).join(", ")} +${values.length - 2}`;
  switch (filter.kind) {
    case "edited":
    case "created": {
      const label = filter.kind === "edited" ? "Edited" : "Created";
      if (filter.from !== null && filter.to !== null) return `${label} ${shortDate(filter.from)} – ${shortDate(filter.to - 1)}`;
      if (filter.from !== null) return `${label} since ${shortDate(filter.from)}`;
      if (filter.to !== null) return `${label} before ${shortDate(filter.to)}`;
      return `${label}: any time`;
    }
    case "connections":
      if (filter.max === 0) return "No connections";
      return filter.max === null ? `${filter.min}+ connections` : `${filter.min}–${filter.max} connections`;
    case "type": return list(filter.values.map((value) => MAP_DOCUMENT_TYPES.find((type) => type.value === value)?.label ?? value), "Any kind");
    case "tag": return `Tag: ${list(filter.values.map((tag) => `#${tag}`), "any")}`;
    case "nodeType": return `Type: ${list(filter.values, "any")}`;
    case "group": return `Group: ${list(filter.values.map((id) => groups[id]?.name ?? "Deleted group"), "any")}`;
    case "has": return `Has ${MAP_LENS_HAS.find((option) => option.value === filter.value)?.label.toLowerCase()}`;
    case "text": return filter.query.trim() ? `Contains “${filter.query.trim()}”` : "Contains…";
    case "words": return MAP_LENS_LENGTHS.find((option) => option.min === filter.min && option.max === filter.max)?.label ?? `${filter.min}+ words`;
    case "near": {
      const title = conversations[filter.documentId]?.title || "a removed document";
      return `Within ${filter.depth} ${filter.depth === 1 ? "step" : "steps"} of ${title.length > 28 ? `${title.slice(0, 27)}…` : title}`;
    }
  }
}

/** Parses a stored lens, dropping anything malformed. */
export function readMapLens(value: unknown): MapLens {
  const filters = (value as MapLens | null)?.filters;
  if (!Array.isArray(filters)) return EMPTY_MAP_LENS;
  const kinds = new Set(MAP_LENS_FILTER_KINDS.map((option) => option.kind));
  return { filters: filters.filter((filter): filter is MapLensFilter => !!filter && typeof filter.id === "string" && kinds.has(filter.kind)
    && (filter.kind !== "near" || (typeof filter.documentId === "string" && Number.isInteger(filter.depth) && filter.depth > 0))) };
}
