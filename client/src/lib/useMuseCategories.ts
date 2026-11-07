import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Conversation } from "../types";
import { requestDocumentCategories } from "./api";
import {
  buildMuseCategoriesPrompt, museCategoryGroups, museDocumentSignature, museKnownCategories, musePendingIds,
  museSortableIds, MUSE_BATCH_SIZE, readMuseCategoryCache, type MuseCategoryCache,
} from "./museCategories";

const STORAGE_PREFIX = "margin-chat:muse-categories:v1:";
const DEBOUNCE_MS = 1_200;
/**
 * Documents sorted without asking, each time the view opens. Muse Wonder costs
 * roughly ten cents per batch, so a big vault sorts the rest only when asked.
 */
export const MUSE_AUTO_SORT_LIMIT = MUSE_BATCH_SIZE * 6;

const memoryCaches = new Map<string, MuseCategoryCache>();

function readCache(userId: string): MuseCategoryCache {
  const cached = memoryCaches.get(userId);
  if (cached) return cached;
  let stored: MuseCategoryCache = {};
  try { stored = readMuseCategoryCache(JSON.parse(localStorage.getItem(STORAGE_PREFIX + userId) ?? "{}")); }
  catch { /* Storage can be unavailable; documents are simply sorted again. */ }
  memoryCaches.set(userId, stored);
  return stored;
}

function writeCache(userId: string, cache: MuseCategoryCache) {
  memoryCaches.set(userId, cache);
  try { localStorage.setItem(STORAGE_PREFIX + userId, JSON.stringify(cache)); } catch { /* Best effort. */ }
}

export interface MuseCategoriesState {
  /** Category boxes for the Map. */
  groups: ReturnType<typeof museCategoryGroups>;
  /** Muse Wonder is reading a batch right now. */
  loading: boolean;
  error: string | null;
  /** Main documents Muse Wonder can see on the map, and how many have a category. */
  total: number;
  sorted: number;
  /** Documents left waiting because the automatic limit was reached. */
  waiting: number;
  /** Sort the documents still waiting (or retry after an error). */
  sortMore: () => void;
  /** Forget Muse Wonder's categories (not the ones filed by hand) and sort everything again. */
  sortAgain: () => void;
  /** File documents under a category by hand; Muse Wonder won't move them. */
  fileUnder: (ids: string[], name: string) => void;
}

/**
 * Sorts the Map's documents into categories with Muse Wonder, a batch at a
 * time, and remembers each one in this browser until the document's title or
 * opening text changes. Respects the Jev preference: with AI assistance off,
 * nothing is sent. Documents hidden from AI are never sent.
 */
export function useMuseCategories({ userId, enabled, active, ids, conversations }: {
  userId: string;
  /** The user allows AI assistance (Jev). */
  enabled: boolean;
  /** The Map is showing Muse categories, so requests may be sent. */
  active: boolean;
  /** Documents on the map. */
  ids: string[];
  conversations: Record<string, Conversation>;
}): MuseCategoriesState {
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // How many documents may still be sent without asking; "Sort the rest" raises it.
  const [allowance, setAllowance] = useState(MUSE_AUTO_SORT_LIMIT);
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;

  const sortable = useMemo(() => museSortableIds(ids, conversations), [ids, conversations]);
  const cache = useMemo(() => userId ? readCache(userId) : {},
    // `revision` re-reads the cache after a batch is saved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [userId, revision]);
  const pending = useMemo(() => musePendingIds(sortable, conversations, cache), [sortable, conversations, cache]);
  const pendingKey = pending.join(",");

  useEffect(() => {
    if (!userId || !enabled || !active || !pending.length || error || allowance <= 0) return;
    const controller = new AbortController();
    // One batch per pass: saving it changes what's pending, which starts the next pass.
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const { content, ids: batch } = buildMuseCategoriesPrompt(pending.slice(0, Math.min(MUSE_BATCH_SIZE, allowance)),
          conversationsRef.current, museKnownCategories(readCache(userId)));
        if (!batch.length) return;
        const answers = await requestDocumentCategories({ content, expectedUserId: userId, signal: controller.signal });
        if (controller.signal.aborted) return;
        const next = { ...readCache(userId) };
        for (const answer of answers) {
          const id = batch[answer.document - 1];
          const conversation = id ? conversationsRef.current[id] : undefined;
          if (!conversation || next[id]?.manual) continue;
          next[id] = { name: answer.name, signature: museDocumentSignature(conversation) };
        }
        writeCache(userId, next);
        // Documents Muse Wonder skipped stay pending, but still count, so a skip can't loop.
        setAllowance((value) => Math.max(0, value - batch.length));
        setRevision((value) => value + 1);
      } catch (caught) {
        if (!controller.signal.aborted) setError(caught instanceof Error && caught.message ? caught.message : "Muse Wonder couldn't sort your documents.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => { clearTimeout(timer); controller.abort(); setLoading(false); };
    // `pending` is read through its key; title edits re-run only when a signature changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, enabled, active, pendingKey, error, allowance]);

  const sortMore = useCallback(() => { setError(null); setAllowance((value) => Math.max(value, 0) + MUSE_AUTO_SORT_LIMIT); }, []);
  const sortAgain = useCallback(() => {
    if (!userId) return;
    writeCache(userId, Object.fromEntries(Object.entries(readCache(userId)).filter(([, entry]) => entry.manual)));
    setError(null);
    setAllowance(MUSE_AUTO_SORT_LIMIT);
    setRevision((value) => value + 1);
  }, [userId]);
  const fileUnder = useCallback((targetIds: string[], name: string) => {
    if (!userId || !targetIds.length) return;
    const next = { ...readCache(userId) };
    for (const id of targetIds) {
      const conversation = conversationsRef.current[id];
      if (conversation) next[id] = { name, signature: museDocumentSignature(conversation), manual: true };
    }
    writeCache(userId, next);
    setRevision((value) => value + 1);
  }, [userId]);

  const groups = useMemo(() => museCategoryGroups(enabled ? sortable : [], cache), [enabled, sortable, cache]);
  const sorted = sortable.length - pending.length;
  return {
    groups, loading, error, total: sortable.length, sorted,
    waiting: !loading && !error && allowance <= 0 ? pending.length : 0,
    sortMore, sortAgain, fileUnder,
  };
}
