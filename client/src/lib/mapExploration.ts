import type { PublicExpansion, PublicTopic } from "./publicKnowledge";
import type { PrivateAnswer, PublicAnswerTopic } from "./publicMapApi";
import type { PublicGraphState } from "./publicGraphScene";
import { isUrlMapGraph, type UrlMapGraph } from "./urlMap";
import { wikipediaArticleUrl } from "./wikipedia";
import { wikipediaConnectionKind } from "./publicTopicWorkspace";

/**
 * What the map search, links and "Show around" have explored: dashed
 * previews on the map until the person keeps them, and a history of
 * everything explored but not yet in the workspace.
 */

/** A preview hangs off a document in the map or off another preview. */
export type ExploredParent = { kind: "document"; id: string } | { kind: "item"; id: string };
export type ExploredConnectionKind = "broader" | "narrower" | "related";

export type ExploredSource =
  | { kind: "topic"; topic: PublicTopic }
  | { kind: "page"; url: string; nodeId: string }
  | { kind: "answer"; answer: PrivateAnswer };

export interface ExploredItem {
  id: string;
  label: string;
  detail: string;
  /** Where it came from, as the card shows it: "Wikipedia · See also", "From angular.dev". */
  via: string;
  parent: ExploredParent | null;
  /** How it joins its parent once kept. */
  connection?: { kind: ExploredConnectionKind; label: string };
  source: ExploredSource;
  exploredAt: string;
  /** A dashed preview on the map; otherwise it is only in history. */
  onMap: boolean;
  batchId: string;
}

/** One search, page or "Show around", as history groups them. */
export interface ExploredBatch { id: string; title: string; createdAt: string }

export interface MapExploration {
  version: 1;
  items: Record<string, ExploredItem>;
  batches: Record<string, ExploredBatch>;
  /** Mapped pages by address, so a page topic can be kept with its evidence. */
  pages: Record<string, UrlMapGraph>;
  /** Wikipedia connections already read under a document or preview, by `parentKey`. */
  expansions: Record<string, { nextOffset: number; hasMore: boolean }>;
  /** The old public map was copied into history once. */
  importedPublicMap?: boolean;
}

export const MAX_EXPLORED_ITEMS = 400;
export const MAX_EXPLORED_PAGES = 20;

export function emptyExploration(): MapExploration {
  return { version: 1, items: {}, batches: {}, pages: {}, expansions: {} };
}

export const parentKey = (parent: ExploredParent) => `${parent.kind}:${parent.id}`;
export const topicItemId = (topic: Pick<PublicTopic, "id">) => `topic:${topic.id}`;
export const pageItemId = (nodeId: string) => `page:${nodeId}`;

/** A web address typed or pasted into the map. Bare domains count; plain words do not. */
export function webAddress(text: string): string | null {
  const value = text.trim();
  if (!value || /\s/.test(value) || value.length > 2048) return null;
  const candidate = /^https?:\/\//i.test(value) ? value
    : /^(www\.)?[a-z\d-]+(\.[a-z\d-]+)*\.[a-z]{2,}(?::\d+)?(\/\S*)?$/i.test(value) ? `https://${value}` : null;
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return ["http:", "https:"].includes(url.protocol) && url.hostname.includes(".") ? url.href : null;
  } catch { return null; }
}

/** Only a full http(s) address is certainly a link; "node.js" may be a topic. */
export function isFullWebAddress(text: string) {
  return /^https?:\/\/\S+$/i.test(text.trim()) && webAddress(text) !== null;
}

export function publicTopicFromAnswer(topic: PublicAnswerTopic, retrievedAt: string): PublicTopic {
  return { id: topic.id, aliases: [], label: topic.label, description: topic.description,
    wikidataUrl: `https://www.wikidata.org/wiki/${topic.id}`, wikipediaUrl: wikipediaArticleUrl(topic.label), retrievedAt };
}

const hostname = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };

interface ItemContext { parent: ExploredParent | null; batchId: string; exploredAt: string }

