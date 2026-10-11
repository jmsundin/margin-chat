import { useEffect, useMemo, useState } from "react";
import type { Conversation } from "../types";
import { requestClusterCategories } from "./api";
import type { SubjectCluster } from "./gravityClusters";

/** Clusters named in one request, biggest first; smaller ones keep per-cluster labels. */
export const MAX_NAMED_CLUSTERS = 80;
const TITLES_PER_CLUSTER = 6;
const MAX_TITLE_LENGTH = 60;
const MAX_PROMPT_LENGTH = 29_000;
/** A changed cluster keeps its name while it still shares this much of its membership. */
const KEEP_NAME_OVERLAP = 0.6;
const DEBOUNCE_MS = 1_500;
const STORAGE_PREFIX = "margin-chat:subject-categories:v1:";

interface NamedCluster { fingerprint: string; name: string; memberIds: string[] }
const memoryCaches = new Map<string, NamedCluster[]>();
// One request per set of clusters per session, so a failing provider is not retried on every render.
const attempted = new Set<string>();

function readCache(userId: string): NamedCluster[] {
  const cached = memoryCaches.get(userId);
  if (cached) return cached;
  let stored: NamedCluster[] = [];
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_PREFIX + userId) ?? "[]");
    if (Array.isArray(parsed)) stored = parsed.filter((entry): entry is NamedCluster => !!entry && typeof entry.fingerprint === "string"
      && typeof entry.name === "string" && Array.isArray(entry.memberIds) && entry.memberIds.every((id: unknown) => typeof id === "string"));
  } catch { /* Storage can be unavailable; names are simply asked for again. */ }
  memoryCaches.set(userId, stored);
  return stored;
}

function writeCache(userId: string, named: NamedCluster[]) {
  memoryCaches.set(userId, named);
  try { localStorage.setItem(STORAGE_PREFIX + userId, JSON.stringify(named)); } catch { /* Best effort. */ }
}

function overlap(a: Set<string>, b: string[]) {
  let shared = 0;
  for (const id of b) if (a.has(id)) shared++;
  return shared / (a.size + b.length - shared || 1);
}

/**
 * Names for clusters from earlier passes: the same cluster keeps its name, and a
 * cluster that changed a little (a note added, one moved) keeps the name of the
 * earlier cluster it mostly matches.
 */
export function carryCategoryNames(clusters: Array<Pick<SubjectCluster, "fingerprint" | "memberIds">>, named: NamedCluster[]) {
  const exact = new Map(named.map((entry) => [entry.fingerprint, entry.name]));
  const names = new Map<string, string>();
  for (const cluster of clusters) {
    const known = exact.get(cluster.fingerprint);
    if (known) { names.set(cluster.fingerprint, known); continue; }
    const members = new Set(cluster.memberIds);
    let best = KEEP_NAME_OVERLAP, bestName: string | undefined;
    for (const entry of named) {
      const score = overlap(members, entry.memberIds);
      if (score >= best) { best = score; bestName = entry.name; }
    }
    if (bestName) names.set(cluster.fingerprint, bestName);
  }
  return names;
}

/** One line per cluster: its number, size, a few titles, and the name it had before. */
export function buildCategoriesPrompt(clusters: Array<Pick<SubjectCluster, "memberIds">>, conversations: Record<string, Conversation>,
  previous: ReadonlyMap<number, string> = new Map()) {
  const lines: string[] = [];
  let length = 0;
  clusters.forEach((cluster, index) => {
    const titles = cluster.memberIds.slice(0, TITLES_PER_CLUSTER * 2)
      .map((id) => conversations[id]?.title.trim().replace(/\s+/gu, " ").slice(0, MAX_TITLE_LENGTH))
      .filter((title): title is string => !!title && !/^untitled/iu.test(title)).slice(0, TITLES_PER_CLUSTER);
    const before = previous.get(index);
    const line = `C${index + 1} (${cluster.memberIds.length} docs): ${titles.join("; ") || "Untitled documents"}${before ? ` [was: ${before}]` : ""}`;
    if (length + line.length + 1 > MAX_PROMPT_LENGTH) return;
    lines.push(line);
    length += line.length + 1;
  });
  return lines.join("\n");
}

/**
 * Names every sizable cluster in one AI request, so clusters on the same
 * subject (Angular components, Angular ViewChild) come back with the same name
 * and can be combined. Names are kept in this browser and carried over while a
 * cluster changes only a little, so they stay put as notes are added. Respects
 * the Jev preference: with AI assistance off, nothing is sent.
 */
export function useSubjectCategories({ userId, enabled, active, clusters, conversations }: {
  userId: string;
  /** The user allows AI assistance (Jev). */
  enabled: boolean;
  /** A view showing categories is on screen, so a request may be sent. */
  active: boolean;
  /** Clusters from groupSubjects, before any merging or moves. */
  clusters: SubjectCluster[];
  conversations: Record<string, Conversation>;
}) {
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const wanted = useMemo(() => clusters.filter((cluster) => cluster.hubId !== null && cluster.memberIds.length >= 2)
    .slice(0, MAX_NAMED_CLUSTERS), [clusters]);
  const wantedKey = wanted.map((cluster) => cluster.fingerprint).join(",");

  useEffect(() => {
    if (!userId || !enabled || !active || !wanted.length) return;
    const named = readCache(userId);
    const carried = carryCategoryNames(wanted, named);
    if (wanted.every((cluster) => carried.has(cluster.fingerprint)) || attempted.has(`${userId}:${wantedKey}`)) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      attempted.add(`${userId}:${wantedKey}`);
      setLoading(true);
      try {
        const previous = new Map(wanted.flatMap((cluster, index) => carried.has(cluster.fingerprint) ? [[index, carried.get(cluster.fingerprint)!] as const] : []));
        const content = buildCategoriesPrompt(wanted, conversations, previous);
        const categories = await requestClusterCategories({ content, expectedUserId: userId, signal: controller.signal });
        if (controller.signal.aborted) return;
        const answered = new Map(categories.map((entry) => [entry.cluster - 1, entry.name]));
        // Clusters the model skipped keep what they had.
        writeCache(userId, wanted.flatMap((cluster, index) => {
          const name = answered.get(index) ?? carried.get(cluster.fingerprint);
          return name ? [{ fingerprint: cluster.fingerprint, name, memberIds: cluster.memberIds }] : [];
        }));
        setRevision((value) => value + 1);
      } catch {
        // An aborted pass may retry later; a provider failure leaves clusters unmerged.
        if (controller.signal.aborted) attempted.delete(`${userId}:${wantedKey}`);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => { clearTimeout(timer); controller.abort(); setLoading(false); };
    // `conversations` is read when the pass starts; title edits alone never trigger one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, enabled, active, wantedKey]);

  const names = useMemo(() => enabled && userId ? carryCategoryNames(wanted, readCache(userId)) : new Map<string, string>(),
    // `revision` re-reads the cache after names arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wanted, userId, enabled, revision]);
  return { names, loading };
}
