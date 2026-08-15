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
import type { LocalDirectoryStatus } from "../lib/workspaceStorage";

interface ProfileModalProps {
  billingErrorMessage: string | null;
  billingSubmitting: boolean;
  cloudSyncEnabled: boolean;
  errorMessage: string | null;
  isOpen: boolean;
  isSaving: boolean;
  localDirectoryStatus: LocalDirectoryStatus;
  onChooseLocalDirectory: () => Promise<void>;
  onClearLocalDirectory: () => Promise<void>;
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
  cloudSyncEnabled,
  errorMessage,
  isOpen,
  isSaving,
  localDirectoryStatus,
  onChooseLocalDirectory,
  onClearLocalDirectory,
  onClose,
  onLogout,
  onManageBilling,
  onSaveApiKeys,
  onStartSubscription,
  onSave,
  user,
}: ProfileModalProps) {
  const displayNameInputRef = useRef<HTMLInputElement>(null);
  const profileBodyRef = useRef<HTMLDivElement>(null);
  const [displayName, setDisplayName] = useState(user.displayName);
  const [email, setEmail] = useState(user.email);
  const [apiKeyDrafts, setApiKeyDrafts] = useState(EMPTY_API_KEY_DRAFTS);
  const [dirtyApiKeyProviders, setDirtyApiKeyProviders] = useState<
    ApiKeyProvider[]
  >([]);
  const [apiKeySettings, setApiKeySettings] = useState(user.apiKeys);
  const [apiKeySaving, setApiKeySaving] = useState(false);
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<
    "account" | "api-keys" | "storage"
  >("account");
  const [storageBusy, setStorageBusy] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);

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
    setActiveTab("account");
    setStorageError(null);

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

  useEffect(() => {
    if (profileBodyRef.current) {
      profileBodyRef.current.scrollTop = 0;
    }

    if (isOpen && activeTab === "account") {
      displayNameInputRef.current?.focus();
    }
  }, [activeTab, isOpen]);

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

  async function chooseStorageDirectory() {
    setStorageBusy(true);
    setStorageError(null);

    try {
      await onChooseLocalDirectory();
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return;
      }

      setStorageError(
        error instanceof Error && error.message
          ? error.message
          : "Unable to use that local storage directory.",
      );
    } finally {
      setStorageBusy(false);
    }
  }

  async function clearStorageDirectory() {
    setStorageBusy(true);
    setStorageError(null);

    try {
      await onClearLocalDirectory();
    } catch (error) {
      setStorageError(
        error instanceof Error && error.message
          ? error.message
          : "Unable to forget the local storage directory.",
      );
    } finally {
      setStorageBusy(false);
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

        <div
          aria-label="Profile settings sections"
          className="profile-dialog-tabs"
          role="tablist"
        >
          {([
            ["account", "Account"],
            ["api-keys", "API keys"],
            ["storage", "Local storage"],
          ] as const).map(([tabId, label]) => (
            <button
              aria-controls={`profile-panel-${tabId}`}
              aria-selected={activeTab === tabId}
              className={activeTab === tabId ? "is-active" : ""}
              id={`profile-tab-${tabId}`}
              key={tabId}
              onClick={() => setActiveTab(tabId)}
              role="tab"
              type="button"
            >
              {label}
            </button>
          ))}
        </div>

        <div className="profile-dialog-body" ref={profileBodyRef}>
          {activeTab === "account" ? (
            <div
              aria-labelledby="profile-tab-account"
              className="profile-dialog-panel"
              id="profile-panel-account"
              role="tabpanel"
            >
              <div className="profile-dialog-summary">
                <div aria-hidden="true" className="profile-dialog-avatar">
                  {getInitials(user.displayName)}
                </div>

                <div className="profile-dialog-summary-copy">
                  <strong>{user.displayName}</strong>
                  <span>
                    {user.role === "admin" ? "Admin account" : "Member account"}
                  </span>
                </div>
              </div>

              <section
                className="profile-billing-section"
                aria-label="Billing summary"
              >
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
                        : "Start subscription"}
                  </button>
                ) : null}
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
            </div>
          ) : null}

          {activeTab === "api-keys" ? (
            <section
              aria-labelledby="profile-tab-api-keys"
              className="profile-api-key-section profile-dialog-panel"
              id="profile-panel-api-keys"
              role="tabpanel"
            >
              <div className="profile-api-key-heading">
                <div>
                  <p className="eyebrow">Model providers</p>
                  <strong>Use your own API keys</strong>
                </div>
                <span>Encrypted at rest</span>
              </div>

              <p className="thread-dialog-copy">
                A personal key is preferred for its provider and is billed directly
                by that provider. Saved keys are never displayed again.
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
                          onClick={() =>
                            void saveApiKeyChanges({ [provider]: null })
                          }
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
          ) : null}

          {activeTab === "storage" ? (
            <section
              aria-labelledby="profile-tab-storage"
              className="profile-storage-section profile-dialog-panel"
              id="profile-panel-storage"
              role="tabpanel"
            >
              <div>
                <p className="eyebrow">Local master copy</p>
                <h3>Keep your work on this computer</h3>
                <p className="thread-dialog-copy">
                  Margin Chat saves every change in this browser first. A chosen
                  directory also receives an automatic, readable JSON copy of your
                  workspace.
                </p>
              </div>

              <div className="profile-storage-status-list">
                <div className="profile-storage-status">
                  <span>Browser storage</span>
                  <strong>Saving automatically</strong>
                  <small>Authoritative local copy</small>
                </div>
                <div className="profile-storage-status">
                  <span>Cloud copy</span>
                  <strong>
                    {cloudSyncEnabled ? "Syncing automatically" : "Local only"}
                  </strong>
                  <small>
                    {cloudSyncEnabled
                      ? "Available for paid plans and admins"
                      : "Cloud sync requires a paid plan or admin access"}
                  </small>
                </div>
              </div>

              <div className="profile-storage-directory-card">
                <div>
                  <span>Storage directory</span>
                  <strong>
                    {localDirectoryStatus.directoryName ?? "No directory chosen"}
                  </strong>
                  <small>
                    {localDirectoryStatus.permission === "granted"
                      ? `Writing ${localDirectoryStatus.fileName}`
                      : localDirectoryStatus.supported
                        ? "Choose a folder for an additional local copy"
                        : "Directory selection is not supported by this browser"}
                  </small>
                </div>

                <div className="profile-storage-directory-actions">
                  <button
                    className="thread-dialog-button is-primary"
                    disabled={!localDirectoryStatus.supported || storageBusy}
                    onClick={() => void chooseStorageDirectory()}
                    type="button"
                  >
                    {storageBusy
                      ? "Updating..."
                      : localDirectoryStatus.directoryName
                        ? "Change directory"
                        : "Choose directory"}
                  </button>
                  {localDirectoryStatus.directoryName ? (
                    <button
                      className="thread-dialog-button"
                      disabled={storageBusy}
                      onClick={() => void clearStorageDirectory()}
                      type="button"
                    >
                      Stop using folder
                    </button>
                  ) : null}
                </div>
              </div>

              {storageError ? (
                <p className="profile-dialog-error" role="alert">
                  {storageError}
                </p>
              ) : null}

              <p className="profile-storage-footnote">
                Periodic cloud checks only push this local master copy outward;
                they never replace it with an older cloud copy.
              </p>
            </section>
          ) : null}
        </div>
      </section>
    </div>
  );
}
