import { useEffect, useMemo, useState } from "react";
import { isHiddenFromAI } from "@margin-chat/workspace-contracts";
import type { Conversation } from "../types";
import { requestClusterLabel } from "./api";
import { getDocumentPreview } from "./documentSources";
import type { GravityCluster } from "./gravityClusters";

/** Clusters this small keep their hub's title; Luna names larger ones. */
export const MIN_LABELED_CLUSTER_SIZE = 3;
const MAX_CLUSTERS_PER_PASS = 60;
const MAX_MEMBERS_IN_PROMPT = 40;
const MAX_PROMPT_LENGTH = 7_500;
const MAX_CACHED_LABELS = 1_000;
const DEBOUNCE_MS = 800;
const CONCURRENCY = 2;
const STORAGE_PREFIX = "margin-chat:cluster-labels:v1:";
const MEMBERS_STORAGE_PREFIX = "margin-chat:cluster-members:v1:";
/** A cluster sharing at least this much (Jaccard) with a named one keeps that name while it has none. */
const KEEP_NAME_OVERLAP = 0.6;
/** Sharing this much, it is the same cluster with a few changes: the name is kept for good and nothing is asked. */
const SAME_CLUSTER_OVERLAP = 0.8;
const MAX_REMEMBERED_CLUSTERS = 300;
const MAX_REMEMBERED_MEMBERS = 60;

type LabelCache = Record<string, string>;
const memoryCaches = new Map<string, LabelCache>();
/** The members each labelled cluster had, by fingerprint, so a cluster that changed a little keeps its name. */
const memberCaches = new Map<string, Record<string, string[]>>();
// One attempt per cluster membership per session, so a failing provider is not
// retried on every pan, zoom, or re-render.
const attempted = new Set<string>();

function readCache(userId: string): LabelCache {
  const cached = memoryCaches.get(userId);
  if (cached) return cached;
  let stored: LabelCache = {};
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_PREFIX + userId) ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      stored = Object.fromEntries(Object.entries(parsed as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string" && !!entry[1]));
    }
  } catch { /* Storage can be unavailable; labels are simply regenerated. */ }
  memoryCaches.set(userId, stored);
  return stored;
}

function writeCache(userId: string, cache: LabelCache) {
  const entries = Object.entries(cache);
  const kept = entries.length > MAX_CACHED_LABELS ? Object.fromEntries(entries.slice(-MAX_CACHED_LABELS)) : cache;
  memoryCaches.set(userId, kept);
  try { localStorage.setItem(STORAGE_PREFIX + userId, JSON.stringify(kept)); } catch { /* Best effort. */ }
}

function readMembers(userId: string): Record<string, string[]> {
  const cached = memberCaches.get(userId);
  if (cached) return cached;
  let stored: Record<string, string[]> = {};
  try {
    const parsed = JSON.parse(localStorage.getItem(MEMBERS_STORAGE_PREFIX + userId) ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      stored = Object.fromEntries(Object.entries(parsed as Record<string, unknown>)
        .filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every((id) => typeof id === "string")));
    }
  } catch { /* Storage can be unavailable; names are then carried within this visit only. */ }
  memberCaches.set(userId, stored);
  return stored;
}

function rememberMembers(userId: string, clusters: Array<Pick<GravityCluster, "fingerprint" | "memberIds">>, labels: LabelCache) {
  const members = readMembers(userId);
  let changed = false;
  for (const cluster of clusters) {
    if (!labels[cluster.fingerprint] || members[cluster.fingerprint]) continue;
    members[cluster.fingerprint] = cluster.memberIds.slice(0, MAX_REMEMBERED_MEMBERS);
    changed = true;
  }
  if (!changed) return;
  const entries = Object.entries(members);
  const kept = entries.length > MAX_REMEMBERED_CLUSTERS ? Object.fromEntries(entries.slice(-MAX_REMEMBERED_CLUSTERS)) : members;
  memberCaches.set(userId, kept);
  try { localStorage.setItem(MEMBERS_STORAGE_PREFIX + userId, JSON.stringify(kept)); } catch { /* Best effort. */ }
}

function overlap(a: Set<string>, b: string[]) {
  let shared = 0;
  for (const id of b) if (a.has(id)) shared++;
  return shared / (a.size + b.length - shared || 1);
}

/**
 * The name of the labelled cluster that `cluster` mostly is, when one shares
 * enough members with it, and whether it is close enough to count as the same
 * cluster. A note added or moved then changes nothing on the map.
 */
export function carriedClusterLabel(cluster: Pick<GravityCluster, "fingerprint" | "memberIds">, labels: LabelCache,
  members: Record<string, string[]>): { label: string; same: boolean } | null {
  const own = new Set(cluster.memberIds);
  let best = KEEP_NAME_OVERLAP, bestLabel: string | undefined;
  for (const [fingerprint, label] of Object.entries(labels)) {
    const remembered = members[fingerprint];
    if (!remembered || fingerprint === cluster.fingerprint) continue;
    const score = overlap(own, remembered);
    if (score >= best) { best = score; bestLabel = label; }
  }
  return bestLabel ? { label: bestLabel, same: best >= SAME_CLUSTER_OVERLAP } : null;
}

