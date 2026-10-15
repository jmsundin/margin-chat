import type { VaultFile } from "./vaultTypes";

const DAY_MS = 24 * 60 * 60 * 1000;
/** A vault first seen with documents is left alone this long before the first reminder. */
export const BACKUP_GRACE_MS = DAY_MS;
/** A downloaded copy counts as current this long, and "Later" hides the reminder this long. */
export const BACKUP_REMIND_MS = 7 * DAY_MS;

const recordKey = (userId: string) => `margin-chat:vault-backup:${userId}`;

/** What this browser knows about copies of its vault kept outside the browser. */
export interface VaultBackupRecord {
  /** When the vault was last downloaded from this browser. */
  downloadedAt?: number;
  /** The vault's documents at that download, from vaultFingerprint. */
  fingerprint?: string;
  /** When this browser first held documents with no copy elsewhere. */
  since?: number;
  /** "Later" was chosen; no reminder until then. */
  snoozedUntil?: number;
}

export interface OnlyCopyReminder {
  /** The last download from this browser, or null when there has never been one. */
  downloadedAt: number | null;
}

export function loadVaultBackup(userId: string): VaultBackupRecord {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(recordKey(userId)) ?? "{}");
    if (!stored || typeof stored !== "object") return {};
    const record: VaultBackupRecord = {};
    for (const key of ["downloadedAt", "since", "snoozedUntil"] as const) {
      const value = (stored as Record<string, unknown>)[key];
      if (typeof value === "number" && Number.isFinite(value)) record[key] = value;
    }
    const fingerprint = (stored as Record<string, unknown>).fingerprint;
    if (typeof fingerprint === "string") record.fingerprint = fingerprint;
    return record;
  } catch {
    return {};
  }
}

export function saveVaultBackup(userId: string, record: VaultBackupRecord) {
  try { localStorage.setItem(recordKey(userId), JSON.stringify(record)); }
  catch { /* Without storage the reminder can't remember a download and shows again. */ }
}

/**
 * A short digest of the vault's documents, to tell whether anything changed since a
 * download. Settings and Margin Chat's own folder are left out, and a PDF or image
 * counts by its size so large files are never read in full.
 */
export function vaultFingerprint(files: Record<string, VaultFile>) {
  let hash = 0x811c9dc5;
  let count = 0;
  const mix = (text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    // A zero after each string keeps "ab" + "c" apart from "a" + "bc".
    hash = Math.imul(hash, 0x01000193);
  };
  for (const path of Object.keys(files).sort()) {
    if (path === "workspace.json" || path.startsWith(".margin-chat/")) continue;
    const file = files[path];
    count += 1;
    mix(path);
    mix(file.encoding ? `${file.encoding}:${file.content.length}` : file.content);
  }
  return `${count}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * Whether to warn that this browser holds the only copy of the vault: there is no cloud
 * sync and no connected folder, and the vault has documents that were never downloaded,
 * or changed since a download at least a week old. Returns the record to save, which
 * notes when documents were first seen so a new vault isn't warned about right away.
 */
export function onlyCopyReminder(input: {
  cloudSync: boolean;
  folderChosen: boolean;
  hasDocuments: boolean;
  record: VaultBackupRecord;
  /** Read only when a week-old download has to be compared with the vault. */
  files: () => Record<string, VaultFile>;
  now?: number;
}): { reminder: OnlyCopyReminder | null; record: VaultBackupRecord } {
  const { record, now = Date.now() } = input;
  if (input.cloudSync || input.folderChosen || !input.hasDocuments) return { reminder: null, record };
  // A clock set back must not hide the reminder for good.
  const since = record.since !== undefined && record.since <= now ? record.since : undefined;
  const next = since === undefined ? { ...record, since: now } : record;
  if (record.snoozedUntil !== undefined && now < record.snoozedUntil && record.snoozedUntil - now <= BACKUP_REMIND_MS) {
    return { reminder: null, record: next };
  }
  const downloadedAt = record.downloadedAt !== undefined && record.downloadedAt <= now ? record.downloadedAt : null;
  if (downloadedAt === null) {
    return { reminder: since !== undefined && now - since >= BACKUP_GRACE_MS ? { downloadedAt: null } : null, record: next };
  }
  if (now - downloadedAt < BACKUP_REMIND_MS || record.fingerprint === vaultFingerprint(input.files())) return { reminder: null, record: next };
  return { reminder: { downloadedAt }, record: next };
}
