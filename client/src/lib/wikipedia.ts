import { getPublicTopic, withWikidataSupport, type PublicExpansion, type PublicRelation, type PublicTopic } from "./publicKnowledge";

// Wikipedia's public APIs are free and allow browser requests, so these calls
// run on the reader's device and never cost the Margin Chat service anything.
// Both maps take their topics and connections from Wikipedia articles. Topics
// keep their Wikidata ID only as a stable identity that survives renames.
const API_URL = "https://en.wikipedia.org/w/api.php";
const SUMMARY_URL = "https://en.wikipedia.org/api/rest_v1/page/summary/";
const SEARCH_LIMIT = 10;
const PREFIX_LIMIT = 5;
const PAGE_SIZE = 12;
const BROADER_LIMIT = 4;
const CANDIDATE_LIMIT = 120;
const REQUEST_TIMEOUT = 12_000;
const ARTICLE_CACHE_TTL = 10 * 60_000;
const ITEM_ID = /^Q[1-9]\d*$/;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export interface WikipediaSummary {
  title: string;
  extract: string;
  url: string;
}

/** How a connection relates to the article it came from. */
export type WikipediaConnectionKind = "broader" | "lead" | "main" | "section" | "see-also";

/** A linked article, ranked by how central it is to the source article. */
export interface WikipediaLinkCandidate {
  title: string;
  kind: WikipediaConnectionKind;
  /** The top-level section the link is grouped under, or null for the lead. */
  section: string | null;
  score: number;
}

const summaryCache = new Map<string, WikipediaSummary | null>();
const articleCache = new Map<string, { candidates: WikipediaLinkCandidate[]; expiresAt: number }>();

async function requestJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const combined = AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT), ...(signal ? [signal] : [])]);
  let response: Response;
  try {
    response = await fetch(url, { signal: combined, credentials: "omit", referrerPolicy: "no-referrer", headers: { Accept: "application/json" } });
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof DOMException && error.name === "TimeoutError") throw new Error("Wikipedia took too long to respond. Please try again.");
    throw new Error("Could not reach Wikipedia. Check your connection and try again.");
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(response.status === 429 ? "Wikipedia is receiving too many requests. Please try again shortly." : `Wikipedia is temporarily unavailable (${response.status}).`);
  try { return await response.json(); }
  catch { throw new Error("Wikipedia returned an unreadable response. Please try again."); }
}

function apiUrl(params: Record<string, string>) {
  const url = new URL(API_URL);
  url.search = new URLSearchParams({ ...params, format: "json", formatversion: "2", origin: "*" }).toString();
  return url.toString();
}

export function wikipediaArticleUrl(title: string) {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.trim().replaceAll(" ", "_"))}`;
}

/** The article title from an English Wikipedia URL. */
export function wikipediaTitle(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== "en.wikipedia.org" || !parsed.pathname.startsWith("/wiki/")) return null;
    const title = decodeURIComponent(parsed.pathname.slice("/wiki/".length));
    return title && !title.includes("/") ? title : null;
  } catch { return null; }
}

/** The article's lead section as plain text, or null when there is no article. */
export async function getWikipediaSummary(url: string | undefined, signal?: AbortSignal): Promise<WikipediaSummary | null> {
  const title = wikipediaTitle(url);
  if (!title) return null;
  if (summaryCache.has(title)) return summaryCache.get(title)!;
  const body = await requestJson(`${SUMMARY_URL}${encodeURIComponent(title)}`, signal);
  const extract = record(body) && typeof body.extract === "string" ? body.extract.trim().slice(0, 4000) : "";
  const summary = extract && record(body) && body.type !== "disambiguation"
    ? { title: typeof body.title === "string" ? body.title : title.replaceAll("_", " "), extract, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}` }
    : null;
  summaryCache.set(title, summary);
  while (summaryCache.size > 200) summaryCache.delete(summaryCache.keys().next().value!);
  return summary;
}

/** A topic built from a Wikipedia page, or null for pages without a Wikidata identity or for disambiguation pages. */
export function topicFromWikipediaPage(page: unknown, retrievedAt = new Date().toISOString()): PublicTopic | null {
  if (!record(page) || page.missing || page.invalid || typeof page.title !== "string") return null;
  const props = record(page.pageprops) ? page.pageprops : {};
  const id = typeof props.wikibase_item === "string" ? props.wikibase_item : "";
  if (!ITEM_ID.test(id) || "disambiguation" in props) return null;
  return {
    id, aliases: [], label: page.title, description: typeof page.description === "string" ? page.description.trim().slice(0, 500) : "",
    wikidataUrl: `https://www.wikidata.org/wiki/${id}`, wikipediaUrl: wikipediaArticleUrl(page.title), retrievedAt,
  };
}

