import { useState } from "react";
import { formatRelativeTime } from "../lib/conversationSearch";
import { TRASH_DAYS, type TrashEntry } from "../lib/vaultTrash";

const SHOWN = 8;

export function describeTrashEntry(entry: TrashEntry) {
  const [first, ...rest] = entry.files;
  return rest.length ? `${first.title} and ${rest.length} more` : first.title;
}

/** Documents deleted in the app or in a connected folder, each with a Restore button. */
export default function RecentlyDeleted({ entries, onRestore }: {
  entries: TrashEntry[];
  onRestore: (key: string) => Promise<unknown>;
}) {
  const [restoring, setRestoring] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restored, setRestored] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? entries : entries.slice(0, SHOWN);

  async function restore(entry: TrashEntry) {
    setRestoring(entry.key); setError(null); setRestored(null);
    try {
      await onRestore(entry.key);
      setRestored(`Restored “${describeTrashEntry(entry)}”.`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "That document could not be restored.");
    } finally {
      setRestoring(null);
    }
  }

  return (
    <div className="profile-storage-directory-card recently-deleted">
      <div><span>Recently deleted</span>
        <strong>{entries.length ? `${entries.length} deleted in the last ${TRASH_DAYS} days` : "Nothing deleted recently"}</strong>
        <small>Documents you delete, here or in a connected folder, are kept for {TRASH_DAYS} days so you can put them back. They sync to your other devices like any file.</small></div>
      {shown.length ? (
        <ul className="recently-deleted-list">
          {shown.map((entry) => (
            <li key={entry.key}>
              <div className="recently-deleted-name">
                <strong title={entry.files.map((file) => file.path).join("\n")}>{describeTrashEntry(entry)}</strong>
                <small>Deleted {formatRelativeTime(entry.deletedAt)}</small>
              </div>
              <button type="button" className="thread-dialog-button" disabled={restoring !== null} onClick={() => void restore(entry)}>
                {restoring === entry.key ? "Restoring…" : "Restore"}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {entries.length > SHOWN ? (
        <button type="button" className="thread-dialog-button recently-deleted-more" onClick={() => setShowAll((value) => !value)}>
          {showAll ? "Show fewer" : `Show all ${entries.length}`}
        </button>
      ) : null}
      {restored ? <p className="thread-dialog-copy" role="status">{restored}</p> : null}
      {error ? <p className="profile-dialog-error" role="alert">{error}</p> : null}
    </div>
  );
}
