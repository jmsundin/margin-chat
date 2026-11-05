import type { DesktopSyncStatus } from "./vaultFsDesktop";

/** The quiet sync indicator's words for the desktop app's own sync (docs/desktop-vault-sync.md, phase 3). */
export function desktopSyncLabel(status: Pick<DesktopSyncStatus, "state" | "lastSyncedAt">, locale?: string) {
  switch (status.state) {
    case "synced": {
      if (!status.lastSyncedAt) return "Synced";
      const time = new Date(status.lastSyncedAt).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
      return `Synced · ${time}`;
    }
    case "offline": return "Offline — changes saved locally";
    case "paused": return "Paused";
    case "attention": return "Needs attention";
    default: return "Syncing…";
  }
}

/** One line for Vault settings → Sync: what is waiting, and when the folder and the cloud last matched. */
export function desktopSyncDetail(status: DesktopSyncStatus, locale?: string) {
  const parts: string[] = [];
  if (status.pending) parts.push(`${status.pending.toLocaleString(locale)} ${status.pending === 1 ? "change" : "changes"} waiting to sync`);
  if (status.lastSyncedAt) {
    parts.push(`Last synced ${new Date(status.lastSyncedAt).toLocaleString(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`);
  } else parts.push("Not synced yet");
  return parts.join(" · ");
}