const PAGE_PROPS = { prop: "pageprops|description", ppprop: "wikibase_item|disambiguation", redirects: "1" };

function pagesOf(body: unknown): Record<string, unknown>[] {
  return record(body) && record(body.query) && Array.isArray(body.query.pages) ? body.query.pages.filter(record) : [];
}

/** Title prefix matches first, then full-text matches inside article bodies. */
export async function searchWikipediaTopics(query: string, signal?: AbortSignal): Promise<PublicTopic[]> {
  const search = query.trim().slice(0, 200);
  if (search.length < 2) return [];
  const byIndex = (pages: Record<string, unknown>[]) => pages.sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));
  const [prefix, fullText] = await Promise.all([
    requestJson(apiUrl({ action: "query", generator: "prefixsearch", gpssearch: search, gpslimit: String(PREFIX_LIMIT), gpsnamespace: "0", ...PAGE_PROPS }), signal).catch(() => null),
    requestJson(apiUrl({ action: "query", generator: "search", gsrsearch: search, gsrlimit: String(SEARCH_LIMIT), gsrnamespace: "0", ...PAGE_PROPS }), signal),
  ]);
  const retrievedAt = new Date().toISOString();
  const topics = new Map<string, PublicTopic>();
  for (const page of [...byIndex(pagesOf(prefix)), ...byIndex(pagesOf(fullText))]) {
    const topic = topicFromWikipediaPage(page, retrievedAt);
    if (topic && !topics.has(topic.id)) topics.set(topic.id, topic);
  }
  return [...topics.values()];
}

/** Resolve up to 50 article titles, following redirects. Returns topics keyed by each requested title. */
export async function resolveWikipediaTitles(titles: string[], signal?: AbortSignal): Promise<Map<string, PublicTopic>> {
  const requested = [...new Set(titles.map((title) => title.trim()).filter(Boolean))].slice(0, 50);
  const result = new Map<string, PublicTopic>();
  if (!requested.length) return result;
  const body = await requestJson(apiUrl({ action: "query", titles: requested.join("|"), ...PAGE_PROPS }), signal);
  const query = record(body) && record(body.query) ? body.query : {};
  const follow = new Map<string, string>();
  for (const key of ["normalized", "redirects"]) {
    for (const step of Array.isArray(query[key]) ? query[key] as unknown[] : []) {
      if (record(step) && typeof step.from === "string" && typeof step.to === "string") follow.set(step.from, step.to);
    }
  }
  const retrievedAt = new Date().toISOString();
  const pages = new Map<string, PublicTopic>();
  for (const page of pagesOf(body)) {
    const topic = topicFromWikipediaPage(page, retrievedAt);
    if (topic) pages.set(topic.label, topic);
  }
  for (const title of requested) {
    let current = title;
    for (let hops = 0; hops < 4 && follow.has(current); hops += 1) current = follow.get(current)!;
    const topic = pages.get(current);
    if (topic) result.set(title, topic);
  }
  return result;
}

const SKIPPED_SECTIONS = /^(references|notes|footnotes|citations|sources|bibliography|further reading|external links|works cited|literature|notes and references|references and notes|general and cited references|cited sources)$/i;
const NAMESPACE = /^(file|image|media|category|wikt|wiktionary|wikipedia|wp|help|template|portal|special|talk|user|module|draft|s|q|n|b|v|voy|commons|meta|species|mw|w|wikisource|wikiquote|wikibooks|wikinews|wikiversity|d|[a-z]{2,3}(-[a-z]+)?)\s*:/i;
const LOW_VALUE_TITLE = /^(\d{1,4}s?( BC| AD| BCE| CE)?|\d{1,2}(st|nd|rd|th) century( BC)?|(January|February|March|April|May|June|July|August|September|October|November|December)( \d{1,2})?|ISBN|Doi \(identifier\)|PMID|ISSN|S2CID|Bibcode|JSTOR|OCLC|PMC \(identifier\)|ArXiv \(identifier\)|Hdl \(identifier\))$/i;
const HATNOTE = /\{\{\s*(main|main article|further|further information|see also|details)\s*\|([^{}]*)\}\}/gi;

function cleanTitle(raw: string): string | null {
  let title = raw.split("|")[0].split("#")[0].replace(/_/g, " ").replace(/\s+/g, " ").trim();
  if (title.startsWith(":")) title = title.slice(1).trim();
  if (!title || NAMESPACE.test(title) || title.length > 200 || /[<>[\]{}]/.test(title)) return null;
  title = title[0].toUpperCase() + title.slice(1);
  return LOW_VALUE_TITLE.test(title) ? null : title;
}

