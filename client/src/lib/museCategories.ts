import { isHiddenFromAI } from "@margin-chat/workspace-contracts";
import type { Conversation, ConversationGroup } from "../types";
import { getCurrentDocumentText } from "./documentSources";
import { getConversationRootId } from "./tree";

/**
 * Muse Wonder categories for the Map: each main document is filed under one
 * category by Meta's Muse Wonder, and its margin notes and side documents
 * follow it into that category's box. Pure helpers; the hook that asks Muse
 * Wonder lives in useMuseCategories.
 */

/** Documents per request: one line each, and the server takes at most 120 answers. */
export const MUSE_BATCH_SIZE = 80;
const MAX_TITLE_LENGTH = 80;
const MAX_EXCERPT_LENGTH = 180;
/** Category names sent with each batch, so later batches reuse them. */
const MAX_KNOWN_CATEGORIES = 80;
const MAX_PROMPT_LENGTH = 29_000;

export interface MuseCategoryEntry {
  name: string;
  /** What the document looked like when it was sorted; a different one means sort it again. */
  signature: string;
  /** Filed by the person (dropped in a box), so Muse Wonder leaves it alone. */
  manual?: true;
}

export type MuseCategoryCache = Record<string, MuseCategoryEntry>;

function clean(value: string) {
  return value
    .replace(/^---\n[\s\S]*?\n---\n?/u, "")
    .replace(/!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/gu, (_match, target: string, alias?: string) => alias ?? target)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/[#>*_`~|]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

const excerpts = new WeakMap<Conversation, string>();

/** The start of a document's text as plain words, whatever the document is made of. */
export function museDocumentExcerpt(conversation: Conversation, maxLength = MAX_EXCERPT_LENGTH) {
  let text = excerpts.get(conversation);
  if (text === undefined) {
    text = clean(getCurrentDocumentText(conversation).slice(0, maxLength * 4));
    // A document often opens with its own title as a heading.
    const title = conversation.title.trim();
    if (title && text.toLocaleLowerCase().startsWith(title.toLocaleLowerCase())) text = text.slice(title.length).trim();
    text = text.slice(0, maxLength).trim();
    excerpts.set(conversation, text);
  }
  return text;
}

function hash(value: string) {
  let result = 2166136261;
  for (let index = 0; index < value.length; index++) result = Math.imul(result ^ value.charCodeAt(index), 16777619) >>> 0;
  return result.toString(36);
}

/** Changes when the title or the start of the text changes, which is all Muse Wonder sees. */
export function museDocumentSignature(conversation: Conversation) {
  return hash(`${conversation.title.trim()}\n${museDocumentExcerpt(conversation)}`);
}

/**
 * The documents Muse Wonder files: main documents on the map that aren't hidden
 * from AI. Children follow their main document, so they aren't sent.
 */
export function museSortableIds(ids: Iterable<string>, conversations: Record<string, Conversation>) {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const conversation = conversations[id];
    if (!conversation || seen.has(id)) continue;
    seen.add(id);
    if (isHiddenFromAI(conversation)) continue;
    const root = getConversationRootId(conversations, id);
    if (root && root !== id) continue;
    result.push(id);
  }
  return result;
}

/** Documents that still need a category: never sorted, or changed since (unless filed by hand). */
export function musePendingIds(ids: string[], conversations: Record<string, Conversation>, cache: MuseCategoryCache) {
  return ids.filter((id) => {
    const entry = cache[id];
    if (!entry) return true;
    if (entry.manual) return false;
    return entry.signature !== museDocumentSignature(conversations[id]);
  });
}

/** Category names in use, most used first. */
export function museKnownCategories(cache: MuseCategoryCache, limit = MAX_KNOWN_CATEGORIES) {
  const counts = new Map<string, { name: string; count: number }>();
  for (const entry of Object.values(cache)) {
    const key = museCategoryKey(entry.name);
    const known = counts.get(key);
    if (known) known.count++;
    else counts.set(key, { name: entry.name, count: 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, limit).map(({ name }) => name);
}

/**
 * One request's prompt: the categories already in use, then one line per
 * document (`D1: Title — start of text`). Returns the ids that made it in, in
 * order, so answer D<n> maps to ids[n - 1].
 */
export function buildMuseCategoriesPrompt(ids: string[], conversations: Record<string, Conversation>, known: string[] = []) {
  const lines: string[] = [];
  const included: string[] = [];
  if (known.length) lines.push(`Categories in use: ${known.join("; ")}`);
  let length = lines[0]?.length ?? 0;
  for (const id of ids) {
    const conversation = conversations[id];
    if (!conversation) continue;
    const title = conversation.title.trim().replace(/\s+/gu, " ").slice(0, MAX_TITLE_LENGTH) || "Untitled";
    const excerpt = museDocumentExcerpt(conversation);
    const line = `D${included.length + 1}: ${title}${excerpt && excerpt !== title ? ` — ${excerpt}` : ""}`;
    if (length + line.length + 1 > MAX_PROMPT_LENGTH) break;
    lines.push(line);
    included.push(id);
    length += line.length + 1;
  }
  return { content: lines.join("\n"), ids: included };
}

/** Treats "angular", "Angular " and "ANGULAR" as one category, keeping the first spelling. */
export function museCategoryKey(name: string) {
  return name.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

function categoryHue(key: string) {
  let value = 0;
  for (let index = 0; index < key.length; index++) value = (value * 31 + key.charCodeAt(index)) >>> 0;
  return Math.round((value % 997) * 137.508) % 360;
}

/**
 * Categories as Map groups, one box each, in name order so filing a card
 * elsewhere doesn't shuffle the boxes. Documents with no category (hidden from
 * AI, or not sorted yet) are left out and land in the "Not sorted" box.
 */
export function museCategoryGroups(ids: Iterable<string>, cache: MuseCategoryCache): Record<string, ConversationGroup> {
  const groups = new Map<string, ConversationGroup>();
  for (const id of ids) {
    const entry = cache[id];
    if (!entry) continue;
    const key = museCategoryKey(entry.name);
    if (!key) continue;
    const groupId = `muse:${key}`;
    let group = groups.get(groupId);
    if (!group) {
      group = { id: groupId, name: entry.name.trim(), color: `hsl(${categoryHue(key)} 58% 52%)`, collapsed: false, conversationIds: [] };
      groups.set(groupId, group);
    }
    group.conversationIds.push(id);
  }
  return Object.fromEntries([...groups.values()]
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }))
    .map((group) => [group.id, group]));
}

export function readMuseCategoryCache(value: unknown): MuseCategoryCache {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const cache: MuseCategoryCache = {};
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const { name, signature, manual } = entry as Record<string, unknown>;
    if (typeof name !== "string" || !name.trim() || typeof signature !== "string") continue;
    cache[id] = { name: name.trim(), signature, ...(manual === true ? { manual: true as const } : {}) };
  }
  return cache;
}
