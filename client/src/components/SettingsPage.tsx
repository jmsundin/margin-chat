import VaultPanel from "./VaultPanel";
import AgentConnectionsPanel from "./AgentConnectionsPanel";
import BillingDashboard from "./BillingDashboard";
import PasswordChangeForm from "./PasswordChangeForm";
import AccountDeletionForm from "./AccountDeletionForm";
import type { useMarkdownVault } from "../lib/useMarkdownVault";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AiFeatureSettings, AppearanceSettings, useVoiceTypingEnabled, VoiceTypingSettings, type ThemeMode } from "./AppSettingsSections";
import type {
  ApiKeyProvider,
  ApiKeySettings,
  AuthenticatedUser,
  BillingDashboardData,
  BillingPlan,
} from "../types";
import { formatCreditBalance } from "../lib/billing";
import { AUTH_PATHS } from "../lib/siteRoutes";
import { dictationSupported } from "../lib/dictation";
import type { JevStatus } from "../lib/jevAssistance";
import type { VaultPassageIndex } from "../lib/useVaultPassageIndex";
import type { MainViewMode } from "../types";
import type { LocalDirectoryStatus } from "../lib/workspaceStorage";
import type { StateUploadProgress } from "../lib/api";

export type SettingsSection = "account" | "billing" | "api-keys" | "agents" | "appearance" | "voice" | "storage";

interface SettingsPageProps {
  /** The section to open; null or left out opens the section list on phones and Account on computers. */
  initialTab?: SettingsSection | null;
  onOpenWebsiteSettings?: (tab: "account" | "billing" | "api-keys" | "agents") => void;
  billingDashboard: BillingDashboardData | null;
  billingDashboardLoading: boolean;
  billingDashboardError: string | null;
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
  onChangePassword: (args: { currentPassword: string; password: string }) => Promise<void>;
  onDeleteAccount: (args: { password: string; confirmation: string }) => Promise<void>;
  onClearLocalDirectory: () => Promise<void>;
  onClose: () => void;
  onLogout: () => void | Promise<void>;
  onManageBilling: () => void | Promise<void>;
  onSaveApiKeys: (args: {
    keys: Partial<Record<ApiKeyProvider, string | null>>;
  }) => Promise<ApiKeySettings>;
  onStartSubscription: (plan?: BillingPlan) => void | Promise<void>;
  onUpgradeToPlus?: () => void | Promise<void>;
  onSave: (args: { displayName: string; email: string; currentPassword?: string }) => void | Promise<void>;
  user: AuthenticatedUser;
  theme?: ThemeMode;
  onSetTheme?: (theme: ThemeMode) => void;
  mainViewMode?: MainViewMode;
  onSetMainViewMode?: (mode: MainViewMode) => void;
  jevEnabled?: boolean;
  jevStatus?: JevStatus;
  onSetJevEnabled?: (enabled: boolean) => void;
  vaultIndex?: VaultPassageIndex;
  /** The free trial: no account, so only the settings that work in this browser. */
  guest?: boolean;
}

const SECTIONS: Array<{ id: SettingsSection; label: string; description: string; keywords: string }> = [
  { id: "account", label: "Account", description: "Your name, email and password.", keywords: "profile name email password log out sign out delete account close account remove" },
  { id: "billing", label: "Plan & credit", description: "Your plan, AI balance, payments and receipts.", keywords: "billing balance money payment receipts subscription plus cloud plan budget" },
  { id: "api-keys", label: "AI & privacy", description: "Your own model keys and the AI features that read your vault.", keywords: "api keys openai anthropic claude gemini google hugging face xai meta muse jev search by meaning embeddings" },
  { id: "agents", label: "Connected apps", description: "Let Claude Code, ChatGPT, Gemini, Cursor and other AI apps use your vault.", keywords: "agents mcp tokens claude code cursor chatgpt gemini connect" },
  { id: "appearance", label: "Editor & look", description: "Theme, the main view and the document editor.", keywords: "theme dark light main view chat tiles graph classic editor live preview" },
  { id: "voice", label: "Voice typing", description: "Talk instead of typing in any text field.", keywords: "dictation mic microphone hold space talk speech" },
  { id: "storage", label: "Vault & storage", description: "Where your Markdown files live and how they sync.", keywords: "markdown vault folder cloud sync download upload files storage deleted backup" },
];

