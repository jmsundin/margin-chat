import type { ThreadSummary } from "../types";

/** How the sidebar lists documents, like the sort menu in Obsidian's file list. */
export type SidebarDocumentSort = "recent" | "alphabetical" | "semantic" | "category";

export const SIDEBAR_DOCUMENT_SORTS: ReadonlyArray<{ id: SidebarDocumentSort; label: string; hint: string }> = [
  { id: "recent", label: "Recently viewed", hint: "Last opened or added first" },
  { id: "alphabetical", label: "A to Z", hint: "By title" },
  { id: "semantic", label: "Similar to this document", hint: "Closest in meaning to the open document first" },
  { id: "category", label: "By category", hint: "Grouped by subject, as in Clusters" },
];

const sortKey = (userId: string) => `margin-chat:sidebar-document-sort:${userId}`;

export function loadSidebarDocumentSort(userId: string): SidebarDocumentSort {
  try {
    const stored = localStorage.getItem(sortKey(userId));
    if (SIDEBAR_DOCUMENT_SORTS.some((sort) => sort.id === stored)) return stored as SidebarDocumentSort;
  } catch { /* Storage can be unavailable; the default applies. */ }
  return "recent";
}

export function saveSidebarDocumentSort(userId: string, sort: SidebarDocumentSort) {
  try { localStorage.setItem(sortKey(userId), sort); } catch { /* Best effort. */ }
}

function time(value: string | undefined) {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Most recently opened on this device first. A document added since (a new
 * file in the vault folder, say) counts from when it was made, so it starts
 * at the top even before it is opened.
 */
export function sortByRecentlyViewed(threads: ThreadSummary[], openedAt: ReadonlyMap<string, number>) {
  const recency = new Map(threads.map((thread) => [thread.id,
    Math.max(openedAt.get(thread.id) ?? 0, time(thread.createdAt ?? thread.updatedAt))]));
  return [...threads].sort((a, b) => recency.get(b.id)! - recency.get(a.id)! || time(b.updatedAt) - time(a.updatedAt)
    || (a.id < b.id ? -1 : 1));
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function sortAlphabetically(threads: ThreadSummary[]) {
  const title = (thread: ThreadSummary) => thread.title.trim() || "Untitled document";
  return [...threads].sort((a, b) => collator.compare(title(a), title(b)) || (a.id < b.id ? -1 : 1));
}

function cosine(a: Float32Array, b: Float32Array) {
  if (a.length !== b.length) return -Infinity;
  let total = 0;
  for (let index = 0; index < a.length; index++) total += a[index] * b[index];
  return total;
}

/**
 * The open document first, then the others by how close they are in meaning
 * (embeddings are unit length, so the dot product is the cosine). Documents
 * without an embedding yet follow in `fallback` order.
 */
export function sortBySimilarity(threads: ThreadSummary[], activeId: string,
  vectorOf: (id: string) => Float32Array | undefined, fallback: ThreadSummary[]) {
  const anchor = vectorOf(activeId);
  if (!anchor) return fallback;
  const position = new Map(fallback.map((thread, index) => [thread.id, index]));
  const score = new Map<string, number>();
  for (const thread of threads) {
    const vector = thread.id === activeId ? undefined : vectorOf(thread.id);
    if (vector) score.set(thread.id, cosine(anchor, vector));
  }
  const rank = (thread: ThreadSummary) => thread.id === activeId ? Infinity : score.get(thread.id) ?? -Infinity;
  return [...threads].sort((a, b) => rank(b) - rank(a) || (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));
}

export interface SidebarDocumentCategory {
  id: string;
  label: string;
  /** Documents in this category, in the order the sidebar lists them. */
  threads: ThreadSummary[];
}

/**
 * Sidebar sections from subject clusters: each cluster's documents in
 * `ordered` order, largest category first, unfiled documents last.
 */
export function groupIntoCategories(ordered: ThreadSummary[],
  clusters: ReadonlyArray<{ id: string; hubId: string | null; memberIds: string[] }>,
  labelOf: (clusterId: string) => string): SidebarDocumentCategory[] {
  const clusterOf = new Map<string, string>();
  for (const cluster of clusters) if (cluster.hubId !== null) for (const id of cluster.memberIds) clusterOf.set(id, cluster.id);
  const members = new Map<string, ThreadSummary[]>();
  const unfiled: ThreadSummary[] = [];
  for (const thread of ordered) {
    const clusterId = clusterOf.get(thread.id);
    if (!clusterId) { unfiled.push(thread); continue; }
    const list = members.get(clusterId);
    if (list) list.push(thread); else members.set(clusterId, [thread]);
  }
  const categories = [...members].map(([id, threads]) => ({ id, label: labelOf(id), threads }))
    .sort((a, b) => b.threads.length - a.threads.length || collator.compare(a.label, b.label));
  if (unfiled.length) categories.push({ id: "unfiled", label: "Unfiled", threads: unfiled });
  return categories;
}
