import { useEffect, useRef, useState } from "react";
import type {
  ApiKeyProvider,
  ApiKeySettings,
  AuthenticatedUser,
} from "../types";
import {
  getBillingDisplayLabel,
  getBillingStatusCopy,
} from "../lib/billing";

interface ProfileModalProps {
  billingErrorMessage: string | null;
  billingSubmitting: boolean;
  errorMessage: string | null;
  isOpen: boolean;
  isSaving: boolean;
  onClose: () => void;
  onLogout: () => void | Promise<void>;
  onManageBilling: () => void | Promise<void>;
  onSaveApiKeys: (args: {
    keys: Partial<Record<ApiKeyProvider, string | null>>;
  }) => Promise<ApiKeySettings>;
  onStartSubscription: () => void | Promise<void>;
  onSave: (args: { displayName: string; email: string }) => void | Promise<void>;
  user: AuthenticatedUser;
}

const API_KEY_FIELDS: Array<{
  label: string;
  provider: ApiKeyProvider;
  placeholder: string;
}> = [
  { label: "OpenAI", provider: "openai", placeholder: "sk-..." },
  { label: "Google Gemini", provider: "gemini", placeholder: "AIza..." },
  {
    label: "Hugging Face",
    provider: "huggingface",
    placeholder: "hf_...",
  },
  { label: "xAI", provider: "xai", placeholder: "xai-..." },
];

const EMPTY_API_KEY_DRAFTS: Record<ApiKeyProvider, string> = {
  gemini: "",
  huggingface: "",
  openai: "",
  xai: "",
};

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
  billingErrorMessage,
  billingSubmitting,
  errorMessage,
  isOpen,
  isSaving,
  onClose,
  onLogout,
  onManageBilling,
  onSaveApiKeys,
  onStartSubscription,
  onSave,
  user,
}: ProfileModalProps) {
  const displayNameInputRef = useRef<HTMLInputElement>(null);
  const [displayName, setDisplayName] = useState(user.displayName);
  const [email, setEmail] = useState(user.email);
  const [apiKeyDrafts, setApiKeyDrafts] = useState(EMPTY_API_KEY_DRAFTS);
  const [dirtyApiKeyProviders, setDirtyApiKeyProviders] = useState<
    ApiKeyProvider[]
  >([]);
  const [apiKeySettings, setApiKeySettings] = useState(user.apiKeys);
  const [apiKeySaving, setApiKeySaving] = useState(false);
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    setDisplayName(user.displayName);
    setEmail(user.email);
    setApiKeyDrafts(EMPTY_API_KEY_DRAFTS);
    setDirtyApiKeyProviders([]);
    setApiKeySettings(user.apiKeys);
    setApiKeyError(null);
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
  }, [isOpen, onClose, user.apiKeys, user.displayName, user.email]);

  if (!isOpen) {
    return null;
  }

  const trimmedDisplayName = displayName.trim();
  const trimmedEmail = email.trim().toLowerCase();
  const hasChanges =
    trimmedDisplayName !== user.displayName || trimmedEmail !== user.email;
  const showBillingAction = user.role !== "admin";
  const useManageBillingAction =
    user.billing.hasCustomer && user.billing.status !== "inactive";

  async function saveApiKeyChanges(
    overrides: Partial<Record<ApiKeyProvider, string | null>> = {},
  ) {
    const keys: Partial<Record<ApiKeyProvider, string | null>> = {
      ...Object.fromEntries(
        dirtyApiKeyProviders
          .filter((provider) => apiKeyDrafts[provider].trim())
          .map((provider) => [provider, apiKeyDrafts[provider].trim()]),
      ),
      ...overrides,
    };

    setApiKeySaving(true);
    setApiKeyError(null);

    try {
      const settings = await onSaveApiKeys({ keys });
      setApiKeySettings(settings);
      setApiKeyDrafts(EMPTY_API_KEY_DRAFTS);
      setDirtyApiKeyProviders([]);
    } catch (error) {
      setApiKeyError(
        error instanceof Error && error.message
          ? error.message
          : "Unable to save personal API keys.",
      );
    } finally {
      setApiKeySaving(false);
    }
  }

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

        <section className="profile-billing-section" aria-label="Billing summary">
          <div className="profile-billing-copy">
            <p className="eyebrow">Plan access</p>
            <strong>{getBillingDisplayLabel(user.billing)}</strong>
            <span>{getBillingStatusCopy(user.billing)}</span>
          </div>

          {showBillingAction ? (
            <button
              className="thread-dialog-button is-primary"
              disabled={billingSubmitting}
              onClick={() => {
                void (useManageBillingAction
                  ? onManageBilling()
                  : onStartSubscription());
              }}
              type="button"
            >
              {billingSubmitting
                ? "Opening Stripe..."
                : useManageBillingAction
                  ? "Manage billing"
                  : "Add hosted credits"}
            </button>
          ) : null}
        </section>

        <section className="profile-api-key-section" aria-label="Personal API keys">
          <div className="profile-api-key-heading">
            <div>
              <p className="eyebrow">Model providers</p>
              <strong>Use your own API keys</strong>
            </div>
            <span>Encrypted at rest</span>
          </div>

          <p className="thread-dialog-copy">
            A personal key is preferred for its provider and is billed directly by
            that provider. Saved keys are never displayed again.
          </p>

          <div className="profile-api-key-list">
            {API_KEY_FIELDS.map(({ label, placeholder, provider }) => {
              const summary = apiKeySettings.byProvider[provider];

              return (
                <div className="profile-api-key-row" key={provider}>
                  <label className="thread-dialog-field">
                    <span className="thread-dialog-label">
                      {label}
                      {summary.configured ? (
                        <small>Saved ••••{summary.hint}</small>
                      ) : null}
                    </span>
                    <input
                      autoComplete="off"
                      className="thread-dialog-input"
                      disabled={apiKeySaving}
                      onChange={(event) => {
                        setApiKeyDrafts((current) => ({
                          ...current,
                          [provider]: event.target.value,
                        }));
                        setDirtyApiKeyProviders((current) =>
                          current.includes(provider)
                            ? current
                            : [...current, provider],
                        );
                      }}
                      placeholder={
                        summary.configured
                          ? "Enter a replacement key"
                          : placeholder
                      }
                      type="password"
                      value={apiKeyDrafts[provider]}
                    />
                  </label>

                  {summary.configured ? (
                    <button
                      className="thread-dialog-button is-danger profile-api-key-remove"
                      disabled={apiKeySaving}
                      onClick={() => void saveApiKeyChanges({ [provider]: null })}
                      type="button"
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>

          {apiKeyError ? (
            <p className="profile-dialog-error" role="alert">
              {apiKeyError}
            </p>
          ) : null}

          <button
            className="thread-dialog-button is-primary profile-api-key-save"
            disabled={
              apiKeySaving ||
              !dirtyApiKeyProviders.some(
                (provider) => apiKeyDrafts[provider].trim().length > 0,
              )
            }
            onClick={() => void saveApiKeyChanges()}
            type="button"
          >
            {apiKeySaving ? "Saving keys..." : "Save API keys"}
          </button>
        </section>

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

          {billingErrorMessage ? (
            <p className="profile-dialog-error" role="alert">
              {billingErrorMessage}
            </p>
          ) : null}

          <div className="thread-dialog-actions">
            <button
              className="thread-dialog-button is-danger profile-logout-button"
              disabled={isSaving || billingSubmitting}
              onClick={() => void onLogout()}
              type="button"
            >
              Log out
            </button>
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