export function topicItem(topic: PublicTopic, context: ItemContext, extra: { via?: string; connection?: ExploredItem["connection"] } = {}): ExploredItem {
  return { id: topicItemId(topic), label: topic.label, detail: topic.description, via: extra.via ?? "Wikipedia",
    parent: context.parent, ...(extra.connection ? { connection: extra.connection } : {}),
    source: { kind: "topic", topic }, exploredAt: context.exploredAt, onMap: true, batchId: context.batchId };
}

/** One page of Wikipedia connections, as previews under `parent`. */
export function expansionItems(expansion: PublicExpansion, context: ItemContext): ExploredItem[] {
  const topics = new Map(expansion.topics.map((topic) => [topic.id, topic]));
  return expansion.relations.flatMap((relation) => {
    const topic = relation.sourceId === expansion.topic.id ? topics.get(relation.targetId) : undefined;
    return topic ? [topicItem(topic, context, { via: `Wikipedia · ${relation.label}`,
      connection: { kind: wikipediaConnectionKind(relation.propertyId), label: `Wikipedia · ${relation.label}` } })] : [];
  });
}

/** A mapped page: its main topic under `parent`, the rest under the topic that first reaches them. */
export function pageItems(graph: UrlMapGraph, context: ItemContext): ExploredItem[] {
  const site = hostname(graph.source.url);
  const items: ExploredItem[] = [];
  const reached = new Set([graph.rootId]);
  const queue: Array<{ id: string; parent: ExploredParent | null; label?: string }> = [{ id: graph.rootId, parent: context.parent }];
  for (let index = 0; index < queue.length; index += 1) {
    const { id, parent, label } = queue[index];
    const node = graph.nodes.find((item) => item.id === id)!;
    items.push({ id: pageItemId(node.id), label: node.label, detail: node.summary,
      via: id === graph.rootId ? `Page · ${site}` : `From ${site}${label ? ` · ${label}` : ""}`,
      parent, ...(label ? { connection: { kind: "related" as const, label } } : {}),
      source: { kind: "page", url: graph.source.url, nodeId: node.id }, exploredAt: context.exploredAt, onMap: true, batchId: context.batchId });
    for (const edge of graph.edges) {
      const other = edge.sourceId === id ? edge.targetId : edge.targetId === id ? edge.sourceId : null;
      if (other && !reached.has(other)) { reached.add(other); queue.push({ id: other, parent: { kind: "item", id: pageItemId(node.id) }, label: edge.label }); }
    }
  }
  // Topics the page names without connecting them still belong to its main topic.
  for (const node of graph.nodes) if (!reached.has(node.id)) items.push({ id: pageItemId(node.id), label: node.label, detail: node.summary,
    via: `From ${site}`, parent: { kind: "item", id: pageItemId(graph.rootId) }, source: { kind: "page", url: graph.source.url, nodeId: node.id },
    exploredAt: context.exploredAt, onMap: true, batchId: context.batchId });
  return items;
}

/** An AI answer under `parent`, with the topics it names under the answer. */
export function answerItems(answer: PrivateAnswer, id: string, context: ItemContext): ExploredItem[] {
  const answerId = `answer:${id}`;
  return [
    { id: answerId, label: answer.question, detail: answer.answer, via: "Ask AI", parent: context.parent,
      source: { kind: "answer", answer }, exploredAt: context.exploredAt, onMap: true, batchId: context.batchId },
    ...answer.related.map((topic) => topicItem(publicTopicFromAnswer(topic, context.exploredAt), { ...context, parent: { kind: "item", id: answerId } },
      { via: `Ask AI · ${topic.relation}`, connection: { kind: "related", label: topic.relation } })),
  ];
}

/** Whether `ancestor` is `id` or holds it through preview parents. */
function holds(items: Record<string, ExploredItem>, ancestor: string, id: string) {
  const seen = new Set<string>();
  for (let current: string | undefined = id; current && !seen.has(current); ) {
    if (current === ancestor) return true;
    seen.add(current);
    const parent: ExploredParent | null | undefined = items[current]?.parent;
    current = parent?.kind === "item" ? parent.id : undefined;
  }
  return false;
}

