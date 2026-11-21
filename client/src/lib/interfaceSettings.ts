import { apiFetch } from "./apiTransport";

/**
 * How a person has set up their interface, kept on their account so every device opens the
 * same way (thread "Simplify Margin Chat with opt-in features").
 *
 * Each setting still lives in localStorage under its own name, so the app reads it at once
 * and works offline. This module copies the ones below to the account and back:
 * - On sign-in it asks the account for its settings. A setting the account has wins over this
 *   device's; one only this device has is sent up, so the first device seeds the account.
 * - A change made here (through writeSyncedSetting) is sent a moment later, only the names
 *   that changed, so two devices changing different settings both keep theirs.
 * - When a setting arrives from the account, a `storage` event fires for it, the same one a
 *   change in another tab fires, so whatever shows that setting updates.
 */
export const SYNCED_SETTINGS = [
  "margin-chat:features",
  "margin-chat-theme",
  "margin-chat:notebook",
  "margin-chat:quiet-page",
  "margin-chat:dictation-button",
  "margin-chat:dictation-hold-space",
  "margin-chat:feature-hints-dismissed",
  "margin-chat:language-reader:look",
  "margin-chat:language-reader:auto-known",
  "margin-chat:language-reader:auto-known-explained",
  "margin-chat:explore-layout", "margin-chat:explore-source",
  "margin-chat:ai-presets",
  "margin-chat:rediscover", "margin-chat:rediscover-log",
] as const;
export type SyncedSetting = (typeof SYNCED_SETTINGS)[number];

const SEND_DELAY_MS = 600;
/** Another device may have changed something; look again when the window comes back, at most this often. */
const REFRESH_EVERY_MS = 60_000;

interface SyncState {
  userId: string;
  /** What the account holds, once read. Until then nothing is sent. */
  account: Record<string, string> | null;
  dirty: Set<SyncedSetting>;
  timer: ReturnType<typeof setTimeout> | null;
  lastRead: number;
  /** The first read has finished, whether or not it reached the account. */
  loaded: boolean;
  stopped: boolean;
}
let sync: SyncState | null = null;
const loadedListeners = new Set<() => void>();

const isSynced = (name: string): name is SyncedSetting => (SYNCED_SETTINGS as readonly string[]).includes(name);

function readLocal(name: string): string | null {
  try { return localStorage.getItem(name); } catch { return null; }
}

/** Saves a setting on this device and, when signed in, to the account. */
export function writeSyncedSetting(name: SyncedSetting, value: string) {
  try { localStorage.setItem(name, value); } catch { /* Private windows keep it for this page only. */ }
  if (!sync || sync.stopped || !sync.account) return;
  if (sync.account[name] === value) { sync.dirty.delete(name); return; }
  sync.dirty.add(name);
  scheduleSend();
}

/** True once the account's settings have been read (or there is no account to read). */
export function interfaceSettingsLoaded(): boolean {
  return !sync || sync.loaded;
}

/** Called once each time the account's settings have been read and applied. */
export function onInterfaceSettingsLoaded(listener: () => void): () => void {
  loadedListeners.add(listener);
  return () => loadedListeners.delete(listener);
}

function scheduleSend() {
  if (!sync || sync.timer) return;
  sync.timer = setTimeout(() => { if (sync) { sync.timer = null; void send(sync); } }, SEND_DELAY_MS);
}

async function send(state: SyncState) {
  if (state.stopped || !state.account || !state.dirty.size) return;
  const names = [...state.dirty];
  const values = Object.fromEntries(names.map((name) => [name, readLocal(name)]));
  state.dirty.clear();
  try {
    const response = await apiFetch("/api/interface-settings", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "Content-Type": "application/json", "X-Margin-Vault-User": state.userId },
      body: JSON.stringify({ values }),
    });
    if (!response.ok) throw new Error(String(response.status));
    const result = await response.json() as { values?: Record<string, string> };
    if (!state.stopped && result.values) state.account = result.values;
  } catch {
    // Offline or refused: keep the names so the next change or the next read tries again.
    if (!state.stopped) names.forEach((name) => state.dirty.add(name));
  }
}

/** Puts the account's value on this device and tells anything showing it. */
function applyFromAccount(name: SyncedSetting, value: string) {
  const oldValue = readLocal(name);
  if (oldValue === value) return;
  try { localStorage.setItem(name, value); } catch { return; }
  try { window.dispatchEvent(new StorageEvent("storage", { key: name, oldValue, newValue: value })); }
  catch { /* Very old browsers: the setting shows after the next reload. */ }
}

async function read(state: SyncState) {
  state.lastRead = Date.now();
  let values: Record<string, string>;
  try {
    const response = await apiFetch("/api/interface-settings", {
      credentials: "same-origin", cache: "no-store", headers: { "X-Margin-Vault-User": state.userId },
    });
    if (!response.ok) throw new Error(String(response.status));
    values = ((await response.json()) as { values?: Record<string, string> }).values ?? {};
  } catch {
    // No account settings to read (offline, or a server without them): this device's settings stand.
    if (!state.loaded && !state.stopped) { state.loaded = true; loadedListeners.forEach((listener) => listener()); }
    return;
  }
  if (state.stopped) return;
  for (const name of SYNCED_SETTINGS) {
    const value = values[name];
    if (typeof value === "string") {
      // A change made here and not yet sent stays; it goes up next.
      if (!state.dirty.has(name)) applyFromAccount(name, value);
    } else if (readLocal(name) !== null) {
      state.dirty.add(name);
    }
  }
  state.account = values;
  state.loaded = true;
  loadedListeners.forEach((listener) => listener());
  if (state.dirty.size) scheduleSend();
}

/** Starts copying interface settings to and from this account. Returns a stop function. */
export function startInterfaceSettingsSync(userId: string): () => void {
  stopInterfaceSettingsSync();
  const state: SyncState = { userId, account: null, dirty: new Set(), timer: null, lastRead: 0, loaded: false, stopped: false };
  sync = state;
  void read(state);
  const refresh = () => {
    if (document.visibilityState === "visible" && Date.now() - state.lastRead > REFRESH_EVERY_MS) void read(state);
  };
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", refresh);
  return () => {
    window.removeEventListener("focus", refresh);
    document.removeEventListener("visibilitychange", refresh);
    if (sync === state) {
      // Send what's waiting before letting go, so a change just before signing out isn't lost.
      if (state.timer) { clearTimeout(state.timer); state.timer = null; void send(state); }
      state.stopped = true;
      sync = null;
    }
  };
}

function stopInterfaceSettingsSync() {
  if (!sync) return;
  if (sync.timer) clearTimeout(sync.timer);
  sync.stopped = true;
  sync = null;
}

/** Calls `listener` when one of `names` changes in another tab or arrives from the account. */
export function onSyncedSettingChange(names: readonly string[], listener: () => void): () => void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return () => {};
  const handle = (event: StorageEvent) => { if (event.key === null || (isSynced(event.key) && names.includes(event.key))) listener(); };
  window.addEventListener("storage", handle);
  return () => window.removeEventListener("storage", handle);
}
