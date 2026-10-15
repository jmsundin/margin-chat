import { useState } from "react";
import { describeHeldFiles, type HeldFolderDeletion } from "../lib/folderDeletionGuard";
import "./NotificationToast.css";

/**
 * Stays up until the user answers: a folder scan that would delete many documents is
 * held, and nothing is deleted from the vault, the cloud or other devices until then.
 */
export default function FolderDeletionPrompt({ held, onResolve }: {
  held: HeldFolderDeletion | null;
  onResolve: (choice: "restore" | "delete") => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!held) return null;
  const count = held.paths.length;

  async function answer(choice: "restore" | "delete") {
    setBusy(true);
    setError(null);
    try { await onResolve(choice); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "That didn't work. Try again."); }
    finally { setBusy(false); }
  }

  return (
    <div className="notification-toast is-error folder-deletion-prompt" role="alertdialog" aria-labelledby="folder-deletion-title" aria-describedby="folder-deletion-detail">
      <span className="notification-toast-symbol" aria-hidden="true">!</span>
      <div className="notification-toast-content">
        <p id="folder-deletion-title"><strong>{count} files are missing from “{held.folderName}”</strong></p>
        <p id="folder-deletion-detail">
          {describeHeldFiles(held.paths)} were moved or deleted outside Margin Chat. Nothing has been deleted yet:
          your vault and the cloud still have them.
        </p>
        {error ? <p role="alert">{error}</p> : null}
        <div className="folder-deletion-actions">
          <button type="button" className="notification-toast-action" disabled={busy} onClick={() => void answer("restore")}>
            Put them back in the folder
          </button>
          <button type="button" className="notification-toast-action is-danger" disabled={busy} onClick={() => void answer("delete")}>
            Delete them everywhere
          </button>
        </div>
      </div>
    </div>
  );
}