/**
 * Adds what was just explored, shown on the map. Something already on the map
 * stays where it is, so previews never jump; something only in history comes
 * back in its new place, unless that would put it under itself.
 */
export function addExplored(state: MapExploration, batch: ExploredBatch, explored: ExploredItem[], pages: UrlMapGraph[] = []): MapExploration {
  if (!explored.length) return state;
  const items = { ...state.items };
  for (const item of explored) {
    const previous = items[item.id];
    const stays = previous && (previous.onMap || (item.parent?.kind === "item" && holds(items, item.id, item.parent.id)));
    items[item.id] = stays ? { ...previous, onMap: true } : item;
  }
  const next = { ...state, items, batches: { ...state.batches, [batch.id]: batch },
    pages: { ...state.pages, ...Object.fromEntries(pages.map((graph) => [graph.source.url, graph])) } };
  return capExploration(next);
}

export function setOnMap(state: MapExploration, ids: Iterable<string>, onMap: boolean): MapExploration {
  let items: Record<string, ExploredItem> | null = null;
  for (const id of ids) {
    const item = (items ?? state.items)[id];
    if (!item || item.onMap === onMap) continue;
    items ??= { ...state.items };
    items[id] = { ...item, onMap };
  }
  return items ? { ...state, items } : state;
}

export function setExpansion(state: MapExploration, parent: ExploredParent, page: { nextOffset: number; hasMore: boolean }): MapExploration {
  return { ...state, expansions: { ...state.expansions, [parentKey(parent)]: page } };
}

/**
 * Removes items. Previews under a removed one move up to its parent, or to
 * `replacement` (the note it became when it was kept).
 */
function removeItems(state: MapExploration, removed: Map<string, ExploredParent | null>): MapExploration {
  if (!removed.size) return state;
  const resolve = (parent: ExploredParent | null): ExploredParent | null => {
    const seen = new Set<string>();
    while (parent?.kind === "item" && removed.has(parent.id) && !seen.has(parent.id)) { seen.add(parent.id); parent = removed.get(parent.id)!; }
    return parent;
  };
  const items: Record<string, ExploredItem> = {};
  for (const [id, item] of Object.entries(state.items)) {
    if (removed.has(id)) continue;
    const parent = resolve(item.parent);
    items[id] = parent === item.parent ? item : { ...item, parent };
  }
  const expansions = Object.fromEntries(Object.entries(state.expansions).filter(([key]) => !key.startsWith("item:") || !removed.has(key.slice(5))));
  return pruneUnused({ ...state, items, expansions });
}

/** Drops batches with no items and pages no item comes from. */
function pruneUnused(state: MapExploration): MapExploration {
  const batchIds = new Set(Object.values(state.items).map((item) => item.batchId));
  const pageUrls = new Set(Object.values(state.items).flatMap((item) => item.source.kind === "page" ? [item.source.url] : []));
  return { ...state,
    batches: Object.fromEntries(Object.entries(state.batches).filter(([id]) => batchIds.has(id))),
    pages: Object.fromEntries(Object.entries(state.pages).filter(([url]) => pageUrls.has(url))) };
}

/** Removes items from history; previews under them move up a level. */
export function forgetExplored(state: MapExploration, ids: Iterable<string>): MapExploration {
  return removeItems(state, new Map([...ids].filter((id) => state.items[id]).map((id) => [id, state.items[id].parent])));
}

export function forgetBatch(state: MapExploration, batchId: string): MapExploration {
  return forgetExplored(state, Object.values(state.items).filter((item) => item.batchId === batchId).map((item) => item.id));
}

/**
 * Items now in the workspace leave history, and what hung off them hangs off
 * the note instead. With `documentExists`, previews of a removed document lose
 * their place; without it (while a vault is still loading) they keep it.
 * Returns the same object when nothing changed.
 */
