import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Conversation } from "../types";
import { apiFetch, apiStorageNamespace } from "./apiTransport";
import { getEditableDocument } from "./editableDocument";
import { parseDocumentFlashcards } from "./flashcards";
import { getStandaloneNote } from "./standaloneNotes";
import { buildStudyQueue, scheduleFromReviews, studyDayStart, type FlashcardRating, type FlashcardReview, type FlashcardSchedule, type ScheduleOptions } from "./flashcardSchedule";
import { FlashcardStore, type FlashcardSnapshot, type StoredFlashcard } from "./flashcardStore";

export interface FlashcardSettings extends ScheduleOptions { newPerDay: number }
export const DEFAULT_FLASHCARD_SETTINGS: FlashcardSettings = { newPerDay: 20, retention: 0.9 };
const SETTINGS_KEY = "margin-chat:flashcard-settings";

export function loadFlashcardSettings(): FlashcardSettings {
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
    return {
      newPerDay: Number.isInteger(stored.newPerDay) && stored.newPerDay >= 0 && stored.newPerDay <= 9999 ? stored.newPerDay : DEFAULT_FLASHCARD_SETTINGS.newPerDay,
      retention: typeof stored.retention === "number" && stored.retention >= 0.7 && stored.retention <= 0.97 ? stored.retention : DEFAULT_FLASHCARD_SETTINGS.retention,
    };
  } catch { return { ...DEFAULT_FLASHCARD_SETTINGS }; }
}

export function saveFlashcardSettings(settings: FlashcardSettings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* the defaults still work */ }
}

export interface ScheduledCard { card: StoredFlashcard; schedule: FlashcardSchedule; reviews: FlashcardReview[] }

const scheduleCache = new Map<string, { key: string; value: FlashcardSchedule }>();

/** Each studyable card with its schedule, from the store's snapshot. */
export function scheduleCards(snapshot: FlashcardSnapshot, options?: ScheduleOptions, docIds?: ReadonlySet<string>, { includeSuspended = false } = {}): ScheduledCard[] {
  const byCard = new Map<string, FlashcardReview[]>();
  for (const review of snapshot.reviews.values()) {
    const list = byCard.get(review.cardId);
    if (list) list.push(review); else byCard.set(review.cardId, [review]);
  }
  const result: ScheduledCard[] = [];
  for (const card of snapshot.cards.values()) {
    if (card.removed || (card.suspended && !includeSuspended) || (docIds && !docIds.has(card.docId))) continue;
    const reviews = [card.id, ...(card.historyFrom ?? [])].flatMap((id) => byCard.get(id) ?? []);
    // Replaying every card after each answer adds up in a big collection; reuse unchanged results.
    const key = `${card.id}|${card.createdAt}|${options?.retention ?? ""}|${options?.maximumIntervalDays ?? ""}|${reviews.length}|${reviews.map((review) => review.id).sort().join(",")}`;
    let schedule = scheduleCache.get(card.id);
    if (!schedule || schedule.key !== key) {
      schedule = { key, value: scheduleFromReviews(reviews, Date.parse(card.createdAt) || 0, options) };
      scheduleCache.set(card.id, schedule);
    }
    result.push({ card, schedule: schedule.value, reviews });
  }
  // New cards come in the order they were written: by document, then position.
  return result.sort((a, b) => a.card.createdAt.localeCompare(b.card.createdAt) || a.card.docId.localeCompare(b.card.docId) ||
    a.card.kind.localeCompare(b.card.kind) || a.card.ordinal - b.card.ordinal);
}

/** New cards first answered since today's study day began. */
export function newStudiedToday(cards: ReadonlyArray<ScheduledCard>, now: number) {
  const start = studyDayStart(now);
  let count = 0;
  for (const { reviews } of cards) {
    if (!reviews.length) continue;
    const first = reviews.reduce((earliest, review) => (review.reviewedAt < earliest ? review.reviewedAt : earliest), reviews[0].reviewedAt);
    if (Date.parse(first) >= start) count++;
  }
  return count;
}

const SYNC_DELAY_MS = 2_000;
const PULL_EVERY_MS = 5 * 60_000;
/** Read a little behind the last cursor: rows saved at the same moment may commit out of order. */
const CURSOR_OVERLAP = 200;

type SyncStatus = "local" | "syncing" | "synced" | "offline" | "error";

async function syncOnce(store: FlashcardStore, userId: string): Promise<SyncStatus> {
  let cursors = (await store.getMeta<{ card: number; review: number }>("cursor")) ?? { card: 0, review: 0 };
  for (let round = 0; round < 50; round++) {
    const pending = store.pendingChanges(1000);
    const response = await apiFetch("/api/flashcards/sync", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json", "X-Margin-Vault-User": userId },
      body: JSON.stringify({
        cards: pending.cards, reviews: pending.reviews,
        cardCursor: Math.max(0, cursors.card - CURSOR_OVERLAP), reviewCursor: Math.max(0, cursors.review - CURSOR_OVERLAP),
      }),
    });
    if (response.status === 401 || response.status === 403) return "local";
    if (!response.ok) return "error";
    const result = await response.json() as { cards: StoredFlashcard[]; reviews: FlashcardReview[]; cardCursor: number; reviewCursor: number; more: boolean };
    await store.markSent(pending);
    store.applyRemote(result);
    const advanced = result.cardCursor > cursors.card || result.reviewCursor > cursors.review;
    cursors = { card: Math.max(cursors.card, result.cardCursor), review: Math.max(cursors.review, result.reviewCursor) };
    await store.setMeta("cursor", cursors);
    const left = store.pendingChanges(1);
    if (!left.cards.length && !left.reviews.length && !(result.more && advanced)) return "synced";
  }
  return "synced";
}

