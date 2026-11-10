import { sameVaultFile, type VaultFile, type VaultSnapshot } from "./vaultTypes";

/**
 * Automatic versions: while a document is being edited, the text it had before the edit is kept in
 * `.margin-chat/history/<id>/` at most once every ten minutes, so Version history can bring back
 * what was written earlier, not only what two devices disagreed about. Old automatic versions are
 * thinned out (every one from the last day, then one a day for a month); clash and restore records
 * are never removed here.
 */
export const SNAPSHOT_INTERVAL_MS = 10 * 60_000;
const KEEP_ALL_MS = 24 * 60 * 60_000;
const KEEP_DAILY_MS = 30 * 24 * 60 * 60_000;
const MAX_PER_DOCUMENT = 120;
const MAX_SNAPSHOT_SIZE = 1_000_000;
const DESCRIPTOR = /^(\.margin-chat\/history\/([^/]+)\/)conflict\.json$/;

type SnapshotRecord = { id: string; prefix: string; at: number; path: string };

function isDocument(path: string) {
  return /\.md$/iu.test(path) && !/^(?:attachments|_conflicts|\.margin-chat)\//iu.test(path);
}

function snapshotRecords(files: Record<string, VaultFile>): SnapshotRecord[] {
  const records: SnapshotRecord[] = [];
  for (const [path, file] of Object.entries(files)) {
    const match = DESCRIPTOR.exec(path);
    // Only automatic versions are read; the descriptor says so before any parsing is needed.
    if (!match || file.encoding || !file.content.includes('"snapshot"')) continue;
    try {
      const descriptor = JSON.parse(file.content) as Record<string, unknown>;
      const at = typeof descriptor.createdAt === "string" ? Date.parse(descriptor.createdAt) : NaN;
      if (descriptor.reason !== "snapshot" || typeof descriptor.path !== "string" || !Number.isFinite(at)) continue;
      records.push({ id: match[2], prefix: match[1], at, path: descriptor.path });
    } catch { /* Not a readable descriptor: leave it alone. */ }
  }
  return records;
}

/** When each document last had an automatic version, by path. */
export function latestSnapshotTimes(files: Record<string, VaultFile>): Map<string, number> {
  const latest = new Map<string, number>();
  for (const record of snapshotRecords(files)) latest.set(record.path, Math.max(latest.get(record.path) ?? 0, record.at));
  return latest;
}

function writeSnapshot(snapshot: VaultSnapshot, path: string, file: VaultFile, now: number) {
  const id = crypto.randomUUID();
  const prefix = `.margin-chat/history/${id}/`;
  const copy = `${prefix}local/${path.split("/").pop()}`;
  const createdAt = new Date(now).toISOString();
  snapshot.files[copy] = { ...file };
  snapshot.files[`${prefix}conflict.json`] = {
    content: JSON.stringify({ path, createdAt, reason: "snapshot", automatic: true, conflicted: false,
      localDeleted: false, remoteDeleted: true, copy, remoteCopy: null, localEncoding: "utf8", remoteEncoding: "utf8",
      baseKnown: false, baseCopy: null, baseEncoding: "utf8", resultCopy: null, resultDeleted: true, resultEncoding: "utf8" }, null, 2),
    contentType: "application/json",
  };
}

/** Thin out one document's automatic versions: all from the last day, then the newest of each day for a month. */
function prune(snapshot: VaultSnapshot, path: string, now: number) {
  const records = snapshotRecords(snapshot.files).filter((record) => record.path === path).sort((a, b) => b.at - a.at);
  const days = new Set<string>();
  const removed = records.filter((record, index) => {
    if (index >= MAX_PER_DOCUMENT) return true;
    const age = now - record.at;
    if (age <= KEEP_ALL_MS) return false;
    if (age > KEEP_DAILY_MS) return true;
    const day = new Date(record.at).toISOString().slice(0, 10);
    if (days.has(day)) return true;
    days.add(day);
    return false;
  });
  if (!removed.length) return;
  const prefixes = removed.map((record) => record.prefix);
  for (const file of Object.keys(snapshot.files)) if (prefixes.some((prefix) => file.startsWith(prefix))) delete snapshot.files[file];
}

/**
 * Keeps the text a document had in `before` as an automatic version when it changed in `snapshot`
 * and its last automatic version is older than the interval. `latest` is updated in place.
 * Returns the paths that got a version.
 */
export function keepEditSnapshots(snapshot: VaultSnapshot, before: Record<string, VaultFile>, latest: Map<string, number>, now = Date.now()) {
  const kept: string[] = [];
  for (const [path, previous] of Object.entries(before)) {
    const current = snapshot.files[path];
    if (!current || !isDocument(path) || previous.encoding || sameVaultFile(previous, current)) continue;
    // An empty new document has nothing worth bringing back.
    if (!previous.content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, "").replace(/^#[^\n]*\n?/u, "").trim()
      || previous.content.length > MAX_SNAPSHOT_SIZE) continue;
    if (now - (latest.get(path) ?? 0) < SNAPSHOT_INTERVAL_MS) continue;
    writeSnapshot(snapshot, path, previous, now);
    latest.set(path, now);
    prune(snapshot, path, now);
    kept.push(path);
  }
  return kept;
}
