import { useRef, useState, type FormEvent } from "react";

/** The word typed to confirm; the server checks the same word. */
const CONFIRMATION = "DELETE";

interface AccountDeletionFormProps {
  disabled?: boolean;
  /** The account syncs a cloud vault, which is deleted with it. */
  cloudVault: boolean;
  onDeleteAccount: (args: { password: string; confirmation: string }) => Promise<void>;
}

export default function AccountDeletionForm({ disabled = false, cloudVault, onDeleteAccount }: AccountDeletionFormProps) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const ready = !!password && confirmation === CONFIRMATION;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || submittingRef.current || !ready) return;
    setError(null);
    submittingRef.current = true;
    setIsSubmitting(true);
    try {
      // On success the app signs out, so this form is gone.
      await onDeleteAccount({ password, confirmation });
    } catch (failure) {
      setError(failure instanceof Error && failure.message ? failure.message : "Unable to delete your account.");
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  }

  return (
    <section className="profile-password-section profile-delete-section" aria-labelledby="profile-delete-heading">
      <div>
        <p className="eyebrow">Leave Margin Chat</p>
        <h3 id="profile-delete-heading">Delete account</h3>
      </div>
      <p className="thread-dialog-copy" id="profile-delete-help">
        This deletes your account and everything Margin Chat stores for it: {cloudVault ? "your cloud vault, " : ""}chats,
        AI credit, API keys and connected app tokens. Your plan is cancelled straight away, without a refund for the rest of
        the month. It can’t be undone.
      </p>
      <p className="thread-dialog-copy">
        Want a copy first? Use Download vault under Vault &amp; storage. The copy in this browser is removed too; files in a
        folder you connected stay on your computer.
      </p>
      {!open ? (
        <div className="thread-dialog-actions">
          <button className="thread-dialog-button is-danger" disabled={disabled} type="button" onClick={() => setOpen(true)}>
            Delete account…
          </button>
        </div>
      ) : (
        <form className="thread-dialog-form" onSubmit={handleSubmit} aria-labelledby="profile-delete-heading" aria-describedby="profile-delete-help">
          <label className="thread-dialog-field">
            <span className="thread-dialog-label">Password</span>
            <input autoComplete="current-password" className="thread-dialog-input" disabled={disabled || isSubmitting}
              name="deletePassword" onChange={(event) => setPassword(event.target.value)} required type="password" value={password} />
          </label>
          <label className="thread-dialog-field">
            <span className="thread-dialog-label">Type {CONFIRMATION} to confirm</span>
            <input autoCapitalize="characters" autoComplete="off" className="thread-dialog-input" disabled={disabled || isSubmitting}
              name="deleteConfirmation" onChange={(event) => setConfirmation(event.target.value)} required spellCheck={false} value={confirmation} />
          </label>
          {error ? <p className="profile-dialog-error" role="alert">{error}</p> : null}
          <div className="thread-dialog-actions">
            <button className="thread-dialog-button" disabled={isSubmitting} type="button"
              onClick={() => { setOpen(false); setPassword(""); setConfirmation(""); setError(null); }}>Cancel</button>
            <button className="thread-dialog-button is-danger" disabled={disabled || isSubmitting || !ready} type="submit">
              {isSubmitting ? "Deleting account…" : "Delete my account"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
