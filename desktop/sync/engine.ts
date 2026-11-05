// The desktop app's sync engine, bundled for Node into desktop/vaultSyncEngine.mjs by
// scripts/build-desktop-engine.mjs (the app ships without node_modules).
export { createDesktopVaultSync, FOCUSED_SYNC_MS, BACKGROUND_SYNC_MS, CHANGE_DEBOUNCE_MS, RETRY_FIRST_MS, RETRY_MAX_MS } from "./vaultSyncDaemon";
export type { DesktopSyncStatus, DesktopSyncState, DesktopVaultSync, DesktopSyncOptions } from "./vaultSyncDaemon";
