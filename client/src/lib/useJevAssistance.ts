import { useEffect, useMemo, useRef, useState } from "react";
import type { Conversation, ConversationGroup, ThreadCategoryId } from "../types";
import {
  buildJevWorkspaceSnapshot, jevItemFingerprint, loadJevPreference, saveJevPreference,
  requestJevStatus, requestJevWorkspace,
  type JevGroupSuggestions, type JevStatus, type JevWorkspaceResult, type JevWorkspaceSnapshot,
} from "./jevAssistance";

const CACHE_TTL_MS = 5 * 60_000;
const DEBOUNCE_MS = 1200;
const REQUEST_TIMEOUT_MS = 10_000;
type CategoryJudgment = { at: number; fingerprint: string; categoryId?: ThreadCategoryId };
type CachedWorkspaceResult = { at: number; result: JevWorkspaceResult; categoryJudgments: Map<string, CategoryJudgment> };

export function useJevPreference(userId: string) {
  const [preference, setPreference] = useState(() => ({ userId, enabled: loadJevPreference(userId) }));
  const enabled = preference.userId === userId ? preference.enabled : loadJevPreference(userId);
  function setEnabled(value: boolean) {
    saveJevPreference(userId, value);
    setPreference({ userId, enabled: value });
  }
  useEffect(() => {
    const refresh = () => setPreference({ userId, enabled: loadJevPreference(userId) });
    window.addEventListener("storage", refresh);
    return () => window.removeEventListener("storage", refresh);
  }, [userId]);
  return [enabled, setEnabled] as const;
}

