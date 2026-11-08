import type { VaultFile } from "./vaultTypes";

/**
 * A rescue copy of edits this tab had not finished saving to the device's vault.
 *
 * Saving the vault on this device is asynchronous (OPFS), so when a tab is reloaded, closed or
 * killed in the background right after a key press, that last save can be cut off. Just before the
 * page goes away it writes the changed files here synchronously; the next time the vault opens,
 * they are merged back in the same way a save would have merged them.
 */
export interface UnsavedEdits {
  savedAt: number;
  /** The changed files as the tab last showed them. A path missing here but present in `expected` was deleted. */
  next: Record<string, VaultFile>;
  /** The same paths as they were in the vault this tab last saved, so the edit merges three ways. */
  expected: Record<string, VaultFile>;
}

const PREFIX = "margin-chat:unsaved-edits:";
const keyPrefix = (userId: string) => `${PREFIX}${encodeURIComponent(userId)}:`;

/** One id per page load, so two tabs never overwrite each other's rescue copy. */
export function createTabId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** The files that differ between what this tab shows and what it last saved. Null when nothing does. */
export function diffUnsavedEdits(next: Record<string, VaultFile>, saved: Record<string, VaultFile>, now = Date.now()): UnsavedEdits | null {
  const edits: UnsavedEdits = { savedAt: now, next: {}, expected: {} };
  let changed = false;
  for (const path of new Set([...Object.keys(next), ...Object.keys(saved)])) {
    const after = next[path];
    const before = saved[path];
    if (after === before) continue;
    if (after && before && after.content === before.content && after.encoding === before.encoding) continue;
    changed = true;
    if (after) edits.next[path] = after;
    if (before) edits.expected[path] = before;
  }
  return changed ? edits : null;
}

/** Synchronous, so it finishes inside pagehide. Returns false when the browser refused the write. */
export function writeUnsavedEdits(userId: string, tabId: string, edits: UnsavedEdits): boolean {
  try {
    window.localStorage.setItem(`${keyPrefix(userId)}${tabId}`, JSON.stringify(edits));
    return true;
  } catch {
    // Full or blocked storage: the asynchronous save started at the same moment is the only copy.
    return false;
  }
}

export function clearUnsavedEdits(userId: string, tabId: string): void {
  try { window.localStorage.removeItem(`${keyPrefix(userId)}${tabId}`); } catch { /* nothing to clear */ }
}

function validFiles(value: unknown): value is Record<string, VaultFile> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((file) => Boolean(file) && typeof file === "object"
      && typeof (file as VaultFile).content === "string");
}

/** Rescue copies left by tabs of this account, oldest first, with the key each is stored under. */
export function readUnsavedEdits(userId: string): { key: string; edits: UnsavedEdits }[] {
  const found: { key: string; edits: UnsavedEdits }[] = [];
  try {
    const prefix = keyPrefix(userId);
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      try {
        const parsed = JSON.parse(window.localStorage.getItem(key) ?? "null") as Partial<UnsavedEdits> | null;
        if (parsed && typeof parsed.savedAt === "number" && validFiles(parsed.next) && validFiles(parsed.expected)) {
          found.push({ key, edits: parsed as UnsavedEdits });
        }
      } catch { /* A damaged copy is skipped and left in place for inspection. */ }
    }
  } catch {
    return [];
  }
  return found.sort((a, b) => a.edits.savedAt - b.edits.savedAt);
}

export function removeUnsavedEditsKey(key: string): void {
  try { window.localStorage.removeItem(key); } catch { /* nothing to remove */ }
}
