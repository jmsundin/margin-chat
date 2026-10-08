import type { VaultFile } from "./vaultTypes";

/** Documents not opened here or edited anywhere for this long go back to the cloud. */
export const WORKING_SET_IDLE_MS = 90 * 24 * 60 * 60 * 1000;
/** How often a device looks for documents to return. */
export const WORKING_SET_CHECK_MS = 24 * 60 * 60 * 1000;

const openedKey = (userId: string) => `margin-chat:vault-opened:${userId}`;
const checkedKey = (userId: string) => `margin-chat:vault-working-set-checked:${userId}`;

/** When each document was last opened on this device, by id. */
export function loadOpenedDocuments(userId: string): Map<string, number> {
  try {
    const stored = JSON.parse(localStorage.getItem(openedKey(userId)) ?? "{}");
    return new Map(Object.entries(stored && typeof stored === "object" ? stored : {})
      .filter((entry): entry is [string, number] => Number.isFinite(entry[1])));
  } catch {
    return new Map();
  }
}

export function recordOpenedDocuments(userId: string, ids: Iterable<string>, now = Date.now()) {
  try {
    const opened = loadOpenedDocuments(userId);
    for (const id of ids) opened.set(id, now);
    // Older records no longer protect anything, so the list stays small.
    for (const [key, at] of opened) if (now - at > WORKING_SET_IDLE_MS) opened.delete(key);
    localStorage.setItem(openedKey(userId), JSON.stringify(Object.fromEntries(opened)));
  } catch { /* Without storage, eviction falls back to edit dates. */ }
}

/** Whether a day has passed since this device last looked, recording this look. */
export function claimWorkingSetCheck(userId: string, now = Date.now()) {
  try {
    const last = Number(localStorage.getItem(checkedKey(userId)) ?? 0);
    if (Number.isFinite(last) && now - last < WORKING_SET_CHECK_MS && last <= now) return false;
    localStorage.setItem(checkedKey(userId), String(now));
    return true;
  } catch {
    // Without storage there is no record of what was opened; keep everything.
    return false;
  }
}

/** Documents the workspace shows without being opened: pins and docked panes.
 * Null when the sidecar cannot be read, so nothing is assumed safe to return. */
export function workspaceReferenceIds(sidecar: VaultFile | undefined): Set<string> | null {
  const ids = new Set<string>();
  if (!sidecar) return ids;
  if (sidecar.encoding) return null;
  try {
    const view = JSON.parse(sidecar.content)?.workspace?.view;
    for (const id of Array.isArray(view?.pinnedItemIds) ? view.pinnedItemIds : []) if (typeof id === "string") ids.add(id);
    for (const id of [view?.activeItemId, view?.activeRootId]) if (typeof id === "string" && id) ids.add(id);
    const panes = view?.documentDock?.tree ? [view.documentDock.tree] : [];
    while (panes.length) {
      const pane = panes.pop();
      if (pane?.type === "pane" && typeof pane.documentId === "string") ids.add(pane.documentId);
      else if (pane?.type === "split") panes.push(pane.first, pane.second);
    }
  } catch {
    return null;
  }
  return ids;
}