export function settleExplored(state: MapExploration, savedAs: (item: ExploredItem) => string | null, documentExists: (id: string) => boolean = () => true): MapExploration {
  const kept = new Map<string, ExploredParent | null>();
  for (const item of Object.values(state.items)) {
    const id = savedAs(item);
    if (id) kept.set(item.id, { kind: "document", id });
  }
  let next = removeItems(state, kept);
  let orphaned: Record<string, ExploredItem> | null = null;
  for (const [id, item] of Object.entries(next.items)) {
    if (item.parent?.kind !== "document" || documentExists(item.parent.id)) continue;
    orphaned ??= { ...next.items };
    orphaned[id] = { ...item, parent: null };
  }
  if (orphaned) next = { ...next, items: orphaned };
  return kept.size || orphaned ? next : state;
}

/** Keeps history bounded: the oldest items not on the map go first. */
export function capExploration(state: MapExploration): MapExploration {
  const items = Object.values(state.items);
  let next = state;
  if (items.length > MAX_EXPLORED_ITEMS) {
    const removable = items.filter((item) => !item.onMap).sort((a, b) => a.exploredAt.localeCompare(b.exploredAt));
    next = forgetExplored(next, removable.slice(0, items.length - MAX_EXPLORED_ITEMS).map((item) => item.id));
  }
  // Mapped pages carry their summaries, so only the oldest pages with nothing left on the map go.
  const pages = Object.values(next.pages);
  if (pages.length > MAX_EXPLORED_PAGES) {
    const shown = new Set(Object.values(next.items).flatMap((item) => item.source.kind === "page" && item.onMap ? [item.source.url] : []));
    const dropped = new Set(pages.filter((page) => !shown.has(page.source.url)).sort((a, b) => a.source.retrievedAt.localeCompare(b.source.retrievedAt))
      .slice(0, pages.length - MAX_EXPLORED_PAGES).map((page) => page.source.url));
    if (dropped.size) next = forgetExplored(next, Object.values(next.items).filter((item) => item.source.kind === "page" && dropped.has(item.source.url)).map((item) => item.id));
  }
  return next === state ? state : pruneUnused(next);
}

/** Children of each preview and document, oldest first, for layout and history. */
export function exploredChildren(items: Iterable<ExploredItem>) {
  const children = new Map<string, ExploredItem[]>();
  for (const item of items) {
    const key = item.parent ? parentKey(item.parent) : "root";
    children.set(key, [...children.get(key) ?? [], item]);
  }
  for (const list of children.values()) list.sort((a, b) => a.exploredAt.localeCompare(b.exploredAt) || a.label.localeCompare(b.label));
  return children;
}

/** Combines two copies (this device and the account), newest item wins. */
export function mergeExplorations(first: MapExploration, second: MapExploration): MapExploration {
  const items = { ...first.items };
  for (const [id, item] of Object.entries(second.items)) if (!items[id] || items[id].exploredAt < item.exploredAt) items[id] = item;
  const expansions = { ...first.expansions };
  for (const [key, page] of Object.entries(second.expansions)) if (!expansions[key] || expansions[key].nextOffset < page.nextOffset) expansions[key] = page;
  return capExploration(pruneUnused({ version: 1, items, batches: { ...first.batches, ...second.batches }, pages: { ...first.pages, ...second.pages }, expansions,
    ...(first.importedPublicMap || second.importedPublicMap ? { importedPublicMap: true } : {}) }));
}

