import { useRef, useState, type FormEvent } from "react";

interface PasswordChangeFormProps {
  disabled?: boolean;
  onChangePassword: (args: {
    currentPassword: string;
    password: string;
  }) => Promise<void>;
}

export default function PasswordChangeForm({ disabled = false, onChangePassword }: PasswordChangeFormProps) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || submittingRef.current) return;
    setError(null);
    setSuccess(false);

    if (!currentPassword) {
      setError("Enter your current password.");
      return;
    }
    if (password.length < 8 || password.length > 200) {
      setError("New password must be between 8 and 200 characters.");
      return;
    }
    if (password !== confirmation) {
      setError("Passwords do not match.");
      return;
    }
    if (currentPassword === password) {
      setError("Choose a different password from your current password.");
      return;
    }

    submittingRef.current = true;
    setIsSubmitting(true);
    try {
      await onChangePassword({ currentPassword, password });
      setCurrentPassword("");
      setPassword("");
      setConfirmation("");
      setSuccess(true);
    } catch (error) {
      setError(error instanceof Error && error.message ? error.message : "Unable to change your password.");
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  }

  return (
    <section className="profile-password-section" aria-labelledby="profile-password-heading">
      <div>
        <p className="eyebrow">Security</p>
        <h3 id="profile-password-heading">Change password</h3>
      </div>
      <p className="thread-dialog-copy" id="profile-password-help">
        Use 8–200 characters. You’ll stay signed in here; your other sessions will be signed out.
      </p>
      <form className="thread-dialog-form" onSubmit={handleSubmit} aria-labelledby="profile-password-heading">
        <label className="thread-dialog-field">
          <span className="thread-dialog-label">Current password</span>
          <input autoComplete="current-password" className="thread-dialog-input" disabled={disabled || isSubmitting}
            name="currentPassword" onChange={(event) => { setCurrentPassword(event.target.value); setSuccess(false); }}
            required type="password" value={currentPassword} />
        </label>
        <label className="thread-dialog-field">
          <span className="thread-dialog-label">New password</span>
          <input aria-describedby="profile-password-help" autoComplete="new-password" className="thread-dialog-input"
            disabled={disabled || isSubmitting} maxLength={200} minLength={8} name="newPassword"
            onChange={(event) => { setPassword(event.target.value); setSuccess(false); }} required type="password" value={password} />
        </label>
        <label className="thread-dialog-field">
          <span className="thread-dialog-label">Confirm new password</span>
          <input autoComplete="new-password" className="thread-dialog-input" disabled={disabled || isSubmitting}
            maxLength={200} minLength={8} name="confirmNewPassword"
            onChange={(event) => { setConfirmation(event.target.value); setSuccess(false); }} required type="password" value={confirmation} />
        </label>
        {error ? <p className="profile-dialog-error" role="alert">{error}</p> : null}
        {success ? <p className="thread-dialog-copy" role="status">Password changed. Your other sessions have been signed out.</p> : null}
        <div className="thread-dialog-actions">
          <button className="thread-dialog-button is-primary" disabled={disabled || isSubmitting || !currentPassword || !password || !confirmation} type="submit">
            {isSubmitting ? "Changing password…" : "Change password"}
          </button>
        </div>
      </form>
    </section>
  );
}
