import { useCallback, useEffect, useRef, useState } from "react";
import { readPublicMap, savePublicMap } from "./publicMapApi";
import type { PublicGraphState } from "./publicGraphScene";
import { emptyExploration, importPublicMap, mergeExplorations, parseExploration, type MapExploration } from "./mapExploration";

const storageKey = (workspaceKey: string) => `margin-map-explored:${workspaceKey}`;
/** The account copy shares the old public map's record, which the server caps at 600,000 characters. */
const ACCOUNT_LIMIT = 560_000;
const EMPTY_PUBLIC_GRAPH = { roots: [], topics: {}, positions: {}, expansions: {} };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function readLocal(workspaceKey: string): MapExploration {
  try { return parseExploration(JSON.parse(localStorage.getItem(storageKey(workspaceKey)) ?? "null")) ?? emptyExploration(); }
  catch { return emptyExploration(); }
}

/** Drops the oldest history until the account record fits. Previews on the map go last. */
export function fitExploration(state: MapExploration, limit: number, base = 0): MapExploration {
  let next = state;
  for (let size = JSON.stringify(next).length + base; size > limit; size = JSON.stringify(next).length + base) {
    const oldest = Object.values(next.items).sort((a, b) => Number(a.onMap) - Number(b.onMap) || a.exploredAt.localeCompare(b.exploredAt)).slice(0, 20);
    if (!oldest.length) break;
    const items = { ...next.items };
    for (const item of oldest) delete items[item.id];
    const pageUrls = new Set(Object.values(items).flatMap((item) => item.source.kind === "page" ? [item.source.url] : []));
    next = { ...next, items, pages: Object.fromEntries(Object.entries(next.pages).filter(([url]) => pageUrls.has(url))) };
  }
  return next;
}

/**
 * What this person explored from the map: kept on this device right away and
 * in their account (beside the old public map, which moves into history once).
 */
export function useMapExploration(workspaceKey: string, userId: string | undefined) {
  const [exploration, setExploration] = useState<MapExploration>(() => readLocal(workspaceKey));
  const [accountReady, setAccountReady] = useState(false);
  const changed = useRef(false);
  const accountBase = useRef<Record<string, unknown> | null>(null);
  const lastSaved = useRef<string | null>(null);

  useEffect(() => {
    setExploration(readLocal(workspaceKey));
    changed.current = false;
    accountBase.current = null;
    lastSaved.current = null;
    setAccountReady(false);
    if (!userId) return;
    const controller = new AbortController();
    readPublicMap(userId, controller.signal).then((saved) => {
      if (controller.signal.aborted) return;
      const state = record(saved.state) ? saved.state : {};
      const { explored, ...rest } = state;
      accountBase.current = rest;
      const remote = parseExploration(explored);
      lastSaved.current = remote ? JSON.stringify(remote) : null;
      setExploration((current) => {
        const merged = remote ? mergeExplorations(current, remote) : current;
        const imported = importPublicMap(merged, record(rest.graph) ? rest.graph as unknown as PublicGraphState : null, new Date().toISOString());
        if (imported !== merged || (remote && JSON.stringify(merged) !== lastSaved.current)) changed.current = true;
        return imported;
      });
      setAccountReady(true);
    }).catch(() => { /* This device's copy stays usable; the account copy is left alone. */ });
    return () => controller.abort();
  }, [workspaceKey, userId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try { localStorage.setItem(storageKey(workspaceKey), JSON.stringify(exploration)); }
      catch { /* Exploring still works when browser storage is full or blocked. */ }
      if (!userId || !accountReady || !changed.current || !accountBase.current) return;
      const base = { ...accountBase.current, version: 1, graph: record(accountBase.current.graph) ? accountBase.current.graph : EMPTY_PUBLIC_GRAPH };
      const explored = fitExploration(exploration, ACCOUNT_LIMIT, JSON.stringify(base).length);
      const key = JSON.stringify(explored);
      if (key === lastSaved.current) return;
      lastSaved.current = key;
      savePublicMap(userId, { ...base, explored }).catch(() => { lastSaved.current = null; });
    }, 800);
    return () => window.clearTimeout(timer);
  }, [exploration, workspaceKey, userId, accountReady]);

  const update = useCallback((change: (current: MapExploration) => MapExploration) => {
    setExploration((current) => {
      const next = change(current);
      if (next !== current) changed.current = true;
      return next;
    });
  }, []);

  return [exploration, update] as const;
}