/** Copies the topics of the old public map into history, keeping how they were reached. */
export function importPublicMap(state: MapExploration, graph: PublicGraphState | null | undefined, importedAt: string): MapExploration {
  if (state.importedPublicMap) return state;
  if (!graph?.topics || !Object.keys(graph.topics).length) return { ...state, importedPublicMap: true };
  const batch: ExploredBatch = { id: "public-map", title: "Earlier public map", createdAt: importedAt };
  const parents = new Map<string, { parent: string; connection: ExploredItem["connection"] }>();
  for (const [id, expansion] of Object.entries(graph.expansions ?? {})) {
    for (const relation of expansion.relations ?? []) {
      const child = relation.sourceId === id ? relation.targetId : relation.targetId === id ? relation.sourceId : null;
      if (child && child !== id && !parents.has(child) && !(graph.roots ?? []).includes(child)) parents.set(child, { parent: id,
        connection: { kind: relation.propertyId?.startsWith("wikipedia-") ? wikipediaConnectionKind(relation.propertyId) : "related", label: relation.label } });
    }
  }
  const items: ExploredItem[] = [];
  for (const topic of Object.values(graph.topics)) {
    if (state.items[topicItemId(topic)] || typeof topic?.label !== "string") continue;
    const link = parents.get(topic.id);
    const parent = link && graph.topics[link.parent] && !holdsLegacy(parents, topic.id, link.parent) ? { kind: "item" as const, id: topicItemId({ id: link.parent }) } : null;
    items.push({ ...topicItem(topic, { parent, batchId: batch.id, exploredAt: topic.retrievedAt || importedAt },
      { via: "Wikipedia · earlier public map", ...(parent && link?.connection ? { connection: link.connection } : {}) }), onMap: false });
  }
  const next = items.length ? addExplored(state, batch, items) : state;
  return { ...next, importedPublicMap: true };
}

function holdsLegacy(parents: Map<string, { parent: string }>, id: string, start: string) {
  const seen = new Set<string>();
  for (let current: string | undefined = start; current && !seen.has(current); current = parents.get(current)?.parent) {
    if (current === id) return true;
    seen.add(current);
  }
  return false;
}

const text = (value: unknown, maximum: number): value is string => typeof value === "string" && value.length <= maximum;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function validParent(value: unknown): value is ExploredParent | null {
  return value === null || (record(value) && (value.kind === "document" || value.kind === "item") && text(value.id, 300));
}

function validSource(value: unknown): value is ExploredSource {
  if (!record(value)) return false;
  if (value.kind === "topic") return record(value.topic) && text(value.topic.id, 40) && text(value.topic.label, 300) && text(value.topic.description, 2000) && Array.isArray(value.topic.aliases);
  if (value.kind === "page") return text(value.url, 2048) && text(value.nodeId, 64);
  if (value.kind === "answer") return record(value.answer) && text(value.answer.question, 500) && text(value.answer.answer, 3000) && Array.isArray(value.answer.related);
  return false;
}

/** Reads a stored copy, dropping anything malformed. Returns null when it is not one. */
export function parseExploration(value: unknown): MapExploration | null {
  if (!record(value) || value.version !== 1 || !record(value.items) || !record(value.batches)) return null;
  const items: Record<string, ExploredItem> = {};
  for (const [id, item] of Object.entries(value.items)) {
    if (!record(item) || item.id !== id || !text(item.label, 500) || !text(item.detail, 3000) || !text(item.via, 300) || !validParent(item.parent)
      || !validSource(item.source) || !text(item.exploredAt, 64) || typeof item.onMap !== "boolean" || !text(item.batchId, 200)) continue;
    items[id] = item as unknown as ExploredItem;
  }
  const batches: Record<string, ExploredBatch> = {};
  for (const [id, batch] of Object.entries(value.batches)) if (record(batch) && batch.id === id && text(batch.title, 500) && text(batch.createdAt, 64)) batches[id] = batch as unknown as ExploredBatch;
  const pages: Record<string, UrlMapGraph> = {};
  if (record(value.pages)) for (const [url, graph] of Object.entries(value.pages)) if (isUrlMapGraph(graph) && graph.source.url === url) pages[url] = graph;
  const expansions: MapExploration["expansions"] = {};
  if (record(value.expansions)) for (const [key, page] of Object.entries(value.expansions)) {
    if (record(page) && Number.isSafeInteger(page.nextOffset) && (page.nextOffset as number) >= 0 && typeof page.hasMore === "boolean") expansions[key] = { nextOffset: page.nextOffset as number, hasMore: page.hasMore };
  }
  // A page topic without its page cannot be kept, so it is left out.
  for (const [id, item] of Object.entries(items)) if (item.source.kind === "page" && !pages[item.source.url]) delete items[id];
  for (const item of Object.values(items)) if (!batches[item.batchId]) batches[item.batchId] = { id: item.batchId, title: "Explored", createdAt: item.exploredAt };
  return pruneUnused({ version: 1, items, batches, pages, expansions, ...(value.importedPublicMap === true ? { importedPublicMap: true } : {}) });
}