export function useJevAssistance({ userId, enabled, ready, conversations, groups, currentId, pending }: {
  userId: string;
  enabled: boolean;
  ready: boolean;
  conversations: Record<string, Conversation>;
  groups?: Record<string, ConversationGroup>;
  currentId: string;
  pending: boolean;
}) {
  const [configuration, setConfiguration] = useState<{ key: string; configured: boolean | null; failed?: boolean }>({ key: "", configured: null });
  const configurationKey = `${userId}:${enabled}`;
  const configured = configuration.key === configurationKey ? configuration.configured : null;
  const [view, setView] = useState<{ key: string; status: JevStatus; result?: JevWorkspaceResult }>({ key: "", status: "off" });
  const cache = useRef({ userId, results: new Map<string, CachedWorkspaceResult>(), categories: new Map<string, CategoryJudgment>() });
  if (cache.current.userId !== userId) cache.current = { userId, results: new Map(), categories: new Map() };
  const snapshot = useMemo(() => enabled && ready && !pending ? buildJevWorkspaceSnapshot(conversations, currentId, groups) : null, [conversations, groups, currentId, enabled, pending, ready]);
  const key = snapshot ? JSON.stringify(snapshot) : "";
  const requestKey = `${userId}:${key}`;

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    requestJevStatus(userId, controller.signal).then((value) => {
      if (active) setConfiguration({ key: configurationKey, configured: value });
    }).catch(() => {
      if (active) setConfiguration({ key: configurationKey, configured: null, failed: true });
    }).finally(() => clearTimeout(timeout));
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, [configurationKey, enabled, userId]);

  useEffect(() => {
    if (!enabled || !ready || pending || !configured || !key) return;
    const accountCache = cache.current;
    const requestSnapshot: JevWorkspaceSnapshot = JSON.parse(key);
    const cached = accountCache.results.get(key);
    const at = Date.now();
    // Results can omit categories already known when they were requested. Keep
    // their complete positive/uncertain coverage so undo restores that snapshot.
    const hasFreshCategoryCoverage = cached && requestSnapshot.items.every((item) => {
      const judgment = cached.categoryJudgments.get(item.id);
      return judgment && judgment.fingerprint === jevItemFingerprint(item) && at - judgment.at < CACHE_TTL_MS;
    });
    if (cached && at - cached.at < CACHE_TTL_MS && hasFreshCategoryCoverage) {
      for (const [id, judgment] of cached.categoryJudgments) accountCache.categories.set(id, judgment);
      while (accountCache.categories.size > 1000) accountCache.categories.delete(accountCache.categories.keys().next().value!);
      setView({ key: requestKey, status: cached.result.available ? "ready" : "unavailable", result: cached.result });
      return;
    }
    let active = true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    setView({ key: requestKey, status: "loading" });
    const timer = setTimeout(async () => {
      const categoryIds = requestSnapshot.items.filter((item) => {
        const previous = accountCache.categories.get(item.id);
        return !previous || previous.fingerprint !== jevItemFingerprint(item) || Date.now() - previous.at >= CACHE_TTL_MS;
      }).map((item) => item.id);
      timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const result = await requestJevWorkspace(userId, requestSnapshot, categoryIds, controller.signal);
        if (!active) return;
        if (controller.signal.aborted) { setView({ key: requestKey, status: "unavailable" }); return; }
        const at = Date.now();
        for (const id of result.evaluatedCategoryIds ?? []) {
          const item = requestSnapshot.items.find((candidate) => candidate.id === id);
          if (item) accountCache.categories.set(id, { at, fingerprint: jevItemFingerprint(item) });
        }
        for (const category of result.categories) {
          const item = requestSnapshot.items.find((candidate) => candidate.id === category.id)!;
          accountCache.categories.set(category.id, { at, fingerprint: jevItemFingerprint(item), categoryId: category.categoryId });
        }
        while (accountCache.categories.size > 1000) accountCache.categories.delete(accountCache.categories.keys().next().value!);
        // Partial failures remain retryable. Snapshot reused judgments with their
        // original timestamps, including negative judgments with no categoryId.
        if (result.available && !result.warning) {
          const categoryJudgments = new Map<string, CategoryJudgment>();
          for (const item of requestSnapshot.items) {
            const judgment = accountCache.categories.get(item.id);
            if (judgment && judgment.fingerprint === jevItemFingerprint(item) && at - judgment.at < CACHE_TTL_MS) categoryJudgments.set(item.id, judgment);
          }
          accountCache.results.set(key, { at, result, categoryJudgments });
        }
        if (accountCache.results.size > 32) accountCache.results.delete(accountCache.results.keys().next().value!);
        setView({ key: requestKey, status: result.available ? "ready" : "unavailable", result });
      } catch {
        if (active) setView({ key: requestKey, status: "unavailable" });
      } finally { clearTimeout(timeout); }
    }, DEBOUNCE_MS);
    return () => { active = false; clearTimeout(timer); clearTimeout(timeout); controller.abort(); };
    // The serialized whitelist changes only when permitted content changes, not on unrelated state edits.
  }, [userId, enabled, ready, pending, configured, key, requestKey]);

  const categories: Record<string, ThreadCategoryId> = Object.create(null);
  if (enabled && snapshot) {
    for (const item of snapshot.items) {
      const cached = cache.current.categories.get(item.id);
      if (cached?.categoryId && cached.fingerprint === jevItemFingerprint(item) && Date.now() - cached.at < CACHE_TTL_MS) categories[item.id] = cached.categoryId;
    }
  }
  let status: JevStatus = "off";
  if (enabled) {
    status = configuration.key === configurationKey && configuration.failed ? "unavailable" : configured === false ? "unconfigured" : pending ? "paused" : view.key === requestKey && view.status === "unavailable" ? "unavailable" : configured === null ? "checking" : view.key === requestKey ? view.status : "loading";
  }
  const result = enabled && !pending && view.key === requestKey ? view.result : undefined;
  const groupSuggestions: JevGroupSuggestions = Object.create(null);
  if (result?.available) {
    for (const suggestion of result.groupSuggestions) groupSuggestions[suggestion.id] = { groupId: suggestion.groupId, confidence: suggestion.confidence };
  }
  return { status, categories, groupSuggestions, related: result?.available ? result.related : [], warning: result?.warning, model: result?.model };
}
