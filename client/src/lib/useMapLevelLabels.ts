import { useEffect, useMemo, useState } from "react";
import { isHiddenFromAI } from "@margin-chat/workspace-contracts";
import type { Conversation } from "../types";
import { requestMapLevelLabels } from "./api";

/**
 * AI names and one-sentence summaries for the Map's zoom levels: a name and a summary for each
 * theme, a summary for each topic, and a name for each block of alike documents. One request
 * labels everything that has no label yet; labels are kept in this browser and carried over while
 * a group changes only a little, so they stay put as notes are added.
 */

export type MapLevelKind = "theme" | "topic" | "block";
export interface MapLevelTarget {
  /** The theme, box or block this labels. */
  id: string;
  kind: MapLevelKind;
  memberIds: string[];
  /** A topic's name, or a theme's or block's stand-in name. */
  name: string;
  /** A theme's topic names. */
  childNames?: string[];
  /** A block's topic. */
  parentName?: string;
}
export interface MapLevelLabel { name?: string; summary?: string }

/** Groups labeled in one request; themes first, then the biggest topics and blocks. */
export const MAX_LABELED_LEVELS = 150;
const TITLES_PER_GROUP = 6;
const MAX_TITLE_LENGTH = 60;
const MAX_PROMPT_LENGTH = 29_000;
/** A changed group keeps its label while it still shares this much of its membership. */
const KEEP_LABEL_OVERLAP = 0.6;
const DEBOUNCE_MS = 1_800;
const STORAGE_PREFIX = "margin-chat:map-level-labels:v1:";
const MAX_STORED = 600;

interface StoredLabel extends MapLevelLabel { kind: MapLevelKind; fingerprint: string; memberIds: string[] }
const memoryCaches = new Map<string, StoredLabel[]>();
// One request per set of unlabeled groups per session, so a failing provider is not retried on every render.
const attempted = new Set<string>();

/** Test hook: forget what this session has cached and tried. */
export function resetMapLevelLabelsForTests() { memoryCaches.clear(); attempted.clear(); }

function hashIds(ids: string[]) {
  let hash = 2166136261;
  for (const id of [...ids].sort()) { for (let at = 0; at < id.length; at++) { hash ^= id.charCodeAt(at); hash = Math.imul(hash, 16777619); } hash ^= 10; hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(36);
}
export const mapLevelFingerprint = (target: Pick<MapLevelTarget, "kind" | "memberIds">) => `${target.kind}:${target.memberIds.length}:${hashIds(target.memberIds)}`;

function readCache(userId: string): StoredLabel[] {
  const cached = memoryCaches.get(userId);
  if (cached) return cached;
  let stored: StoredLabel[] = [];
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_PREFIX + userId) ?? "[]");
    if (Array.isArray(parsed)) stored = parsed.filter((entry): entry is StoredLabel => !!entry && typeof entry.fingerprint === "string"
      && (entry.kind === "theme" || entry.kind === "topic" || entry.kind === "block")
      && (entry.name === undefined || typeof entry.name === "string") && (entry.summary === undefined || typeof entry.summary === "string")
      && Array.isArray(entry.memberIds) && entry.memberIds.every((id: unknown) => typeof id === "string"));
  } catch { /* Storage can be unavailable; labels are simply asked for again. */ }
  memoryCaches.set(userId, stored);
  return stored;
}

function writeCache(userId: string, labels: StoredLabel[]) {
  const kept = labels.slice(-MAX_STORED);
  memoryCaches.set(userId, kept);
  try { localStorage.setItem(STORAGE_PREFIX + userId, JSON.stringify(kept)); } catch { /* Best effort. */ }
}

function overlap(a: Set<string>, b: string[]) {
  let shared = 0;
  for (const id of b) if (a.has(id)) shared++;
  return shared / (a.size + b.length - shared || 1);
}

/** What each kind of group needs before it counts as labeled. */
const isLabeled = (kind: MapLevelKind, label: MapLevelLabel | undefined) => !!label
  && (kind === "theme" ? !!label.name && !!label.summary : kind === "topic" ? !!label.summary : !!label.name);

/**
 * Labels from earlier passes for today's groups: the same group keeps its label, and a group that
 * changed a little (a note added, one moved) keeps the label of the earlier group it mostly matches.
 */
export function carryMapLevelLabels(targets: MapLevelTarget[], stored: StoredLabel[]) {
  const exact = new Map(stored.map((entry) => [entry.fingerprint, entry]));
  const byKind = { theme: [] as StoredLabel[], topic: [] as StoredLabel[], block: [] as StoredLabel[] };
  for (const entry of stored) byKind[entry.kind].push(entry);
  const labels = new Map<string, MapLevelLabel>();
  for (const target of targets) {
    const known = exact.get(mapLevelFingerprint(target));
    if (known) { labels.set(target.id, { name: known.name, summary: known.summary }); continue; }
    const members = new Set(target.memberIds);
    let best = KEEP_LABEL_OVERLAP, found: StoredLabel | undefined;
    for (const entry of byKind[target.kind]) {
      const score = overlap(members, entry.memberIds);
      if (score >= best) { best = score; found = entry; }
    }
    if (found) labels.set(target.id, { name: found.name, summary: found.summary });
  }
  return labels;
}

