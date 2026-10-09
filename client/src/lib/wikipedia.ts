import { getPublicTopics, type PublicTopic } from "./publicKnowledge";

// Wikipedia's public APIs are free and allow browser requests, so these calls
// run on the reader's device and never cost the Margin Chat service anything.
const API_URL = "https://en.wikipedia.org/w/api.php";
const SUMMARY_URL = "https://en.wikipedia.org/api/rest_v1/page/summary/";
const SEARCH_LIMIT = 8;
const REQUEST_TIMEOUT = 12_000;
const ITEM_ID = /^Q[1-9]\d*$/;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export interface WikipediaSummary {
  title: string;
  extract: string;
  url: string;
}

const summaryCache = new Map<string, WikipediaSummary | null>();

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

/** The article title from an English Wikipedia URL built by publicKnowledge. */
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

/** Full-text search over article bodies, returned as the articles' Wikidata topics. */
export async function searchWikipediaTopics(query: string, signal?: AbortSignal): Promise<PublicTopic[]> {
  const search = query.trim().slice(0, 200);
  if (search.length < 2) return [];
  const url = new URL(API_URL);
  url.search = new URLSearchParams({
    action: "query", generator: "search", gsrsearch: search, gsrlimit: String(SEARCH_LIMIT), gsrnamespace: "0",
    prop: "pageprops", ppprop: "wikibase_item", format: "json", formatversion: "2", origin: "*",
  }).toString();
  const body = await requestJson(url.toString(), signal);
  const pages = record(body) && record(body.query) && Array.isArray(body.query.pages) ? body.query.pages : [];
  const ids = pages.filter(record)
    .sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0))
    .flatMap((page) => {
      const id = record(page.pageprops) ? page.pageprops.wikibase_item : undefined;
      return typeof id === "string" && ITEM_ID.test(id) ? [id] : [];
    });
  return getPublicTopics(ids, signal);
}
