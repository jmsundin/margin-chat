// Runs before the page in its sandbox (CommonJS: sandboxed preloads can't load modules). It
// exposes only the vault bridge; every request is checked and answered in the main process
// (vaultBridge.mjs), and nothing of Node or Electron reaches the page.
const { contextBridge, ipcRenderer } = require("electron");

const CHANNEL = "margin-vault";
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
  }),
});
