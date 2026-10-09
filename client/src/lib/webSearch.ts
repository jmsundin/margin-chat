import { apiFetch } from "./apiTransport";
import { ApiError } from "./apiError";

/** One web page from a search. Only http(s) links reach the client. */
export interface WebSearchResult {
  title: string;
  url: string;
  description: string;
  siteName: string;
  age?: string;
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, maximum: number): value is string => typeof value === "string" && value.length <= maximum;

export function isWebSearchResult(value: unknown): value is WebSearchResult {
  if (!record(value) || !text(value.title, 200) || !text(value.url, 2000) || !text(value.description, 500) || !text(value.siteName, 100)
    || (value.age !== undefined && !text(value.age, 40))) return false;
  try { return ["http:", "https:"].includes(new URL(value.url).protocol); } catch { return false; }
}

/** Web search runs on the server for members with a subscription or credit, and is charged to their credit. */
export async function searchWeb(userId: string, query: string, signal?: AbortSignal): Promise<{ results: WebSearchResult[]; chargedMicros: number }> {
  const response = await apiFetch("/api/web-search", {
    method: "POST", credentials: "same-origin", signal,
    headers: { "Content-Type": "application/json", Accept: "application/json", "X-Margin-Vault-User": userId },
    body: JSON.stringify({ query: query.trim().slice(0, 300) }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, typeof body?.error === "string" ? body.error.slice(0, 500) : "The web search did not work. Try again.");
  return {
    results: Array.isArray(body?.results) ? body.results.filter(isWebSearchResult).slice(0, 10) : [],
    chargedMicros: Number.isSafeInteger(body?.chargedMicros) ? body.chargedMicros : 0,
  };
}