/** One line per group: its code, size, and the topic names or note titles that say what it holds. */
export function buildMapLevelsPrompt(targets: MapLevelTarget[], conversations: Record<string, Conversation>) {
  const lines: string[] = [], codes: string[] = [], sent: MapLevelTarget[] = [];
  const counts = { theme: 0, topic: 0, block: 0 };
  const clean = (text: string) => text.trim().replace(/\s+/gu, " ").replace(/[;|]/gu, ",").slice(0, MAX_TITLE_LENGTH);
  let length = 0;
  for (const target of targets) {
    const titles = target.memberIds.slice(0, TITLES_PER_GROUP * 2)
      .map((id) => isHiddenFromAI(conversations[id]) ? undefined : conversations[id]?.title)
      .filter((title): title is string => !!title && !/^untitled/iu.test(title.trim())).slice(0, TITLES_PER_GROUP).map(clean);
    const size = `${target.memberIds.length} ${target.memberIds.length === 1 ? "note" : "notes"}`;
    const code = `${target.kind === "theme" ? "T" : target.kind === "topic" ? "P" : "B"}${counts[target.kind] + 1}`;
    const line = target.kind === "theme" ? `${code} (${size}): Topics: ${(target.childNames ?? []).slice(0, 12).map(clean).join("; ") || clean(target.name)}`
      : target.kind === "topic" ? `${code} (${size}): ${clean(target.name)}: ${titles.join("; ") || "Untitled notes"}`
      : `${code} (${size}) in ${clean(target.parentName ?? "a topic")}: ${titles.join("; ") || "Untitled notes"}`;
    // A block whose titles are all hidden from AI has nothing to name it by.
    if (target.kind === "block" && !titles.length) continue;
    if (length + line.length + 1 > MAX_PROMPT_LENGTH) break;
    counts[target.kind] += 1;
    lines.push(line); codes.push(code); sent.push(target);
    length += line.length + 1;
  }
  return { content: lines.join("\n"), codes, sent };
}

const KIND_ORDER: Record<MapLevelKind, number> = { theme: 0, topic: 1, block: 2 };

export function useMapLevelLabels({ userId, enabled, active, targets, conversations }: {
  userId: string;
  /** The user allows AI assistance (Jev). */
  enabled: boolean;
  /** The Map is on screen with boxes, so a request may be sent. */
  active: boolean;
  targets: MapLevelTarget[];
  conversations: Record<string, Conversation>;
}) {
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const labels = useMemo(() => enabled && userId ? carryMapLevelLabels(targets, readCache(userId)) : new Map<string, MapLevelLabel>(),
    // `revision` re-reads the cache after labels arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [targets, userId, enabled, revision]);
  const missing = useMemo(() => targets.filter((target) => target.memberIds.length >= 2 && !isLabeled(target.kind, labels.get(target.id)))
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.memberIds.length - a.memberIds.length).slice(0, MAX_LABELED_LEVELS), [targets, labels]);
  const missingKey = missing.map(mapLevelFingerprint).join(",");

  useEffect(() => {
    if (!userId || !enabled || !active || !missing.length || attempted.has(`${userId}:${missingKey}`)) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      attempted.add(`${userId}:${missingKey}`);
      setLoading(true);
      try {
        const { content, codes, sent } = buildMapLevelsPrompt(missing, conversations);
        if (!content) return;
        const answers = new Map((await requestMapLevelLabels({ content, expectedUserId: userId, signal: controller.signal })).map((entry) => [entry.code, entry]));
        if (controller.signal.aborted) return;
        const fresh: StoredLabel[] = [];
        codes.forEach((code, at) => {
          const target = sent[at], answer = answers.get(code);
          if (!target || !answer) return;
          const before = labels.get(target.id);
          fresh.push({ kind: target.kind, fingerprint: mapLevelFingerprint(target), memberIds: target.memberIds,
            name: target.kind === "topic" ? undefined : answer.name ?? before?.name, summary: target.kind === "block" ? undefined : answer.summary ?? before?.summary });
        });
        if (!fresh.length) return;
        const replaced = new Set(fresh.map((entry) => entry.fingerprint));
        writeCache(userId, [...readCache(userId).filter((entry) => !replaced.has(entry.fingerprint)), ...fresh]);
        setRevision((value) => value + 1);
      } catch {
        // An aborted pass may retry later; a provider failure leaves the stand-in names.
        if (controller.signal.aborted) attempted.delete(`${userId}:${missingKey}`);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => { clearTimeout(timer); controller.abort(); setLoading(false); };
    // `conversations` and `labels` are read when the pass starts; title edits alone never trigger one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, enabled, active, missingKey]);

  return { labels, loading };
}
