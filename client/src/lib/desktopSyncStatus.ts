import type { BridgeSyncStatus } from "@margin-chat/vault-sync/bridgeProtocol";

export type SyncTone = "ok" | "busy" | "muted" | "attention";

/**
 * One quiet line for the desktop app's sync indicator (spec §6):
 * "Synced · 2 minutes ago", "Syncing…", "Offline — changes saved locally",
 * "Paused", or "Needs attention". Attention is raised only for a held
 * deletion, a missing folder, an expired session or repeated failures.
 */
export function describeDesktopSync(status: BridgeSyncStatus, now = Date.now()): { label: string; detail: string; tone: SyncTone } {
  switch (status.state) {
    case "attention":
      return { label: "Needs attention", detail: status.attention?.message ?? "Sync needs your attention.", tone: "attention" };
    case "paused":
      return { label: "Paused", detail: "Sync is paused. Edits save on this computer and sync when you resume.", tone: "muted" };
    case "offline":
      return { label: "Offline — changes saved locally", detail: `${pendingLabel(status.pending)} will sync when you’re back online.`, tone: "muted" };
    case "syncing":
      return { label: "Syncing…", detail: pendingLabel(status.pending), tone: "busy" };
    case "local":
      return { label: "Saved in this folder", detail: "Cloud sync requires a paid plan or admin access. Your vault folder is kept up to date either way.", tone: "muted" };
    case "synced":
    default:
      return {
        label: status.lastSyncedAt ? `Synced · ${relativeTime(status.lastSyncedAt, now)}` : "Synced",
        detail: status.pending ? pendingLabel(status.pending) : "Everything is in the cloud and in your folder.",
        tone: "ok",
      };
  }
}

function pendingLabel(pending: number) {
  return pending === 0 ? "Nothing waiting to sync." : pending === 1 ? "1 change waiting to sync" : `${pending.toLocaleString("en-US")} changes waiting to sync`;
}

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago". */
export function relativeTime(then: number, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - then) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}