/**
 * The person's flashcards: found in their documents as they write, studied on any
 * device, with every answer kept on this device and copied to their account.
 */
export function useFlashcards({ userId, conversations, enabled = true }: { userId: string; conversations: Record<string, Conversation>; enabled?: boolean }) {
  const namespace = apiStorageNamespace(userId);
  const store = useMemo(() => new FlashcardStore(namespace), [namespace]);
  const snapshot = useSyncExternalStore(useCallback((listener) => store.subscribe(listener), [store]), () => store.getSnapshot());
  const [loaded, setLoaded] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("local");
  const [settings, setSettingsState] = useState<FlashcardSettings>(loadFlashcardSettings);
  const parsedAt = useRef(new Map<string, string>());
  const syncTimer = useRef<number | null>(null);
  const syncing = useRef<Promise<void> | null>(null);
  const accountSync = useRef(true);

  useEffect(() => {
    setLoaded(false);
    parsedAt.current = new Map();
    accountSync.current = true;
    let cancelled = false;
    void store.ready.then(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [store]);

  const sync = useCallback(() => {
    if (!enabled || !accountSync.current) return Promise.resolve();
    if (syncing.current) return syncing.current;
    setSyncStatus("syncing");
    syncing.current = store.ready.then(() => syncOnce(store, userId)).then((status) => {
      if (status === "local") accountSync.current = false;
      setSyncStatus(status);
    }, () => setSyncStatus(typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "error"))
      .finally(() => { syncing.current = null; });
    return syncing.current;
  }, [enabled, store, userId]);

  const scheduleSync = useCallback(() => {
    if (syncTimer.current !== null) window.clearTimeout(syncTimer.current);
    syncTimer.current = window.setTimeout(() => { syncTimer.current = null; void sync(); }, SYNC_DELAY_MS);
  }, [sync]);

  // Pull at start, every few minutes, when the window comes back and when the network returns.
  useEffect(() => {
    if (!loaded || !enabled) return;
    void sync();
    const interval = window.setInterval(() => void sync(), PULL_EVERY_MS);
    const onVisible = () => { if (document.visibilityState === "visible") void sync(); };
    const onOnline = () => { accountSync.current = true; void sync(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, [enabled, loaded, sync]);

  useEffect(() => () => { if (syncTimer.current !== null) window.clearTimeout(syncTimer.current); }, []);

  // Read cards from documents that changed since the last look. A document this device
  // hasn't downloaded is simply not looked at, so its cards stay as they were.
  useEffect(() => {
    if (!loaded || !enabled) return;
    const timer = window.setTimeout(() => {
      let changed = 0;
      for (const conversation of Object.values(conversations)) {
        // A note from the vault that hasn't been edited here yet has no document blocks of its own.
        const blocks = conversation.document?.blocks ?? (getStandaloneNote(conversation) ? getEditableDocument(conversation).blocks : undefined);
        if (!blocks || parsedAt.current.get(conversation.id) === conversation.updatedAt) continue;
        parsedAt.current.set(conversation.id, conversation.updatedAt);
        const cards = parseDocumentFlashcards(conversation.id, blocks);
        // A document that never had cards costs nothing to skip.
        if (!cards.length && ![...store.getSnapshot().cards.values()].some((card) => card.docId === conversation.id && !card.removed)) continue;
        changed += store.syncDocument(conversation.id, conversation.title || "Untitled", cards);
      }
      if (changed) scheduleSync();
    }, 600);
    return () => window.clearTimeout(timer);
  }, [conversations, enabled, loaded, scheduleSync, store]);

  const scheduled = useMemo(() => scheduleCards(snapshot, settings), [settings, snapshot]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 60_000); return () => window.clearInterval(timer); }, []);
  const queue = useMemo(() => buildStudyQueue(scheduled, now, { newPerDay: settings.newPerDay, newStudiedToday: newStudiedToday(scheduled, now) }),
    [now, scheduled, settings.newPerDay]);

  const answer = useCallback(async (cardId: string, rating: FlashcardRating, durationMs?: number) => {
    const review: FlashcardReview = {
      id: crypto.randomUUID(), cardId, rating, reviewedAt: new Date().toISOString(),
      ...(durationMs !== undefined ? { durationMs: Math.max(0, Math.round(durationMs)) } : {}),
    };
    await store.addReview(review);
    scheduleSync();
    return review;
  }, [scheduleSync, store]);

  const undo = useCallback((reviewId: string) => store.undoReview(reviewId), [store]);
  const suspend = useCallback((cardId: string, suspended = true) => { store.setSuspended(cardId, suspended); scheduleSync(); }, [scheduleSync, store]);
  const setSettings = useCallback((next: FlashcardSettings) => { saveFlashcardSettings(next); setSettingsState(next); }, []);

  return {
    store, snapshot, loaded, syncStatus, settings, setSettings, scheduled, queue,
    totalCards: scheduled.length,
    dueCount: queue.dueCount + queue.newCount,
    answer, undo, suspend, sync,
  };
}

export type FlashcardsController = ReturnType<typeof useFlashcards>;
