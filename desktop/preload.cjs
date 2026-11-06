// The only script that runs in the renderer with access to Electron's IPC. It
// exposes one small object, window.marginVault, through which the page reads
// and writes its vault folder and talks to the vault the main process runs:
// every call is a request the main process checks (desktop/vaultBridge.mjs).
// The page never gets Node, a path it didn't ask about, or the session cookie.
//
// Sandboxed preload scripts are plain CommonJS with only `electron` to require,
// so this file stays dependency-free and mirrors packages/vault-sync/bridgeProtocol.ts.
const { contextBridge, ipcRenderer } = require("electron");

const PROTOCOL_VERSION = 1;
const CHANNEL = "margin-vault";
const CHANGED_CHANNEL = "margin-vault:changed";
const STATUS_CHANNEL = "margin-vault:status";
const VAULT_CHANGED_CHANNEL = "margin-vault:vault-changed";

function subscribe(channel, listener) {
  const handler = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("marginVault", {
  protocolVersion: PROTOCOL_VERSION,
  request(name, ...args) {
    return ipcRenderer.invoke(CHANNEL, name, ...args);
  },
  onFolderChanged(listener) { return subscribe(CHANGED_CHANNEL, listener); },
  onSyncStatus(listener) { return subscribe(STATUS_CHANNEL, listener); },
  onVaultChanged(listener) { return subscribe(VAULT_CHANGED_CHANNEL, () => listener()); },
});