export interface PreviewBox { x: number; y: number; width: number; height: number }
export const PREVIEW_CARD = { width: 190, height: 54 };
const COLUMN_GAP = 48;
const ROW_GAP = 10;
const GROUP_GAP = 24;

/** One place previews start from: a document's card, or the open space beside the map. */
export interface PreviewGroup { anchor: PreviewBox; rootIds: string[] }

/**
 * Lays preview trees out to the right of their anchors in screen pixels, so
 * cards stay readable at any zoom. Groups that would overlap move down.
 */
export function layoutPreviews(groups: PreviewGroup[], childrenOf: (id: string) => string[]): Map<string, PreviewBox> {
  const boxes = new Map<string, PreviewBox>();
  const heights = new Map<string, number>();
  const height = (id: string, seen = new Set<string>()): number => {
    if (heights.has(id)) return heights.get(id)!;
    seen.add(id);
    const children = childrenOf(id).filter((child) => !seen.has(child));
    const total = Math.max(PREVIEW_CARD.height, children.reduce((sum, child) => sum + height(child, seen), 0) + ROW_GAP * Math.max(0, children.length - 1));
    heights.set(id, total);
    return total;
  };
  const place = (id: string, x: number, top: number) => {
    if (boxes.has(id)) return;
    const band = height(id);
    boxes.set(id, { x, y: top + (band - PREVIEW_CARD.height) / 2, ...PREVIEW_CARD });
    let y = top + (band - Math.max(PREVIEW_CARD.height, childrenOf(id).reduce((sum, child) => sum + height(child), 0) + ROW_GAP * Math.max(0, childrenOf(id).length - 1))) / 2;
    for (const child of childrenOf(id)) {
      if (boxes.has(child)) continue;
      place(child, x + PREVIEW_CARD.width + COLUMN_GAP, y);
      y += height(child) + ROW_GAP;
    }
  };
  const placed: PreviewBox[] = [];
  for (const group of groups) {
    const roots = group.rootIds.filter((id) => !boxes.has(id));
    if (!roots.length) continue;
    const total = roots.reduce((sum, id) => sum + height(id), 0) + ROW_GAP * (roots.length - 1);
    const x = group.anchor.x + group.anchor.width + COLUMN_GAP;
    let top = group.anchor.y + group.anchor.height / 2 - total / 2;
    const width = Math.max(...roots.map((id) => treeWidth(id, childrenOf)));
    for (let moved = true; moved; ) {
      moved = false;
      for (const other of placed) {
        if (x < other.x + other.width && other.x < x + width && top < other.y + other.height + GROUP_GAP && other.y < top + total + GROUP_GAP) {
          top = other.y + other.height + GROUP_GAP; moved = true;
        }
      }
    }
    placed.push({ x, y: top, width, height: total });
    for (const id of roots) { place(id, x, top); top += height(id) + ROW_GAP; }
  }
  return boxes;
}

function treeWidth(id: string, childrenOf: (id: string) => string[], seen = new Set<string>()): number {
  seen.add(id);
  const children = childrenOf(id).filter((child) => !seen.has(child));
  return PREVIEW_CARD.width + (children.length ? COLUMN_GAP + Math.max(...children.map((child) => treeWidth(child, childrenOf, seen))) : 0);
}