/** Remove markup whose links are not about the topic: comments, references and templates other than hatnotes. */
function stripNoise(text: string): string {
  let next = text.replace(/<!--[\s\S]*?-->/g, "").replace(/<ref\b[^>]*\/>/gi, "").replace(/<ref\b[\s\S]*?<\/ref>/gi, "");
  for (let previous = ""; previous !== next;) { previous = next; next = next.replace(/\{\{[^{}]*\}\}/g, ""); }
  return next;
}

function wikiLinks(text: string): string[] {
  const titles: string[] = [];
  for (const match of text.matchAll(/\[\[([^[\]]+?)\]\]/g)) {
    const title = cleanTitle(match[1]);
    if (title) titles.push(title);
  }
  return titles;
}

/** The first link outside parentheses in the opening sentence usually names the broader concept. */
function firstLeadLink(lead: string): string | null {
  const paragraph = lead.split(/\n\s*\n/).map((part) => part.trim()).find((part) => part && !part.startsWith("[[") && !part.startsWith("|") && !part.startsWith("{"))
    ?? lead.trim();
  let depth = 0;
  for (let index = 0; index < paragraph.length; index += 1) {
    const character = paragraph[index];
    if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && paragraph.startsWith("[[", index)) {
      const end = paragraph.indexOf("]]", index);
      if (end < 0) return null;
      const title = cleanTitle(paragraph.slice(index + 2, end));
      if (title) return title;
      index = end + 1;
    } else if (depth === 0 && character === "." && /\s/.test(paragraph[index + 1] ?? " ")) return null;
  }
  return null;
}

/**
 * Rank an article's links into a hierarchy: broader topics (the first link of
 * the opening sentence, then categories named after articles), the key topics
 * linked from the lead, each section's topics grouped by section heading with
 * "Main article" hatnotes first, then "See also".
 */
export function rankWikipediaLinks(articleTitle: string, wikitext: string, categories: string[] = []): WikipediaLinkCandidate[] {
  const self = cleanTitle(articleTitle);
  const hatnotes: { title: string; section: string | null }[] = [];
  const sections: { heading: string | null; text: string }[] = [{ heading: null, text: "" }];
  let current: string | null = null;
  for (const line of wikitext.replace(/\r\n?/g, "\n").split("\n")) {
    const heading = /^(={2,6})\s*(.+?)\s*\1\s*$/.exec(line);
    if (heading) {
      if (heading[1].length === 2) current = stripNoise(heading[2]).replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, "$1").replace(/'{2,}/g, "").trim() || null;
      sections.push({ heading: current, text: "" });
      continue;
    }
    for (const match of line.matchAll(HATNOTE)) {
      for (const part of match[2].split("|")) {
        if (part.includes("=")) continue;
        const title = cleanTitle(part);
        if (title) hatnotes.push({ title, section: current });
      }
    }
    sections.at(-1)!.text += `${line}\n`;
  }
  const candidates = new Map<string, WikipediaLinkCandidate>();
  const counts = new Map<string, number>();
  const add = (title: string, kind: WikipediaConnectionKind, section: string | null, score: number) => {
    if (title === self) return;
    const existing = candidates.get(title);
    if (!existing) { candidates.set(title, { title, kind, section, score }); return; }
    // A link keeps its strongest placement, and repeated mentions add weight.
    const rank = { broader: 5, main: 4, lead: 3, "see-also": 2, section: 1 } as const;
    if (rank[kind] > rank[existing.kind]) Object.assign(existing, { kind, section });
    existing.score = Math.max(existing.score, score);
  };
  const lead = stripNoise(sections[0].text);
  const broader = firstLeadLink(lead);
  if (broader) add(broader, "broader", null, 100);
  for (const category of categories) {
    const title = cleanTitle(category.replace(/^Category:/i, ""));
    if (title) add(title, "broader", null, 90);
  }
  for (const { title, section } of hatnotes) add(title, "main", section, 40);
  for (const { heading, text } of sections) {
    if (heading && SKIPPED_SECTIONS.test(heading)) continue;
    const seeAlso = !!heading && /^see also$/i.test(heading);
    const links = seeAlso ? wikiLinks(text) : wikiLinks(stripNoise(text));
    for (const title of links) counts.set(title, (counts.get(title) ?? 0) + 1);
    for (const title of new Set(links)) {
      if (!heading) add(title, "lead", null, 20);
      else if (seeAlso) add(title, "see-also", "See also", 12);
      else add(title, "section", heading, 5);
    }
  }
  for (const candidate of candidates.values()) candidate.score += Math.min(10, (counts.get(candidate.title) ?? 0) - 1);
  const ordered = [...candidates.values()];
  const broaderTopics = ordered.filter((item) => item.kind === "broader").sort((a, b) => b.score - a.score).slice(0, BROADER_LIMIT * 2);
  const rest = ordered.filter((item) => item.kind !== "broader").sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return [...broaderTopics, ...rest].slice(0, CANDIDATE_LIMIT);
}

