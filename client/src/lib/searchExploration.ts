import type { Conversation, ConversationGroup, ThreadCategoryId } from "../types";
import type { ChatSearchResult } from "./conversationSearch";
import type { GraphEvidenceRef } from "./graphExploration";
import { summarizeAnnotationText } from "./annotationPreview";
import { getStandaloneNote, getStandaloneNoteContextMessageId } from "./standaloneNotes";
import { THREAD_CATEGORY_DEFINITIONS } from "./threadCategories";
import { getConversationRootId } from "./tree";
import { getCurrentDocumentText, getPrimaryDocumentSources } from "./documentSources";

export type SearchPurposeId = "decision" | "evidence" | "alternative" | "open-question";
export type SearchFacetKind = "topic" | "group" | "type" | "purpose";
export type SearchEvidenceRef = Omit<GraphEvidenceRef, "sourceKind"> & {
  sourceKind: GraphEvidenceRef["sourceKind"] | "annotation";
};
export interface SearchPassageResult extends ChatSearchResult {
  id: string;
  evidence: SearchEvidenceRef;
  /** Exact bounded source text; offsets and evidence.quote address this passage. */
  passage: string;
  updatedAt: string;
  facetIds: string[];
  purposeIds: SearchPurposeId[];
  /** Private annotations remain searchable locally and must not enter model requests. */
  localOnly: boolean;
}
export interface SearchFacet {
  id: string;
  label: string;
  kind: SearchFacetKind;
  /** Matching passages before pagination, with filters of this facet's kind omitted. */
  count: number;
  selected: boolean;
}
export interface SearchDirection {
  id: string;
  label: string;
  description: string;
  /** Complete next filter selection, preserving the other selected dimensions. */
  facetIds: string[];
  count: number;
}
export interface SearchExplorationOptions {
  conversations: Record<string, Conversation>;
  groups?: Record<string, ConversationGroup>;
  query: string;
  activeFacetIds?: string[];
  currentConversationId?: string;
  contextual?: boolean;
  categories?: Record<string, ThreadCategoryId>;
  /** Omit to return every match; counts and matchedConversationIds are never capped. */
  limit?: number;
}
export interface SearchExploration {
  results: SearchPassageResult[];
  facets: SearchFacet[];
  directions: SearchDirection[];
  totalCount: number;
  workspaceCount: number;
  matchedConversationIds: string[];
}

