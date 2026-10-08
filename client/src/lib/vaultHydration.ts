import type { VaultFile, VaultIndexEntry } from "./vaultTypes";

/** Paths that must arrive together so a downloaded document parses with every
 * relationship it renders: its whole family tree (branches and margin notes)
 * and, transitively, the families of documents it links to. */
export function vaultHydrationClosure(index: VaultIndexEntry[], paths: Iterable<string>): Set<string> {
  const byPath = new Map(index.map((entry) => [entry.path, entry]));
  const rootOf = (path: string) => {
    const seen = new Set<string>();
    let current = path;
    while (!seen.has(current)) {
      seen.add(current);
      const parent = byPath.get(current)?.parentPath;
      if (!parent || !byPath.has(parent)) break;
      current = parent;
    }
    return current;
  };
  const members = new Map<string, string[]>();
  for (const entry of index) {
    const root = rootOf(entry.path);
    members.set(root, [...members.get(root) ?? [], entry.path]);
  }
  const result = new Set<string>();
  const visitedRoots = new Set<string>();
  const queue = [...paths].map(rootOf);
  while (queue.length) {
    const root = queue.pop()!;
    if (visitedRoots.has(root)) continue;
    visitedRoots.add(root);
    for (const path of members.get(root) ?? [root]) {
      result.add(path);
      for (const linked of byPath.get(path)?.linkedPaths ?? []) if (byPath.has(linked)) queue.push(rootOf(linked));
    }
  }
  return result;
}

/**
 * Documents to return to the cloud: those whose families were not opened on
 * this device or edited anywhere within `idleMs`. Everything a remaining
 * document needs (its family and linked families) stays, so nothing left on
 * the device loses a relationship and nothing is fetched straight back.
 */
export function planVaultEviction(index: VaultIndexEntry[], localPaths: Iterable<string>, { opened, protectedIds, now, idleMs }: {
  opened: ReadonlyMap<string, number>; protectedIds: ReadonlySet<string>; now: number; idleMs: number;
}): string[] {
  const local = new Set(localPaths);
  const kept = index.filter((entry) => local.has(entry.path)).filter((entry) => {
    if (protectedIds.has(entry.id)) return true;
    const edited = Date.parse(entry.updated ?? entry.created ?? "");
    const used = Math.max(opened.get(entry.id) ?? 0, Number.isFinite(edited) ? edited : now);
    return now - used < idleMs;
  });
  const keep = vaultHydrationClosure(index, kept.map((entry) => entry.path));
  return index.filter((entry) => local.has(entry.path) && !keep.has(entry.path)).map((entry) => entry.path);
}

/** Documents most recently created or edited, newest first. */
export function recentVaultEntries(index: VaultIndexEntry[], limit = Infinity): VaultIndexEntry[] {
  return index.filter((entry) => entry.type === "conversation")
    .sort((left, right) => (right.updated ?? right.created ?? "").localeCompare(left.updated ?? left.created ?? "")
      || left.title.localeCompare(right.title))
    .slice(0, limit);
}

/** Matches every whitespace-separated term against a title, ignoring case and accents. */
export function searchVaultIndex(entries: VaultIndexEntry[], query: string): VaultIndexEntry[] {
  const fold = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();
  const terms = fold(query).split(/\s+/u).filter(Boolean);
  if (!terms.length) return entries;
  return entries.filter((entry) => {
    const haystack = fold(`${entry.title} ${entry.path}`);
    return terms.every((term) => haystack.includes(term));
  });
}

type WorkspaceSidecar = { workspace?: { view?: Record<string, unknown> } };

/** The editor only knows downloaded documents, so its rendering of workspace.json
 * leaves out pins, groups and layouts that belong to documents still in the
 * cloud. Put those references back so a partial device never deletes them. */
export function preserveDeferredWorkspaceReferences(rendered: VaultFile, stored: VaultFile | undefined, deferredIds: Set<string>): VaultFile {
  if (!stored || !deferredIds.size || rendered.encoding || stored.encoding) return rendered;
  let next: WorkspaceSidecar;
  let previous: WorkspaceSidecar;
  try { next = JSON.parse(rendered.content); previous = JSON.parse(stored.content); } catch { return rendered; }
  const view = next.workspace?.view;
  const before = previous.workspace?.view;
  if (!view || !before) return rendered;
  const deferred = (id: unknown): id is string => typeof id === "string" && deferredIds.has(id);
  let changed = false;

  if (Array.isArray(before.pinnedItemIds)) {
    const pinned = Array.isArray(view.pinnedItemIds) ? view.pinnedItemIds : [];
    const restored = restoreHidden(before.pinnedItemIds, pinned, deferred);
    if (restored) changed = true;
    view.pinnedItemIds = restored ?? pinned;
  }

  const beforeGroups = isRecord(before.groups) ? before.groups : {};
  const groups = isRecord(view.groups) ? { ...view.groups } : {};
  for (const [groupId, group] of Object.entries(beforeGroups)) {
    if (!isRecord(group) || !Array.isArray(group.conversationIds)) continue;
    const hidden = group.conversationIds.filter(deferred);
    if (!hidden.length) continue;
    const current = groups[groupId];
    // A group that still lists only cloud documents cannot have been deleted here.
    if (!isRecord(current)) {
      if (group.conversationIds.every(deferred)) { groups[groupId] = group; changed = true; }
      continue;
    }
    const ids = Array.isArray(current.conversationIds) ? current.conversationIds : [];
    const restored = restoreHidden(group.conversationIds, ids, deferred);
    if (restored) changed = true;
    groups[groupId] = { ...current, conversationIds: restored ?? ids };
  }
  view.groups = groups;

  if (isRecord(before.graphLayouts)) {
    const layouts = isRecord(view.graphLayouts) ? { ...view.graphLayouts } : {};
    for (const [id, layout] of Object.entries(before.graphLayouts)) {
      if (deferred(id) && !(id in layouts)) { layouts[id] = layout; changed = true; }
    }
    view.graphLayouts = layouts;
  }

  if (!changed) return rendered;
  return { ...rendered, content: JSON.stringify(next, null, 2) };
}

/** Put each hidden id back after the id it followed before, so other devices
 * see the same order. Null when nothing was missing. */
function restoreHidden(before: unknown[], current: unknown[], hidden: (id: unknown) => id is string): unknown[] | null {
  const listed = new Set(current);
  const START = Symbol("start");
  const after = new Map<unknown, string[]>();
  let anchor: unknown = START;
  for (const id of before) {
    if (listed.has(id)) anchor = id;
    else if (hidden(id)) {
      listed.add(id);
      after.set(anchor, [...after.get(anchor) ?? [], id]);
    }
  }
  if (!after.size) return null;
  return [...after.get(START) ?? [], ...current.flatMap((id) => [id, ...after.get(id) ?? []])];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
