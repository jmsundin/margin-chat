import { useEffect, useMemo, useState } from "react";
import type { Conversation } from "../types";
import { requestClusterLabel } from "./api";
import { getDocumentPreview } from "./documentSources";
import type { GravityCluster } from "./gravityClusters";

/** Clusters this small keep their hub's title; Luna names larger ones. */
export const MIN_LABELED_CLUSTER_SIZE = 3;
const MAX_CLUSTERS_PER_PASS = 40;
const MAX_MEMBERS_IN_PROMPT = 40;
const MAX_PROMPT_LENGTH = 7_500;
const MAX_CACHED_LABELS = 1_000;
const DEBOUNCE_MS = 800;
const CONCURRENCY = 2;
const STORAGE_PREFIX = "margin-chat:cluster-labels:v1:";

type LabelCache = Record<string, string>;
const memoryCaches = new Map<string, LabelCache>();
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

/** Titles and short excerpts, hub first, within the title endpoint's prompt limit. */
export function buildClusterLabelPrompt(cluster: Pick<GravityCluster, "memberIds">, conversations: Record<string, Conversation>) {
  const lines: string[] = [];
  let length = 0;
  for (const id of cluster.memberIds.slice(0, MAX_MEMBERS_IN_PROMPT)) {
    const conversation = conversations[id];
    if (!conversation) continue;
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
    const missing = wanted.filter((cluster) => !cache[cluster.fingerprint] && !attempted.has(`${userId}:${cluster.fingerprint}`));
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

  return useMemo(() => {
    const cache = userId ? readCache(userId) : {};
    const labels: Record<string, { label: string; generated: boolean }> = {};
    for (const cluster of clusters) {
      const generated = enabled ? cache[cluster.fingerprint] : undefined;
      labels[cluster.id] = generated ? { label: generated, generated: true } : { label: clusterFallbackLabel(cluster, conversations), generated: false };
    }
    return { labels, loading };
    // `revision` re-reads the cache after each label arrives.
  }, [clusters, conversations, userId, enabled, revision, loading]);
}