/** Titles and short excerpts, hub first, within the title endpoint's prompt limit. */
export function buildClusterLabelPrompt(cluster: Pick<GravityCluster, "memberIds">, conversations: Record<string, Conversation>) {
  const lines: string[] = [];
  let length = 0;
  for (const id of cluster.memberIds.slice(0, MAX_MEMBERS_IN_PROMPT)) {
    const conversation = conversations[id];
    if (!conversation || isHiddenFromAI(conversation)) continue;
    const preview = getDocumentPreview(conversation, 160);
    const line = `- ${conversation.title.trim() || "Untitled"}${preview && preview !== "No content yet" ? `: ${preview}` : ""}`;
    if (length + line.length + 1 > MAX_PROMPT_LENGTH) break;
    lines.push(line);
    length += line.length + 1;
  }
  return lines.length ? `Documents in this cluster (the first is its hub):\n${lines.join("\n")}` : "";
}

export function clusterFallbackLabel(cluster: Pick<GravityCluster, "hubId">, conversations: Record<string, Conversation>) {
  if (cluster.hubId === null) return "Unlinked documents";
  return conversations[cluster.hubId]?.title.trim() || "Untitled cluster";
}

/**
 * Labels each sizable cluster with OpenAI Luna, cached by cluster membership in
 * this browser so Luna is only asked again when a cluster's documents change.
 * Respects the Jev preference: with AI assistance off, nothing is sent.
 */
export function useClusterLabels({ userId, enabled, active, clusters, conversations }: {
  userId: string;
  /** The user allows AI assistance (Jev). */
  enabled: boolean;
  /** The Clusters view is on screen, so new labels may be requested. */
  active: boolean;
  clusters: GravityCluster[];
  conversations: Record<string, Conversation>;
}) {
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const wanted = useMemo(() => clusters
    .filter((cluster) => cluster.hubId !== null && cluster.memberIds.length >= MIN_LABELED_CLUSTER_SIZE)
    .slice(0, MAX_CLUSTERS_PER_PASS), [clusters]);
  // Only membership changes start requests; titles typed afterwards do not.
  const wantedKey = wanted.map((cluster) => cluster.fingerprint).join(",");

  useEffect(() => {
    if (!userId || !enabled || !active || !wanted.length) return;
    const cache = readCache(userId);
    // A cluster that is an old one with a few changes keeps the old name for good, and is not asked about again.
    const members = readMembers(userId);
    const carried: LabelCache = {};
    for (const cluster of wanted) {
      if (cache[cluster.fingerprint]) continue;
      const found = carriedClusterLabel(cluster, cache, members);
      if (found?.same) carried[cluster.fingerprint] = found.label;
    }
    if (Object.keys(carried).length) { writeCache(userId, { ...cache, ...carried }); setRevision((value) => value + 1); }
    const missing = wanted.filter((cluster) => !cache[cluster.fingerprint] && !carried[cluster.fingerprint] && !attempted.has(`${userId}:${cluster.fingerprint}`));
    if (!missing.length) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      let next = 0;
      async function worker() {
        while (!controller.signal.aborted && next < missing.length) {
          const cluster = missing[next++];
          const content = buildClusterLabelPrompt(cluster, conversations);
          if (!content) continue;
          attempted.add(`${userId}:${cluster.fingerprint}`);
          try {
            const label = await requestClusterLabel({ content, expectedUserId: userId, signal: controller.signal });
            if (controller.signal.aborted) return;
            writeCache(userId, { ...readCache(userId), [cluster.fingerprint]: label });
            setRevision((value) => value + 1);
          } catch {
            // An aborted pass may retry later; a provider failure keeps the hub title.
            if (controller.signal.aborted) attempted.delete(`${userId}:${cluster.fingerprint}`);
          }
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      if (!controller.signal.aborted) setLoading(false);
    }, DEBOUNCE_MS);
    return () => { clearTimeout(timer); controller.abort(); setLoading(false); };
    // `conversations` is read when the pass starts; edits alone never trigger one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, enabled, active, wantedKey]);

  // Until a changed cluster is named afresh, it keeps the name of the cluster it mostly is.
  // Found once per set of clusters: comparing every cluster with every remembered one is
  // too slow to repeat each time a name arrives.
  const carried = useMemo(() => {
    const found = new Map<string, string>();
    if (!userId || !enabled) return found;
    const cache = readCache(userId), members = readMembers(userId);
    for (const cluster of clusters) {
      if (cluster.hubId === null || cache[cluster.fingerprint]) continue;
      const label = carriedClusterLabel(cluster, cache, members)?.label;
      if (label) found.set(cluster.fingerprint, label);
    }
    return found;
  }, [clusters, userId, enabled]);

  return useMemo(() => {
    const cache = userId ? readCache(userId) : {};
    if (userId && enabled) rememberMembers(userId, clusters, cache);
    const labels: Record<string, { label: string; generated: boolean }> = {};
    for (const cluster of clusters) {
      const generated = enabled ? cache[cluster.fingerprint] ?? carried.get(cluster.fingerprint) : undefined;
      labels[cluster.id] = generated ? { label: generated, generated: true } : { label: clusterFallbackLabel(cluster, conversations), generated: false };
    }
    return { labels, loading };
    // `revision` re-reads the cache after each label arrives.
  }, [clusters, carried, conversations, userId, enabled, revision, loading]);
}
