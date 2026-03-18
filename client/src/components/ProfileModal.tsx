import { useEffect, useRef, useState } from "react";
import type { AuthenticatedUser } from "../types";

interface ProfileModalProps {
  errorMessage: string | null;
  isOpen: boolean;
  isSaving: boolean;
  onClose: () => void;
  onSave: (args: { displayName: string; email: string }) => void | Promise<void>;
  user: AuthenticatedUser;
}

function CloseIcon() {
  return (
    <svg
      aria-hidden="true"
      className="search-modal-close-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
    >
      <path d="m7 7 10 10" />
      <path d="m17 7-10 10" />
    </svg>
  );
}

function getInitials(displayName: string) {
  const initials = displayName
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");

  return initials || "MC";
}

export default function ProfileModal({
  errorMessage,
  isOpen,
  isSaving,
  onClose,
  onSave,
  user,
}: ProfileModalProps) {
  const displayNameInputRef = useRef<HTMLInputElement>(null);
  const [displayName, setDisplayName] = useState(user.displayName);
  const [email, setEmail] = useState(user.email);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    setDisplayName(user.displayName);
    setEmail(user.email);
    displayNameInputRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose, user.displayName, user.email]);

  if (!isOpen) {
    return null;
  }

  const trimmedDisplayName = displayName.trim();
  const trimmedEmail = email.trim().toLowerCase();
  const hasChanges =
    trimmedDisplayName !== user.displayName || trimmedEmail !== user.email;

  return (
    <div
      className="thread-dialog-backdrop"
      onClick={onClose}
      role="presentation"
    >
      <section
        aria-labelledby="profile-dialog-title"
        aria-modal="true"
        className="thread-dialog profile-dialog"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="thread-dialog-head">
          <div>
            <p className="eyebrow">Profile</p>
            <h2 id="profile-dialog-title">Your account</h2>
          </div>

          <button
            aria-label="Close profile"
            className="search-modal-close"
            onClick={onClose}
            type="button"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="profile-dialog-summary">
          <div aria-hidden="true" className="profile-dialog-avatar">
            {getInitials(user.displayName)}
          </div>

          <div className="profile-dialog-summary-copy">
            <strong>{user.displayName}</strong>
            <span>{user.role === "admin" ? "Admin account" : "Member account"}</span>
          </div>
        </div>

        <p className="thread-dialog-copy">
          Update the profile details shown for this workspace account.
        </p>

        <form
          className="thread-dialog-form"
          onSubmit={(event) => {
            event.preventDefault();
            void onSave({
              displayName: trimmedDisplayName,
              email: trimmedEmail,
            });
          }}
        >
          <label className="thread-dialog-field">
            <span className="thread-dialog-label">Display name</span>
            <input
              ref={displayNameInputRef}
              autoComplete="name"
              className="thread-dialog-input"
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="Your name"
              type="text"
              value={displayName}
            />
          </label>

          <label className="thread-dialog-field">
            <span className="thread-dialog-label">Email</span>
            <input
              autoComplete="email"
              className="thread-dialog-input"
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              type="email"
              value={email}
            />
          </label>

          {errorMessage ? (
            <p className="profile-dialog-error" role="alert">
              {errorMessage}
            </p>
          ) : null}

          <div className="thread-dialog-actions">
            <button
              className="thread-dialog-button"
              onClick={onClose}
              type="button"
            >
              Cancel
            </button>
            <button
              className="thread-dialog-button is-primary"
              disabled={isSaving || !hasChanges}
              type="submit"
            >
              {isSaving ? "Saving..." : "Save changes"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