const PURPOSES: Array<{ id: SearchPurposeId; label: string; pattern: RegExp }> = [
  { id: "decision", label: "Decision", pattern: /\b(?:decided|decision|agreed to|chosen|selected|settled on|we (?:will|shall) use)\b/i },
  { id: "evidence", label: "Evidence", pattern: /\b(?:evidence|according to|results? show|study found|measured|measurements|benchmark|data shows|citation)\b|https?:\/\//i },
  { id: "alternative", label: "Alternative", pattern: /\b(?:alternatives?|instead|option [a-z\d]|trade[ -]?offs?|versus|another approach|on the other hand)\b/i },
  { id: "open-question", label: "Open question", pattern: /\b(?:open questions?|unresolved|unclear|unknown|need to (?:decide|investigate)|todo)\b|\b(?:what|why|how|when|where|which|who|can|could|should|would|is|are|do|does|will)\b[^?\n]{0,240}\?/i },
];
const STOP_WORDS = new Set("the and for that this with from what which have has are was were will would could should about into then than they their there here how why can does did our your you not but use using one also".split(" "));
const CONTEXT_PREFIX = getStandaloneNoteContextMessageId("");
const facetGroupId = (id: string) => `group:id:${encodeURIComponent(id)}`;
const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const normalizedWords = (value: string) => ` ${value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;

function contextWords(conversation?: Conversation) {
  if (!conversation) return new Set<string>();
  const content = conversation.document ? getCurrentDocumentText(conversation) : conversation.kind === "note" ? getStandaloneNote(conversation)?.content ?? ""
    : conversation.messages.filter((message) => message.role !== "system" && !message.id.startsWith(CONTEXT_PREFIX)).slice(-3).map((message) => message.content).join(" ");
  return new Set((`${conversation.title} ${content.slice(-4000)}`.toLowerCase().match(/[\p{L}][\p{L}\p{N}_-]{2,}/gu) ?? [])
    .filter((word) => !STOP_WORDS.has(word)).slice(0, 80));
}

/** Paragraph boundaries keep previews coherent; long paragraphs get bounded exact slices. */
function passages(content: string) {
  const result: Array<{ text: string; start: number; end: number }> = [];
  for (const match of content.matchAll(/\S[\s\S]*?(?=\r?\n[ \t]*\r?\n|$)/g)) {
    let start = match.index!;
    const end = start + match[0].trimEnd().length;
    while (start < end) {
      let stop = Math.min(start + 1200, end);
      if (stop < end) {
        const part = content.slice(start, stop);
        const boundary = Math.max(part.lastIndexOf(" "), part.lastIndexOf("\n"));
        if (boundary >= 600) stop = start + boundary;
        if (/[\uD800-\uDBFF]/.test(content[stop - 1])) stop--;
      }
      const text = content.slice(start, stop).trimEnd();
      if (text) result.push({ text, start, end: start + text.length });
      start = stop;
      while (start < end && /\s/.test(content[start])) start++;
    }
  }
  return result;
}

function dateLabel(value: string) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
}

function headingTopics(content: string) {
  const headings: Array<{ offset: number; id: string; label: string }> = [];
  let fence: string | null = null;
  for (const line of content.matchAll(/^.*$/gm)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line[0]);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const match = /^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/.exec(line[0]);
    if (!match) continue;
    const label = summarizeAnnotationText(match[1], 72);
    if (label.length < 4 || label.length > 65) continue;
    headings.push({ offset: line.index!, id: `topic:heading:${encodeURIComponent(label.toLowerCase())}`, label });
  }
  return headings;
}

type ParsedSource = {
  content: string;
  headings: ReturnType<typeof headingTopics>;
  parts: Array<ReturnType<typeof passages>[number] & { plain: string; purposeIds: SearchPurposeId[] }>;
};
// Query/filter changes should not parse every message's Markdown again. Immutable
// conversation objects keep this cache bounded to currently referenced workspace data.
const parsedSources = new WeakMap<Conversation, Map<string, ParsedSource>>();
function parseSource(conversation: Conversation, source: SearchEvidenceRef, content: string) {
  let sources = parsedSources.get(conversation);
  if (!sources) { sources = new Map(); parsedSources.set(conversation, sources); }
  const key = JSON.stringify([source.sourceKind, source.sourceBlockId, source.messageId, source.noteId]);
  const previous = sources.get(key);
  if (previous?.content === content) return previous;
  const parsed: ParsedSource = {
    content,
    headings: source.sourceKind === "conversation" ? [] : headingTopics(content),
    parts: passages(content).map((part) => ({ ...part, plain: summarizeAnnotationText(part.text, 1200), purposeIds: PURPOSES.filter((purpose) => purpose.pattern.test(part.text)).map((purpose) => purpose.id) })),
  };
  sources.set(key, parsed);
  return parsed;
}

/** All classification here uses local text rules or supplied categories, never an AI claim. */
export function buildSearchExploration({ conversations, groups = {}, query, activeFacetIds = [], currentConversationId, contextual = false, categories = {}, limit }: SearchExplorationOptions): SearchExploration {
  const definitions = new Map<string, Omit<SearchFacet, "count" | "selected">>();
  const define = (id: string, kind: SearchFacetKind, label: string) => definitions.set(id, { id, kind, label });
  for (const category of THREAD_CATEGORY_DEFINITIONS) define(`topic:${category.id}`, "topic", category.label);
  for (const group of Object.values(groups)) define(facetGroupId(group.id), "group", group.name);
  define("group:ungrouped", "group", "Ungrouped");
  define("type:chat", "type", "Chats");
  define("type:note", "type", "Notes");
  define("type:annotation", "type", "Private notes");
  for (const purpose of PURPOSES) define(`purpose:${purpose.id}`, "purpose", purpose.label);

  const groupIds = new Map<string, string[]>();
  for (const group of Object.values(groups)) for (const id of group.conversationIds) {
    groupIds.set(id, [...(groupIds.get(id) ?? []), facetGroupId(group.id)]);
  }
  const terms = [...new Set(query.trim().split(/\s+/).filter(Boolean))].map((term) => new RegExp(escapePattern(term), "iu"));
  const exactQuery = query.trim() ? new RegExp(escapePattern(query.trim()), "iu") : null;
  const currentWords = contextual ? contextWords(conversations[currentConversationId ?? ""]) : new Set<string>();
  const corpus: Array<SearchPassageResult & { rank: number }> = [];

  for (const conversation of Object.values(conversations)) {
    const rootId = getConversationRootId(conversations, conversation.id) ?? conversation.id;
    const rootTitle = conversations[rootId]?.title ?? conversation.title;
    const locationLabel = conversation.kind === "note" ? "Standalone note" : conversation.parentId ? "Branch conversation" : "Main chat";
    const memberships = groupIds.get(conversation.id) ?? ["group:ungrouped"];
    const assignedCategory = Object.hasOwn(categories, conversation.id) ? categories[conversation.id] : undefined;

    function add(content: string, source: SearchEvidenceRef, matchLabel: string, updatedAt: string, localOnly = false) {
      const { headings, parts } = parseSource(conversation, source, content);
      let headingIndex = -1;
      for (const part of parts) {
        const plain = part.plain;
        if (!plain) continue;
        const words = normalizedWords(`${conversation.title} ${plain}`);
        const topics = THREAD_CATEGORY_DEFINITIONS.filter((category) => category.id !== "general" &&
          (category.id === assignedCategory || category.keywords.some((keyword) => words.includes(normalizedWords(keyword))))).map((category) => `topic:${category.id}`);
        if (!topics.length) topics.push("topic:general");
        while (headingIndex + 1 < headings.length && headings[headingIndex + 1].offset < part.end) headingIndex++;
        const heading = headings[headingIndex];
        if (heading) {
          define(heading.id, "topic", heading.label);
          topics.push(heading.id);
        }
        const purposeIds = part.purposeIds;
        const type = localOnly ? "annotation" : conversation.kind === "note" ? "note" : "chat";
        const evidence: SearchEvidenceRef = { ...source, quote: part.text, startOffset: part.start, endOffset: part.end };
        const matchedTerms = terms.map((term) => term.exec(part.text));
        const matches = matchedTerms.every(Boolean);
        const firstMatch = terms.map((term) => term.exec(plain)).find(Boolean)?.index ?? 0;
        let previewStart = Math.max(0, firstMatch - 72);
        const nextWord = plain.indexOf(" ", previewStart);
        if (previewStart && nextWord >= 0 && nextWord < firstMatch) previewStart = nextWord + 1;
        const previewText = plain.slice(previewStart);
        const previewLimit = previewStart ? 219 : 220;
        const preview = `${previewStart ? "…" : ""}${previewText.length <= previewLimit ? previewText : `${previewText.slice(0, previewLimit - 1).trimEnd()}…`}`;
        const relatedWords = currentWords.size ? [...currentWords].filter((word) => words.includes(normalizedWords(word))).length : 0;
        corpus.push({
          id: JSON.stringify([conversation.id, source.sourceKind, source.sourceBlockId ?? source.messageId ?? source.noteId ?? "", part.start]),
          conversationId: conversation.id, title: conversation.title, rootTitle, locationLabel, matchLabel,
          preview, passage: part.text, evidence, updatedAt, updatedLabel: dateLabel(updatedAt),
          facetIds: [...topics, ...memberships, `type:${type}`, ...purposeIds.map((id) => `purpose:${id}`)],
          purposeIds, localOnly,
          rank: matches ? (exactQuery?.test(part.text) ? 10 : 0) + (source.sourceKind === "conversation" && terms.length ? 2 : 0) + Math.min(relatedWords, 6) : -1,
        });
      }
    }

    add(conversation.title, { conversationId: conversation.id, sourceKind: "conversation" }, conversation.kind === "note" ? "Note title" : "Chat title", conversation.updatedAt);
    for (const source of getPrimaryDocumentSources(conversation)) {
      add(source.content, { conversationId: conversation.id, sourceKind: source.sourceKind, sourceBlockId: source.sourceBlockId, messageId: source.messageId, noteId: source.noteId },
        source.sourceKind === "document" ? "Document passage" : source.sourceKind === "standalone-note" ? "Note content" : source.role === "assistant" ? "Assistant message" : "Your message", source.updatedAt);
    }
    const primaryNote = getStandaloneNote(conversation);
    for (const note of conversation.notes ?? []) {
      const primary = note === primaryNote;
      if (primary) continue;
      add(note.content, { conversationId: conversation.id, sourceKind: "annotation", noteId: note.id }, note.kind === "side-chat" ? "Private side note" : "Private margin note", note.updatedAt, true);
    }
  }

  const selected = [...new Set(activeFacetIds)];
  const matchesFilters = (result: SearchPassageResult, filters: string[], omittedKind?: SearchFacetKind) => {
    const selections = new Map<SearchFacetKind | "unknown", string[]>();
    for (const id of filters) {
      const kind = definitions.get(id)?.kind ?? "unknown";
      if (kind === omittedKind) continue;
      selections.set(kind, [...(selections.get(kind) ?? []), id]);
    }
    return [...selections.values()].every((ids) => ids.some((id) => result.facetIds.includes(id)));
  };
  const queryMatches = corpus.filter((result) => result.rank >= 0);
  const matches = queryMatches.filter((result) => matchesFilters(result, selected)).sort((a, b) =>
    b.rank - a.rank || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  const facets = [...definitions.values()].map((facet): SearchFacet => ({ ...facet, selected: selected.includes(facet.id),
    count: queryMatches.filter((result) => result.facetIds.includes(facet.id) && matchesFilters(result, selected, facet.kind)).length,
  })).filter((facet) => facet.count > 0 || facet.selected)
    .sort((a, b) => {
      const kinds = ["topic", "group", "type", "purpose"];
      if (a.kind !== b.kind) return kinds.indexOf(a.kind) - kinds.indexOf(b.kind);
      return a.kind === "topic"
        ? Number(b.id.startsWith("topic:heading:")) - Number(a.id.startsWith("topic:heading:")) || b.count - a.count || a.label.localeCompare(b.label)
        : 0;
    });

  const directions: SearchDirection[] = [];
  if (matches.length) {
    const seenSets: Set<string>[] = [];
    const candidates = ["purpose", "topic", "group"].flatMap((kind) => facets.filter((facet) => facet.kind === kind && !facet.selected && facet.id !== "topic:general" && facet.id !== "group:ungrouped")
      .sort((a, b) => (kind === "topic" ? Number(b.id.startsWith("topic:heading:")) - Number(a.id.startsWith("topic:heading:")) : 0) || b.count - a.count || a.label.localeCompare(b.label)));
    for (const facet of candidates) {
      const next = [...selected.filter((id) => definitions.get(id)?.kind !== facet.kind), facet.id];
      const members = queryMatches.filter((result) => matchesFilters(result, next));
      const ids = new Set(members.map((result) => result.conversationId));
      const passageIds = new Set(members.map((result) => result.id));
      if (members.length === matches.length && matches.every((result) => passageIds.has(result.id))) continue;
      if (!ids.size || seenSets.some((previous) => {
        const overlap = [...passageIds].filter((id) => previous.has(id)).length;
        return overlap / new Set([...passageIds, ...previous]).size >= 0.8;
      })) continue;
      directions.push({ id: facet.id, label: facet.kind === "purpose" ? `Explore ${facet.label.toLowerCase()}${facet.id === "purpose:evidence" ? "" : "s"}` : `Explore ${facet.label}`,
        description: `${members.length} ${members.length === 1 ? "passage" : "passages"} across ${ids.size} ${ids.size === 1 ? "chat or note" : "chats and notes"}`,
        facetIds: next, count: members.length });
      seenSets.push(passageIds);
      if (directions.length === 3) break;
    }
  }
  const requestedLimit = limit === undefined || !Number.isFinite(limit) ? matches.length : Math.max(0, Math.floor(limit));
  return { results: matches.slice(0, requestedLimit).map(({ rank: _rank, ...result }) => result), facets, directions,
    totalCount: matches.length, workspaceCount: corpus.length, matchedConversationIds: [...new Set(matches.map((result) => result.conversationId))] };
}
