// Runs before the page in its sandbox (CommonJS: sandboxed preloads can't load modules). It
// exposes only the vault bridge; every request is checked and answered in the main process
// (vaultBridge.mjs), and nothing of Node or Electron reaches the page.
const { contextBridge, ipcRenderer } = require("electron");

const CHANNEL = "margin-vault";
const CHANGED_CHANNEL = "margin-vault-changed";
const SYNC_CHANNEL = "margin-vault-sync";
const call = (operation) => (...args) => ipcRenderer.invoke(CHANNEL, operation, args);

contextBridge.exposeInMainWorld("marginDesktop", {
  vault: Object.freeze({
    version: 1,
    selection: call("selection"),
    choose: call("choose"),
    createVault: call("createVault"),
    connect: call("connect"),
    forget: call("forget"),
    list: call("list"),
    stat: call("stat"),
    read: call("read"),
    writeAtomic: call("writeAtomic"),
    move: call("move"),
    delete: call("delete"),
    availability: call("availability"),
    watch: call("watch"),
    unwatch: call("unwatch"),
    syncStatus: call("syncStatus"),
    syncStart: call("syncStart"),
    syncControl: call("syncControl"),
    /** Calls `listener({ id, paths })` when a watched folder changes; returns a function that stops. */
    onChange(listener) {
      const forward = (_event, change) => listener(change);
      ipcRenderer.on(CHANGED_CHANNEL, forward);
      return () => ipcRenderer.removeListener(CHANGED_CHANNEL, forward);
    },
    /** Calls `listener(status)` whenever the app's own vault sync changes state; returns a function that stops. */
    onSyncStatus(listener) {
      const forward = (_event, status) => listener(status);
      ipcRenderer.on(SYNC_CHANNEL, forward);
      return () => ipcRenderer.removeListener(SYNC_CHANNEL, forward);
    },
  }),
});