/** Sections that only do something with an account. */
const GUEST_HIDDEN_SECTIONS = new Set<SettingsSection>(["billing", "api-keys", "agents"]);

const PHONE_QUERY = "(max-width: 720px)";

function subscribePhoneLayout(onChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener?.("change", onChange);
  return () => query.removeEventListener?.("change", onChange);
}

function readPhoneLayout() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(PHONE_QUERY).matches;
}

export function matchesSettingsQuery(section: (typeof SECTIONS)[number], query: string) {
  const haystack = `${section.label} ${section.keywords}`.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((word) => haystack.includes(word));
}

const SECTION_ICONS: Record<SettingsSection, string> = {
  account: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 20c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5",
  billing: "M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2ZM3 10h18M7 15h4",
  "api-keys": "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8Z",
  agents: "M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0ZM12 17v4",
  appearance: "M4 20h4L19 9l-4-4L4 16ZM13 7l4 4",
  voice: "M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3ZM5 11a7 7 0 0 0 14 0M12 18v3",
  storage: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z",
};

function SettingsIcon({ path }: { path: string }) {
  return (
    <svg aria-hidden="true" className="settings-page-icon" fill="none" stroke="currentColor" strokeLinecap="round"
      strokeLinejoin="round" strokeWidth="1.7" viewBox="0 0 24 24"><path d={path} /></svg>
  );
}

const API_KEY_FIELDS: Array<{
  label: string;
  provider: ApiKeyProvider;
  placeholder: string;
}> = [
  { label: "OpenAI", provider: "openai", placeholder: "sk-..." },
  { label: "Anthropic Claude", provider: "anthropic", placeholder: "sk-ant-..." },
  { label: "Google Gemini", provider: "gemini", placeholder: "AIza..." },
  {
    label: "Hugging Face",
    provider: "huggingface",
    placeholder: "hf_...",
  },
  { label: "xAI", provider: "xai", placeholder: "xai-..." },
  { label: "Meta Muse", provider: "meta", placeholder: "Meta Model API key" },
];

