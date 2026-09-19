import { useEffect, useRef, useState } from "react";
import type { JevStatus } from "./jevAssistance";
import { requestJevSearch, type JevSearchResult, type JevSearchSnapshot } from "./jevSearch";

const DEBOUNCE_MS = 500;
const TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 5 * 60_000;

/** Optional judgments layered over immediate local retrieval; this hook never filters results. */
export function useJevSearch({ userId, enabled, ready, active, serviceStatus, snapshot, pending = false }: {
  userId: string;
  enabled: boolean;
  ready: boolean;
  active: boolean;
  serviceStatus: JevStatus;
  snapshot: JevSearchSnapshot | null;
  pending?: boolean;
}) {
  const [view, setView] = useState<{ key: string; status: JevStatus; result?: JevSearchResult }>({ key: "", status: "off" });
  const cache = useRef({ userId, results: new Map<string, { at: number; result: JevSearchResult }>() });
  if (cache.current.userId !== userId) cache.current = { userId, results: new Map() };
  const eligible = Boolean(userId && enabled && ready && active && snapshot && !pending);
  const configured = ["ready", "loading", "paused"].includes(serviceStatus);
  const key = eligible && configured ? JSON.stringify(snapshot) : "";
  const requestKey = JSON.stringify([userId, key]);

  useEffect(() => {
    if (!key) return;
    const accountCache = cache.current.results;
    const cached = accountCache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      setView({ key: requestKey, status: "ready", result: cached.result });
      return;
    }
    let live = true;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    setView({ key: requestKey, status: "loading" });
    const timer = setTimeout(async () => {
      deadline = setTimeout(() => {
        controller.abort();
        if (live) setView({ key: requestKey, status: "unavailable" });
      }, TIMEOUT_MS);
      try {
        const result = await requestJevSearch(userId, JSON.parse(key), controller.signal);
        if (!live || controller.signal.aborted) return;
        if (result.available) {
          accountCache.set(key, { at: Date.now(), result });
          while (accountCache.size > 24) accountCache.delete(accountCache.keys().next().value!);
        }
        setView({ key: requestKey, status: result.available ? "ready" : "unavailable", result });
      } catch {
        if (live) setView({ key: requestKey, status: "unavailable" });
      } finally { clearTimeout(deadline); }
    }, DEBOUNCE_MS);
    return () => { live = false; clearTimeout(timer); clearTimeout(deadline); controller.abort(); };
  }, [key, requestKey, userId]);

  let status: JevStatus = "off";
  if (enabled && active && ready && snapshot) {
    status = pending ? "paused" : !configured ? serviceStatus : view.key === requestKey ? view.status : "loading";
  }
  const result = key && view.key === requestKey && view.status === "ready" ? view.result : undefined;
  const scores: Record<string, number> = Object.create(null);
  if (result?.available) for (const item of result.scores) scores[item.id] = item.score;
  return { status, scores, suggestedFacetIds: result?.available ? result.suggestedFacetIds : [],
    analyzedCount: result?.available ? result.scores.length : 0,
    warning: key && view.key === requestKey ? view.result?.warning : undefined };
}