export function wikipediaRelationLabel(candidate: Pick<WikipediaLinkCandidate, "kind" | "section">): string {
  if (candidate.kind === "broader") return "broader topic";
  if (candidate.kind === "lead") return "key topic";
  if (candidate.kind === "see-also") return "see also";
  return candidate.section ? candidate.section.slice(0, 60) : "related topic";
}

const sectionAnchor = (section: string | null) => section ? `#${encodeURIComponent(section.replaceAll(" ", "_"))}` : "";

/** The English Wikipedia title for a topic, reading Wikidata only for older topics saved without one. */
export async function wikipediaTitleForTopic(topic: Pick<PublicTopic, "id" | "wikipediaUrl">, signal?: AbortSignal): Promise<string> {
  const known = wikipediaTitle(topic.wikipediaUrl);
  if (known) return known.replaceAll("_", " ");
  const fromWikidata = wikipediaTitle((await getPublicTopic(topic.id, signal)).wikipediaUrl);
  if (!fromWikidata) throw new Error("This topic has no English Wikipedia article to take connections from.");
  return fromWikidata.replaceAll("_", " ");
}

async function articleCandidates(title: string, signal?: AbortSignal): Promise<{ candidates: WikipediaLinkCandidate[]; title: string; description?: string }> {
  const cached = articleCache.get(title);
  if (cached && cached.expiresAt > Date.now()) return { candidates: cached.candidates, title };
  const body = await requestJson(apiUrl({ action: "parse", page: title, prop: "wikitext|categories|properties", redirects: "1" }), signal);
  const parse = record(body) && record(body.parse) ? body.parse : null;
  if (!parse || typeof parse.wikitext !== "string") throw new Error("This Wikipedia article could not be read. Please try again.");
  const categories = (Array.isArray(parse.categories) ? parse.categories : []).flatMap((item) =>
    record(item) && typeof item.category === "string" && !("hidden" in item) ? [item.category.replace(/_/g, " ")] : []);
  const properties = record(parse.properties) ? parse.properties : {};
  const resolvedTitle = typeof parse.title === "string" ? parse.title : title;
  const candidates = rankWikipediaLinks(resolvedTitle, parse.wikitext, categories);
  for (const key of new Set([title, resolvedTitle])) articleCache.set(key, { candidates, expiresAt: Date.now() + ARTICLE_CACHE_TTL });
  while (articleCache.size > 64) articleCache.delete(articleCache.keys().next().value!);
  return { candidates, title: resolvedTitle,
    description: typeof properties["wikibase-shortdesc"] === "string" ? properties["wikibase-shortdesc"] : undefined };
}

/**
 * One page of a topic's connections, taken from its Wikipedia article: broader
 * topics first, then the most central linked articles grouped by section.
 */
export async function expandWikipediaTopic(topic: PublicTopic, offset = 0, signal?: AbortSignal): Promise<PublicExpansion> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Choose a valid public map page.");
  const title = await wikipediaTitleForTopic(topic, signal);
  const article = await articleCandidates(title, signal);
  const source: PublicTopic = { ...topic, aliases: [...topic.aliases], wikipediaUrl: wikipediaArticleUrl(article.title),
    ...(topic.description || !article.description ? {} : { description: article.description.slice(0, 500) }) };
  const page = article.candidates.slice(offset, offset + PAGE_SIZE);
  const resolved = await resolveWikipediaTitles(page.map((candidate) => candidate.title), signal);
  const topics = new Map<string, PublicTopic>();
  const relations = new Map<string, PublicRelation>();
  for (const candidate of page) {
    const target = resolved.get(candidate.title);
    if (!target || target.id === source.id || topics.has(target.id)) continue;
    const propertyId = `wikipedia-${candidate.kind}`;
    const relationId = `${source.id}:${propertyId}:${target.id}`;
    topics.set(target.id, target);
    relations.set(relationId, { id: relationId, sourceId: source.id, targetId: target.id, propertyId,
      label: wikipediaRelationLabel(candidate), sourceUrl: `${source.wikipediaUrl}${sectionAnchor(candidate.section)}` });
  }
  const nextOffset = Math.min(offset + PAGE_SIZE, article.candidates.length);
  // Wikidata backs up the links it also states; the article stays the source of connections.
  const supported = await withWikidataSupport(source.id, [...relations.values()], signal);
  return { topic: source, topics: [...topics.values()], relations: supported, hasMore: nextOffset < article.candidates.length, nextOffset };
}

/** Find the article for a topic name, such as a note title in My map. */
export async function findWikipediaTopic(name: string, signal?: AbortSignal): Promise<PublicTopic | null> {
  const exact = (await resolveWikipediaTitles([name], signal)).get(name.trim());
  if (exact) return exact;
  return (await searchWikipediaTopics(name, signal))[0] ?? null;
}
