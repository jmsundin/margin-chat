// The only script that runs in the renderer with access to Electron's IPC. It
// exposes one small object, window.marginVault, through which the page reads
// and writes its vault folder: every call is a request the main process checks
// (desktop/vaultBridge.mjs) and answers from the real folder. The page never
// gets Node, a path it didn't ask about, or the session cookie.
//
// Sandboxed preload scripts are plain CommonJS with only `electron` to require,
// so this file stays dependency-free and mirrors packages/vault-sync/bridgeProtocol.ts.
const { contextBridge, ipcRenderer } = require("electron");

const PROTOCOL_VERSION = 1;
const CHANNEL = "margin-vault";
const CHANGED_CHANNEL = "margin-vault:changed";

contextBridge.exposeInMainWorld("marginVault", {
  protocolVersion: PROTOCOL_VERSION,
  request(name, ...args) {
    return ipcRenderer.invoke(CHANNEL, name, ...args);
  },
  onFolderChanged(listener) {
    const handler = (_event, change) => listener(change);
    ipcRenderer.on(CHANGED_CHANNEL, handler);
    return () => ipcRenderer.removeListener(CHANGED_CHANNEL, handler);
  },
});
