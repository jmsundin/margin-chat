import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { apiFetch, apiStorageNamespace } from "./apiTransport";
import { termId, termKey, type LanguageTerm, type TermStatus } from "./languageReader";

/**
 * The words and phrases a person is learning. Kept on this device first, so a
 * rating shows at once and survives being offline, then copied to the account.
 * The newer copy of a term wins, so two devices merge.
 */
export type TermPatch = { meaning?: string; status?: TermStatus; tags?: string[]; docId?: string };

interface Saved { terms: LanguageTerm[]; pending: string[]; cursor: number }
const storageKey = (namespace: string) => `margin-chat:language-terms:${namespace}`;

export class LanguageTermStore {
  private terms = new Map<string, LanguageTerm>();
  private pending = new Set<string>();
  private listeners = new Set<() => void>();
  private snapshot: ReadonlyMap<string, LanguageTerm> = this.terms;
  cursor = 0;
  /** Set when this device couldn't keep a change; the change is still held until the page closes. */
  saveError: string | null = null;

  constructor(readonly namespace: string, private readonly storage: Pick<Storage, "getItem" | "setItem"> | null = typeof localStorage === "undefined" ? null : localStorage) {
    try {
      const saved = JSON.parse(storage?.getItem(storageKey(namespace)) ?? "null") as Partial<Saved> | null;
      for (const term of saved?.terms ?? []) if (term && typeof term.key === "string" && typeof term.language === "string") this.terms.set(termId(term.language, term.key), term);
      for (const id of saved?.pending ?? []) if (this.terms.has(id)) this.pending.add(id);
      if (Number.isSafeInteger(saved?.cursor)) this.cursor = saved!.cursor as number;
    } catch { /* Start empty; the account's copy comes with the first sync. */ }
    this.snapshot = new Map(this.terms);
  }

  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  getSnapshot() { return this.snapshot; }
  get(language: string, key: string) { return this.terms.get(termId(language, key)); }

  private changed() {
    this.snapshot = new Map(this.terms);
    try {
      this.storage?.setItem(storageKey(this.namespace), JSON.stringify({ terms: [...this.terms.values()], pending: [...this.pending], cursor: this.cursor } satisfies Saved));
      this.saveError = null;
    } catch { this.saveError = "This device is out of room for your word list. Changes are kept in your account when it's online."; }
    for (const listener of this.listeners) listener();
  }

