import { useState } from "react";
import type { OnlyCopyReminder } from "../lib/vaultBackupReminder";
import "./NotificationToast.css";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The heading for a vault whose only copy is in this browser. */
export function describeOnlyCopy(reminder: OnlyCopyReminder, now = Date.now()) {
  if (reminder.downloadedAt === null) return "Your vault is only saved in this browser";
  const days = Math.max(1, Math.floor((now - reminder.downloadedAt) / DAY_MS));
  return `Your downloaded copy is ${days} ${days === 1 ? "day" : "days"} old`;
}

/**
 * Stays up until the user downloads the vault, chooses a folder or picks "Later": without
 * cloud sync or a folder, clearing this site's data would delete every document.
 */
export default function OnlyCopyPrompt({ reminder, folderSupported, onDownload, onChooseFolder, onLater }: {
  reminder: OnlyCopyReminder | null;
  folderSupported: boolean;
  onDownload: () => Promise<void>;
  onChooseFolder: () => Promise<void>;
  onLater: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!reminder) return null;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "That didn't work. Try again."); }
    finally { setBusy(false); }
  }

  return (
    <div className="notification-toast is-error only-copy-prompt" role="alertdialog" aria-labelledby="only-copy-title" aria-describedby="only-copy-detail">
      <span className="notification-toast-symbol" aria-hidden="true">!</span>
      <div className="notification-toast-content">
        <p id="only-copy-title"><strong>{describeOnlyCopy(reminder)}</strong></p>
        <p id="only-copy-detail">
          {reminder.downloadedAt === null
            ? "There is no other copy. If this browser's site data is cleared, your documents are gone."
            : "Changes since then are only saved in this browser. If its site data is cleared, they are gone."}
          {folderSupported ? " Download a copy, or choose a folder that Margin Chat keeps up to date." : " Download a copy to keep one."}
        </p>
        {error ? <p role="alert">{error}</p> : null}
        <div className="folder-deletion-actions">
          <button type="button" className="notification-toast-action" disabled={busy} onClick={() => void run(onDownload)}>
            Download a copy
          </button>
          {folderSupported ? (
            <button type="button" className="notification-toast-action" disabled={busy} onClick={() => void run(onChooseFolder)}>
              Choose a folder
            </button>
          ) : null}
          <button type="button" className="notification-toast-action is-quiet" disabled={busy} onClick={onLater}>
            Later
          </button>
        </div>
      </div>
    </div>
  );
}