const EMPTY_API_KEY_DRAFTS: Record<ApiKeyProvider, string> = {
  anthropic: "",
  gemini: "",
  huggingface: "",
  meta: "",
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


function getInitials(displayName: string) {
  const initials = displayName
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");

  return initials || "MC";
}

export default function SettingsPage({
  initialTab = null,
  billingDashboard, billingDashboardLoading, billingDashboardError, onRefreshBilling, onAddMoney,
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
  onChangePassword,
  onDeleteAccount,
  onClearLocalDirectory,
  onClose,
  onLogout,
  onManageBilling,
  onSaveApiKeys,
  onStartSubscription,
  onUpgradeToPlus,
  onSave,
  onOpenWebsiteSettings,
  user,
  theme,
  onSetTheme,
  mainViewMode,
  onSetMainViewMode,
  jevEnabled,
  jevStatus,
  onSetJevEnabled,
  vaultIndex,
  guest = false,
}: SettingsPageProps) {
  const displayNameInputRef = useRef<HTMLInputElement>(null);
  const profileBodyRef = useRef<HTMLDivElement>(null);
  const passwordChangingRef = useRef(false);
  const [passwordChanging, setPasswordChanging] = useState(false);
  const [displayName, setDisplayName] = useState(user.displayName);
  const [email, setEmail] = useState(user.email);
  const [emailPassword, setEmailPassword] = useState("");
  const [apiKeyDrafts, setApiKeyDrafts] = useState(EMPTY_API_KEY_DRAFTS);
  const [dirtyApiKeyProviders, setDirtyApiKeyProviders] = useState<
    ApiKeyProvider[]
  >([]);
  const [apiKeySettings, setApiKeySettings] = useState(user.apiKeys);
  const [apiKeySaving, setApiKeySaving] = useState(false);
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);
  const phone = useSyncExternalStore(subscribePhoneLayout, readPhoneLayout, () => false);
  const voiceTypingOn = useVoiceTypingEnabled();
  const [selectedTab, setActiveTab] = useState<SettingsSection | null>(initialTab ?? null);
  const [query, setQuery] = useState("");
  // Phones show the section list until a section is picked; computers always show one section.
  const activeTab: SettingsSection = selectedTab && !(guest && GUEST_HIDDEN_SECTIONS.has(selectedTab)) ? selectedTab : "account";
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
    setEmailPassword("");
    setApiKeyDrafts(EMPTY_API_KEY_DRAFTS);
    setDirtyApiKeyProviders([]);
    setApiKeySettings(user.apiKeys);
    setApiKeyError(null);
    setActiveTab(initialTab ?? null);
    setQuery("");
    setStorageError(null);
    setCloudBackupResult(null);
    setCloudBackupProgress(null);
  }, [isOpen, initialTab, user.id]);

  // A saved email change leaves nothing to confirm; drop the typed password.
  useEffect(() => { setEmailPassword(""); }, [user.email]);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !passwordChangingRef.current) {
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

    if (isOpen && selectedTab === "account" && !phone) {
      displayNameInputRef.current?.focus();
    }
  }, [selectedTab, isOpen, phone]);

  if (!isOpen) {
    return null;
  }

  const trimmedDisplayName = displayName.trim();
  const trimmedEmail = email.trim().toLowerCase();
  const emailChanged = trimmedEmail !== user.email;
  const hasChanges =
    trimmedDisplayName !== user.displayName || emailChanged;
  const displayedCloudBackupProgress =
    cloudBackupBusy && cloudBackupProgress
      ? cloudBackupProgress
      : {
          totalBytes: cloudBackupSizeBytes,
          uploadedBytes: cloudBackupMatchesLocal ? cloudBackupSizeBytes : 0,
        };

  function closeProfile() {
    if (!passwordChangingRef.current) onClose();
  }

  function selectTab(tab: SettingsSection | null) {
    if (!passwordChangingRef.current) setActiveTab(tab);
  }

  async function changePassword(args: { currentPassword: string; password: string }) {
    passwordChangingRef.current = true;
    setPasswordChanging(true);
    try {
      await onChangePassword(args);
    } finally {
      passwordChangingRef.current = false;
      setPasswordChanging(false);
    }
  }

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

  const configuredKeyCount = Object.values(apiKeySettings.byProvider).filter((summary) => summary?.configured).length;
  const facts: Partial<Record<SettingsSection, string>> = {
    billing: user.billing.creditBalanceMicros > 0 ? formatCreditBalance(user.billing.creditBalanceMicros) : undefined,
    "api-keys": configuredKeyCount ? `${configuredKeyCount} key${configuredKeyCount === 1 ? "" : "s"}` : undefined,
    appearance: theme ? (theme === "dark" ? "Dark" : "Light") : undefined,
    voice: dictationSupported() ? (voiceTypingOn ? "On" : "Off") : undefined,
    storage: cloudSyncEnabled ? "Cloud" : "This device",
  };
  const visibleSections = SECTIONS.filter((section) => section.id !== "voice" || dictationSupported())
    .filter((section) => !guest || !GUEST_HIDDEN_SECTIONS.has(section.id))
    .filter((section) => matchesSettingsQuery(section, query));
  const found = SECTIONS.find((section) => section.id === activeTab)!;
  const current = guest && found.id === "account" ? { ...found, description: "You're trying Margin Chat without an account." } : found;
  const showList = !phone || selectedTab === null;
  const showSection = !phone || selectedTab !== null;

  return (
    <section
      aria-label="Settings"
      aria-modal="true"
      className={`settings-page${phone ? " is-phone" : ""}`}
      role="dialog"
    >
      <header className="settings-page-top">
        {phone && selectedTab !== null ? (
          <button className="settings-page-back" disabled={passwordChanging} onClick={() => selectTab(null)} type="button">
            <SettingsIcon path="M15 6l-6 6 6 6" />Settings
          </button>
        ) : (
          <button aria-label="Close settings" className="settings-page-back" disabled={passwordChanging} onClick={closeProfile} type="button">
            <SettingsIcon path="M15 6l-6 6 6 6" />Documents
          </button>
        )}
        {phone ? null : <h1 className="settings-page-title">Settings</h1>}
        {phone && selectedTab !== null ? (
          <button aria-label="Close settings" className="settings-page-close" disabled={passwordChanging} onClick={closeProfile} type="button">
            <SettingsIcon path="M6 6l12 12M18 6L6 18" />
          </button>
        ) : null}
      </header>

      <div className="settings-page-layout">
        {showList ? <nav aria-label="Settings sections" className="settings-page-nav">
          {phone ? <h1 className="settings-page-title">Settings</h1> : null}
          <div className="settings-page-me">
            <span aria-hidden="true" className="profile-dialog-avatar settings-page-avatar">{getInitials(user.displayName)}</span>
            <span className="settings-page-me-copy">
              <strong>{user.displayName}</strong>
              <span>{guest ? "Free trial" : user.email}</span>
            </span>
          </div>
          <label className="settings-page-search">
            <SettingsIcon path="M11 4.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13ZM20 20l-4.2-4.2" />
            <input
              aria-label="Search settings"
              data-dictation="off"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && visibleSections[0]) selectTab(visibleSections[0].id);
                if (event.key === "Escape" && query) { event.stopPropagation(); setQuery(""); }
              }}
              placeholder="Search settings"
              type="text"
              value={query}
            />
          </label>
          <div aria-orientation="vertical" className="settings-page-sections" role="tablist">
            {visibleSections.map((section) => (
              <button
                aria-controls={`profile-panel-${section.id}`}
                aria-selected={!phone && activeTab === section.id}
                className={!phone && activeTab === section.id ? "settings-page-item is-active" : "settings-page-item"}
                disabled={passwordChanging}
                id={`profile-tab-${section.id}`}
                key={section.id}
                onClick={() => selectTab(section.id)}
                role="tab"
                type="button"
              >
                <SettingsIcon path={SECTION_ICONS[section.id]} />
                <span className="settings-page-item-label">{section.label}</span>
                {facts[section.id] ? <span className="settings-page-item-fact">{facts[section.id]}</span> : null}
                {phone ? <SettingsIcon path="M9 6l6 6-6 6" /> : null}
              </button>
            ))}
            {!visibleSections.length ? <p className="settings-page-empty">No settings match “{query.trim()}”.</p> : null}
          </div>
          <button className="settings-page-item settings-page-logout" disabled={isSaving || billingSubmitting || passwordChanging}
            onClick={() => { if (!passwordChangingRef.current) void onLogout(); }} type="button">
            <SettingsIcon path="M10 4H5v16h5M14 8l4 4-4 4M18 12H9" />
            <span className="settings-page-item-label">{guest ? "Sign up free" : "Log out"}</span>
          </button>
        </nav> : null}

        {showSection ? <div className="settings-page-main" ref={profileBodyRef}>
          <section
            aria-labelledby={`profile-tab-${activeTab}`}
            className={`settings-page-section profile-dialog-panel is-${activeTab}`}
            id={`profile-panel-${activeTab}`}
            role="tabpanel"
          >
            <div className="settings-page-heading">
              <h2>{current.label}</h2>
              <p>{current.description}</p>
            </div>

            {activeTab === "account" && guest ? <div className="thread-dialog-form">
              <p className="thread-dialog-copy">Your documents are saved only in this browser, and AI runs on Chrome’s built-in model when this computer can run it.</p>
              <p className="thread-dialog-copy">Sign up free to keep your work in the cloud, use AI on any device, and connect Claude, ChatGPT or Gemini to your vault.</p>
              <div className="thread-dialog-actions">
                <a className="thread-dialog-button" href={AUTH_PATHS.login}>Log in</a>
                <a className="thread-dialog-button is-primary" href={AUTH_PATHS.signup}>Sign up free</a>
              </div>
            </div> : activeTab === "account" ? (onOpenWebsiteSettings ? <div className="thread-dialog-form">
              <p className="thread-dialog-copy">Signed in as {user.email}. Manage your profile and password on the Margin Chat website.</p>
              <div className="thread-dialog-actions">
                <button className="thread-dialog-button is-primary" type="button" onClick={() => onOpenWebsiteSettings("account")}>Manage account on website</button>
              </div>
            </div> : <>
              <div className="profile-dialog-summary">
                <div aria-hidden="true" className="profile-dialog-avatar">{getInitials(user.displayName)}</div>
                <div className="profile-dialog-summary-copy">
                  <strong>{user.displayName}</strong>
                  <span>{user.role === "admin" ? "Admin account" : "Member account"}</span>
                </div>
              </div>
              <form
                className="thread-dialog-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (passwordChangingRef.current || isSaving) return;
                  void onSave({ displayName: trimmedDisplayName, email: trimmedEmail, ...(emailChanged ? { currentPassword: emailPassword } : {}) });
                }}
              >
                <label className="thread-dialog-field">
                  <span className="thread-dialog-label">Display name</span>
                  <input ref={displayNameInputRef} autoComplete="name" className="thread-dialog-input" disabled={passwordChanging}
                    onChange={(event) => setDisplayName(event.target.value)} placeholder="Your name" type="text" value={displayName} />
                </label>
                <label className="thread-dialog-field">
                  <span className="thread-dialog-label">Email</span>
                  <input autoComplete="email" className="thread-dialog-input" disabled={passwordChanging}
                    onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" type="email" value={email} />
                </label>
                {emailChanged ? <label className="thread-dialog-field">
                  <span className="thread-dialog-label">Current password</span>
                  <input autoComplete="current-password" className="thread-dialog-input" disabled={passwordChanging}
                    onChange={(event) => setEmailPassword(event.target.value)} placeholder="Needed to change your email" type="password" value={emailPassword} />
                  <span className="thread-dialog-hint">We'll tell {user.email} about the change.</span>
                </label> : null}
                {errorMessage ? <p className="profile-dialog-error" role="alert">{errorMessage}</p> : null}
                {billingErrorMessage ? <p className="profile-dialog-error" role="alert">{billingErrorMessage}</p> : null}
                <div className="thread-dialog-actions">
                  {hasChanges ? <button className="thread-dialog-button" disabled={passwordChanging} type="button"
                    onClick={() => { setDisplayName(user.displayName); setEmail(user.email); setEmailPassword(""); }}>Undo changes</button> : null}
                  <button className="thread-dialog-button is-primary" disabled={isSaving || passwordChanging || !hasChanges || (emailChanged && !emailPassword)} type="submit">
                    {isSaving ? "Saving..." : "Save changes"}
                  </button>
                </div>
              </form>
              <PasswordChangeForm disabled={isSaving} key={user.id} onChangePassword={changePassword} />
              {user.role !== "admin" ? <AccountDeletionForm disabled={isSaving || passwordChanging} key={`delete-${user.id}`}
                cloudVault={user.billing.accessKind === "subscription"} onDeleteAccount={onDeleteAccount} /> : null}
            </>) : null}

            {activeTab === "billing" ? (
              <BillingDashboard data={billingDashboard} loading={billingDashboardLoading} errorMessage={billingDashboardError}
                checkoutErrorMessage={billingErrorMessage} isSubmitting={billingSubmitting} onRefresh={onRefreshBilling}
                onAddMoney={onAddMoney} onStartSubscription={onStartSubscription} onUpgradeToPlus={onUpgradeToPlus} onManageBilling={onManageBilling} user={user} />
            ) : null}

            {activeTab === "api-keys" ? <>
              <div className="profile-api-key-section">
              {onOpenWebsiteSettings ? <>
                <h3>API keys</h3>
                <p className="thread-dialog-copy">Your saved provider keys are available to AI conversations here. Add or remove keys on the Margin Chat website.</p>
                <button className="thread-dialog-button is-primary" type="button" onClick={() => onOpenWebsiteSettings("api-keys")}>Manage API keys on website</button>
              </> : <>
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
                  const summary = apiKeySettings.byProvider[provider] ?? { configured: false, hint: null };

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
              </>}
              </div>
              <AiFeatureSettings jevEnabled={jevEnabled} jevStatus={jevStatus} onSetJevEnabled={onSetJevEnabled} vaultIndex={vaultIndex} />
            </> : null}

            {activeTab === "agents" ? (
              <div className="profile-api-key-section">
                {onOpenWebsiteSettings ? <>
                  <p className="thread-dialog-copy">Make tokens for Claude Code, Cursor and other MCP agents on the Margin Chat website.</p>
                  <button className="thread-dialog-button is-primary" type="button" onClick={() => onOpenWebsiteSettings("agents")}>Manage agents on website</button>
                </> : <AgentConnectionsPanel />}
              </div>
            ) : null}

            {activeTab === "appearance" ? (
              <AppearanceSettings mainViewMode={mainViewMode} onSetMainViewMode={onSetMainViewMode} onSetTheme={onSetTheme} theme={theme} />
            ) : null}

            {activeTab === "voice" ? <VoiceTypingSettings /> : null}

            {activeTab === "storage" ? (
              <div className="profile-storage-section">
                <VaultPanel vault={vault} cloudSyncEnabled={cloudSyncEnabled} />
              </div>
            ) : null}
          </section>
        </div> : null}
      </div>
    </section>
  );
}