  /** Rates a term, gives it a meaning or tags it. A term that was never saved starts at Learning 1 unless a status is given. */
  set(language: string, text: string, patch: TermPatch, now = new Date().toISOString()): LanguageTerm | null {
    const key = termKey(text);
    if (!key) return null;
    const id = termId(language, key);
    const existing = this.terms.get(id);
    const meaning = patch.meaning !== undefined ? patch.meaning.trim().slice(0, 2000) : existing?.meaning ?? "";
    let status = patch.status ?? existing?.status ?? 1;
    // A meaning typed for a word that was never rated means it's being learned.
    if (patch.status === undefined && status === 0 && meaning) status = 1;
    const next: LanguageTerm = {
      language, key, meaning, status,
      tags: patch.tags ? [...new Set(patch.tags.map((tag) => tag.trim().replace(/^#/u, "")).filter(Boolean))].slice(0, 20) : existing?.tags ?? [],
      docIds: patch.docId && !(existing?.docIds ?? []).includes(patch.docId) ? [...(existing?.docIds ?? []), patch.docId].slice(-50) : existing?.docIds ?? [],
      createdAt: existing?.createdAt ?? now,
      // Always later than the copy it replaces, even when this device's clock is behind the one that wrote it.
      updatedAt: existing && existing.updatedAt >= now ? new Date(Date.parse(existing.updatedAt) + 1).toISOString() : now,
    };
    if (existing && existing.meaning === next.meaning && existing.status === next.status && existing.tags.join("\n") === next.tags.join("\n") && existing.docIds.length === next.docIds.length) return existing;
    this.terms.set(id, next);
    this.pending.add(id);
    this.changed();
    return next;
  }

  pendingTerms(limit: number): LanguageTerm[] {
    const terms: LanguageTerm[] = [];
    for (const id of this.pending) { const term = this.terms.get(id); if (term) terms.push(term); if (terms.length >= limit) break; }
    return terms;
  }

  /** The account has these as they were sent; a term changed again since stays waiting. */
  markSent(sent: ReadonlyArray<LanguageTerm>) {
    for (const term of sent) { const id = termId(term.language, term.key); if (this.terms.get(id)?.updatedAt === term.updatedAt) this.pending.delete(id); }
  }

  applyRemote(terms: ReadonlyArray<LanguageTerm>, cursor: number) {
    for (const term of terms) {
      const id = termId(term.language, term.key);
      const mine = this.terms.get(id);
      if (!mine || mine.updatedAt < term.updatedAt) { this.terms.set(id, term); this.pending.delete(id); }
    }
    this.cursor = Math.max(this.cursor, cursor);
    this.changed();
  }
}

type SyncStatus = "local" | "syncing" | "synced" | "offline" | "error";
/** Read a little behind the last cursor: rows saved at the same moment may commit out of order. */
const CURSOR_OVERLAP = 100;

export async function syncLanguageTerms(store: LanguageTermStore, userId: string, fetcher: typeof apiFetch = apiFetch): Promise<SyncStatus> {
  for (let round = 0; round < 50; round++) {
    const pending = store.pendingTerms(1000);
    const before = store.cursor;
    const response = await fetcher("/api/language-terms/sync", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "Content-Type": "application/json", "X-Margin-Vault-User": userId },
      body: JSON.stringify({ terms: pending, cursor: Math.max(0, before - CURSOR_OVERLAP) }),
    });
    if (response.status === 401 || response.status === 403 || response.status === 404) return "local";
    if (!response.ok) return "error";
    const result = await response.json() as { terms: LanguageTerm[]; cursor: number; more: boolean };
    store.markSent(pending);
    store.applyRemote(result.terms, result.cursor);
    if (!store.pendingTerms(1).length && !(result.more && result.cursor > before)) return "synced";
  }
  return "synced";
}

/** The signed-in person's terms, kept in step with their account. */
export function useLanguageTerms({ userId, enabled = true }: { userId: string; enabled?: boolean }) {
  const namespace = apiStorageNamespace(userId);
  const store = useMemo(() => new LanguageTermStore(namespace), [namespace]);
  const terms = useSyncExternalStore(useCallback((listener) => store.subscribe(listener), [store]), () => store.getSnapshot());
  const [status, setStatus] = useState<SyncStatus>("local");
  const syncing = useRef<Promise<void> | null>(null);
  const again = useRef(false);
  const timer = useRef<number | null>(null);
  const account = useRef(true);

  const sync = useCallback((): Promise<void> => {
    if (!enabled || !account.current) return Promise.resolve();
    if (syncing.current) { again.current = true; return syncing.current; }
    setStatus("syncing");
    syncing.current = syncLanguageTerms(store, userId).then((result) => {
      if (result === "local") account.current = false;
      setStatus(result);
    }, () => setStatus(typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "error"))
      .finally(() => { syncing.current = null; if (again.current) { again.current = false; void sync(); } });
    return syncing.current;
  }, [enabled, store, userId]);

  useEffect(() => {
    if (!enabled) return undefined;
    account.current = true;
    void sync();
    const interval = window.setInterval(() => void sync(), 5 * 60_000);
    const onVisible = () => { if (document.visibilityState === "visible") void sync(); };
    const onOnline = () => { account.current = true; void sync(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [enabled, sync]);

  const setTerm = useCallback((language: string, text: string, patch: TermPatch) => {
    const term = store.set(language, text, patch);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { timer.current = null; void sync(); }, 1500);
    return term;
  }, [store, sync]);

  return { terms, setTerm, status, saveError: store.saveError };
}
