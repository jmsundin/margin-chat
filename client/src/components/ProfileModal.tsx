import VaultPanel from "./VaultPanel";
import BillingDashboard from "./BillingDashboard";
import type { useMarkdownVault } from "../lib/useMarkdownVault";
import { useEffect, useRef, useState } from "react";
import type {
  ApiKeyProvider,
  ApiKeySettings,
  AuthenticatedUser,
  BillingDashboardData,
  BillingNotice,
} from "../types";
import {
  getBillingDisplayLabel,
  getBillingStatusCopy,
} from "../lib/billing";
import type { LocalDirectoryStatus } from "../lib/workspaceStorage";
import type { StateUploadProgress } from "../lib/api";

interface ProfileModalProps {
  initialTab?: "account" | "storage" | "billing";
  billingDashboard: BillingDashboardData | null;
  billingDashboardLoading: boolean;
  billingDashboardError: string | null;
  billingNotice: BillingNotice | null;
  onRefreshBilling: () => void | Promise<void>;
  onAddMoney: (amountCents: number) => void | Promise<void>;
  vault: ReturnType<typeof useMarkdownVault>;
  billingErrorMessage: string | null;
  billingSubmitting: boolean;
  cloudSyncEnabled: boolean;
  cloudSyncStatus: "fallback" | "loading" | "local" | "server";
  cloudBackupMatchesLocal: boolean;
  cloudBackupSizeBytes: number;
  errorMessage: string | null;
  isOpen: boolean;
  isSaving: boolean;
  localDirectoryStatus: LocalDirectoryStatus;
  onBackupToCloud: (
    onProgress: (progress: StateUploadProgress) => void,
  ) => Promise<void>;
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

function formatByteCount(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const fractionDigits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(fractionDigits)} ${units[unitIndex]}`;
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
  initialTab = "account",
  billingDashboard, billingDashboardLoading, billingDashboardError, billingNotice, onRefreshBilling, onAddMoney,
  vault,
  billingErrorMessage,
  billingSubmitting,
  cloudSyncEnabled,
  cloudSyncStatus,
  cloudBackupMatchesLocal,
  cloudBackupSizeBytes,
  errorMessage,
  isOpen,
  isSaving,
  localDirectoryStatus,
  onBackupToCloud,
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
    "account" | "api-keys" | "storage" | "billing"
  >(initialTab);
  const [storageBusy, setStorageBusy] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [cloudBackupBusy, setCloudBackupBusy] = useState(false);
  const [cloudBackupProgress, setCloudBackupProgress] =
    useState<StateUploadProgress | null>(null);
  const [cloudBackupResult, setCloudBackupResult] = useState<{
    kind: "error" | "success";
    message: string;
  } | null>(null);

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
    setActiveTab(initialTab);
    setStorageError(null);
    setCloudBackupResult(null);
    setCloudBackupProgress(null);
  }, [isOpen, initialTab, user.id]);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose]);

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
  const displayedCloudBackupProgress =
    cloudBackupBusy && cloudBackupProgress
      ? cloudBackupProgress
      : {
          totalBytes: cloudBackupSizeBytes,
          uploadedBytes: cloudBackupMatchesLocal ? cloudBackupSizeBytes : 0,
        };

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

  async function backupLocalMasterToCloud() {
    setCloudBackupBusy(true);
    setCloudBackupResult(null);
    setCloudBackupProgress(null);

    try {
      await onBackupToCloud(setCloudBackupProgress);
      setCloudBackupResult({
        kind: "success",
        message: "Vault synchronized.",
      });
    } catch (error) {
      setCloudBackupResult({
        kind: "error",
        message:
          error instanceof Error && error.message
            ? error.message
            : "Unable to back up the local master copy to the cloud.",
      });
    } finally {
      setCloudBackupBusy(false);
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
        className={`thread-dialog profile-dialog${activeTab === "billing" ? " is-billing" : ""}`}
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
            ["billing", "Billing"],
            ["api-keys", "API keys"],
            ["storage", "Markdown vault"],
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

                <button className="thread-dialog-button is-primary" onClick={() => setActiveTab("billing")} type="button">
                  Open billing dashboard
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
            </div>
          ) : null}

          {activeTab === "billing" ? (
            <section aria-labelledby="profile-tab-billing" className="profile-dialog-panel" id="profile-panel-billing" role="tabpanel">
              <BillingDashboard data={billingDashboard} loading={billingDashboardLoading} errorMessage={billingDashboardError}
                notice={billingNotice}
                checkoutErrorMessage={billingErrorMessage} isSubmitting={billingSubmitting} onRefresh={onRefreshBilling}
                onAddMoney={onAddMoney} onStartSubscription={onStartSubscription} onManageBilling={onManageBilling} user={user} />
            </section>
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
              <VaultPanel vault={vault} cloudSyncEnabled={cloudSyncEnabled} />
            </section>
          ) : null}
        </div>
      </section>
    </div>
  );
}
