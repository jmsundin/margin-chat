import { useEffect, useMemo, useState } from "react";
import type { Conversation, ConversationGroup, ThreadCategoryId } from "../types";
import { requestJevWorkspace } from "./jevAssistance";
import { buildJevGroupEvidence, buildJevGroupSnapshot, JEV_GROUP_BATCH_SIZE, orderJevGroups, type JevGroupEvidence } from "./jevGroupCategories";

type GroupStatus = "off" | "loading" | "ready" | "unavailable";
type Judgment = { categoryId?: ThreadCategoryId };
const accountCaches = new Map<string, Map<string, Judgment>>();
const DEBOUNCE_MS = 400;
const REQUEST_TIMEOUT_MS = 15_000;

function accountCache(userId: string) {
  let cache = accountCaches.get(userId);
  if (!cache) { cache = new Map(); accountCaches.set(userId, cache); }
  // Evidence stays in memory and never crosses accounts or enters workspace data.
  while (accountCaches.size > 4) accountCaches.delete(accountCaches.keys().next().value!);
  return cache;
}

export function useJevGroupCategories({ userId, enabled, ready, conversations, groups }: {
  userId: string;
  enabled: boolean;
  ready: boolean;
  conversations: Record<string, Conversation>;
  groups: Record<string, ConversationGroup>;
}) {
  const evidence = useMemo(() => buildJevGroupEvidence(groups, conversations), [groups, conversations]);
  // Only permitted semantic evidence changes this key: no camera, collapse, color,
  // timestamps, annotations, or selection can start another inference request.
  const key = JSON.stringify(evidence);
  const groupOrder = JSON.stringify(Object.values(groups).map((group) => group.id));
  const [view, setView] = useState<{ userId: string; key: string; status: GroupStatus; categories: Record<string, ThreadCategoryId> }>({
    userId: "", key: "", status: "off", categories: {},
  });

  useEffect(() => {
    if (!userId || !enabled || !ready) return;
    const requested: JevGroupEvidence[] = JSON.parse(key);
    const cache = accountCache(userId);
    const missing = requested.filter((entry) => !cache.has(entry.fingerprint));
    const categoriesFromCache = () => {
      const categories: Record<string, ThreadCategoryId> = Object.create(null);
      for (const entry of requested) {
        const category = cache.get(entry.fingerprint)?.categoryId;
        if (category) categories[entry.groupId] = category;
      }
      return categories;
    };
    if (!missing.length) {
      setView({ userId, key, status: "ready", categories: categoriesFromCache() });
      return;
    }
    let active = true;
    const controller = new AbortController();
    const timeouts = new Set<ReturnType<typeof setTimeout>>();
    setView((previous) => ({ userId, key, status: "loading", categories: previous.userId === userId ? previous.categories : {} }));
    const timer = setTimeout(async () => {
      const staged = new Map<string, Judgment>();
      let failed = false, nextBatch = 0;
      const batches: JevGroupEvidence[][] = [];
      for (let index = 0; index < missing.length; index += JEV_GROUP_BATCH_SIZE) batches.push(missing.slice(index, index + JEV_GROUP_BATCH_SIZE));
      async function worker() {
        while (active && !controller.signal.aborted && nextBatch < batches.length) {
          const batch = batches[nextBatch++];
          const snapshot = buildJevGroupSnapshot(batch)!;
          const timeout = setTimeout(() => { failed = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
          timeouts.add(timeout);
          try {
            const result = await requestJevWorkspace(userId, snapshot, snapshot.items.map((item) => item.id), controller.signal);
            if (!active || controller.signal.aborted) return;
            if (!result.available || result.warning) failed = true;
            const accepted = new Map(result.categories.map((category) => [category.id, category.categoryId]));
            // Older production responses omit coverage. A complete successful
            // response can still cache uncertainty without repeating every pan.
            const evaluated = new Set(result.evaluatedCategoryIds ?? (result.available && !result.warning ? snapshot.items.map((item) => item.id) : []));
            for (const entry of batch) {
              if (accepted.has(entry.groupId) || evaluated.has(entry.groupId)) staged.set(entry.fingerprint, { categoryId: accepted.get(entry.groupId) });
            }
          } catch { failed = true; }
          finally { clearTimeout(timeout); timeouts.delete(timeout); }
        }
      }
      await Promise.all([worker(), worker()]);
      if (!active) return;
      if (!controller.signal.aborted) for (const [fingerprint, judgment] of staged) cache.set(fingerprint, judgment);
      const categories = categoriesFromCache();
      while (cache.size > 1000) cache.delete(cache.keys().next().value!);
      setView({ userId, key, status: failed ? "unavailable" : "ready", categories });
    }, DEBOUNCE_MS);
    return () => {
      active = false;
      clearTimeout(timer);
      for (const timeout of timeouts) clearTimeout(timeout);
      controller.abort();
    };
  }, [userId, enabled, ready, key]);

  const permitted = Boolean(userId && enabled && ready);
  return useMemo(() => {
    const groupIds: string[] = JSON.parse(groupOrder);
    const categories: Record<string, ThreadCategoryId> = Object.create(null);
    if (permitted && view.userId === userId) for (const id of groupIds) if (Object.hasOwn(view.categories, id)) categories[id] = view.categories[id];
    const status: GroupStatus = !permitted ? "off" : view.userId === userId && view.key === key ? view.status : "loading";
    return { status, categories, ...orderJevGroups(groupIds, categories) };
  }, [permitted, userId, view, key, groupOrder]);
}
