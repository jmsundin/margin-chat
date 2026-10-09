import { randomUUID } from "node:crypto";
import { HttpError } from "../lib/errors.mjs";

// General web search is not free anywhere at scale, so it runs on the server
// with one Brave Search key and is charged to the member's prepaid credit,
// like AI requests. Wikipedia search stays free in every reader's browser.
const BRAVE_URL = "https://api.search.brave.com/res/v1/web/search";
export const DEFAULT_WEB_SEARCH_PRICE_MICROS = 10_000;
const RESULT_LIMIT = 8;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const plain = (value, maximum) => typeof value === "string"
  ? value.replace(/<[^>]*>/gu, "").replace(/&(?:amp|lt|gt|quot|#39|#x27);/gu, (entity) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&#x27;": "'" })[entity]).replace(/\s+/gu, " ").trim().slice(0, maximum)
  : "";

export function canSearchWeb(user) {
  return user?.role === "admin" || user?.billing?.hasAccess === true;
}

export function validateWebSearchRequest(body) {
  if (!record(body) || typeof body.query !== "string") throw new HttpError(400, "Type something to search the web for.");
  const query = body.query.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (query.length < 2 || query.length > 300) throw new HttpError(400, "Search for 2 to 300 characters.");
  return { query };
}

/** Only plain http(s) links with their text; everything else from the provider is dropped. */
export function normalizeBraveResults(payload) {
  const results = record(payload) && record(payload.web) && Array.isArray(payload.web.results) ? payload.web.results : [];
  const seen = new Set();
  const normalized = [];
  for (const item of results) {
    if (!record(item) || typeof item.url !== "string") continue;
    let url;
    try { url = new URL(item.url); } catch { continue; }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.href.length > 2000 || seen.has(url.href)) continue;
    seen.add(url.href);
    normalized.push({
      title: plain(item.title, 200) || url.hostname,
      url: url.href,
      description: plain(item.description, 500),
      siteName: plain(record(item.profile) ? item.profile.name : "", 100) || url.hostname.replace(/^www\./u, ""),
      ...(typeof item.age === "string" ? { age: plain(item.age, 40) } : {}),
    });
    if (normalized.length >= RESULT_LIMIT) break;
  }
  return normalized;
}

export function createWebSearchService({ env = {}, billingService, fetchImpl = globalThis.fetch, timeoutMs = 10_000 }) {
  const priceMicros = Number.isSafeInteger(Number(env.WEB_SEARCH_PRICE_MICROS)) && Number(env.WEB_SEARCH_PRICE_MICROS) > 0
    ? Number(env.WEB_SEARCH_PRICE_MICROS) : DEFAULT_WEB_SEARCH_PRICE_MICROS;
  const active = new Set();

  async function request(query, signal) {
    const url = new URL(BRAVE_URL);
    url.search = new URLSearchParams({ q: query, count: String(RESULT_LIMIT), safesearch: "moderate", text_decorations: "false" }).toString();
    const combined = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
    let response;
    try {
      response = await fetchImpl(url, { signal: combined, headers: { Accept: "application/json", "X-Subscription-Token": env.BRAVE_SEARCH_API_KEY } });
    } catch {
      signal?.throwIfAborted();
      throw new HttpError(502, "Web search could not be reached. Try again.");
    }
    if (response.status === 429) throw new HttpError(429, "Web search is busy right now. Try again shortly.");
    if (!response.ok) throw new HttpError(502, `Web search is temporarily unavailable (${response.status}).`);
    return normalizeBraveResults(await response.json().catch(() => null));
  }

  async function search({ user, payload, signal }) {
    if (!user?.id) throw new HttpError(401, "Sign in to search the web.");
    if (!canSearchWeb(user)) throw new HttpError(402, "Web search needs a subscription or credit. Wikipedia search is free for everyone.");
    const { query } = validateWebSearchRequest(payload);
    if (!env.BRAVE_SEARCH_API_KEY) throw new HttpError(503, "Web search is not set up yet. Wikipedia search still works.");
    if (active.has(user.id)) throw new HttpError(429, "A web search is already running. Wait for it to finish.");
    active.add(user.id);
    // Admins are not billed, as for AI requests. Members hold the price first
    // and keep it only when the provider returns results.
    const metered = user.role !== "admin";
    const requestId = `web-search:${randomUUID()}`;
    const metadata = { operation: "web-search", kind: "search", provider: "brave", priceMicros };
    try {
      if (metered) await billingService.reserveHostedRequest({ requestId, userId: user.id, amountMicros: priceMicros, metadata });
      let results;
      try { results = await request(query, signal); }
      catch (error) {
        if (metered) await billingService.settleHostedRequest({ requestId, userId: user.id, amountMicros: 0, metadata: { ...metadata, outcome: "failed", usageSource: "not-billed" } });
        throw error;
      }
      if (metered) await billingService.settleHostedRequest({ requestId, userId: user.id, amountMicros: priceMicros, metadata: { ...metadata, outcome: "completed", results: results.length } });
      return { query, results, chargedMicros: metered ? priceMicros : 0 };
    } finally {
      active.delete(user.id);
    }
  }

  return { search, priceMicros };
}
