// The main-process end of the vault bridge: owns the vault folder with node:fs,
// runs the vault itself (engine, journal, folder mirror and sync loop), and
// answers the renderer's requests (desktop/preload.cjs). The logic lives in
// packages/vault-sync, bundled into vault-sync.bundle.mjs by desktop/build.mjs;
// this file adds what only Electron has: the folder dialog, IPC, the file
// manager, the session's fetch, and the windows to tell about changes.
import { BrowserWindow, dialog, ipcMain, net, shell } from "electron";
import path from "node:path";
import {
  createBridgeService, createMainTransport, VAULT_BRIDGE_CHANGED_CHANNEL, VAULT_BRIDGE_CHANNEL, VAULT_BRIDGE_STATUS_CHANNEL, VAULT_BRIDGE_VAULT_CHANGED_CHANNEL,
} from "./vault-sync.bundle.mjs";

function broadcast(channel, payload) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

/**
 * Starts the bridge. `isAppUrl` keeps requests to the app's own pages, as the
 * permission handlers do; `apiOrigin` is the backend the session cookie belongs
 * to; `cloudSync` is the renderer's word on the account's plan (it is checked
 * again by the server on every request). Returns the service, for menus.
 */
export async function startVaultBridge({ dataDir, isAppUrl, apiOrigin }) {
  const service = await createBridgeService({
    dataDir,
    async pickFolder() {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const options = { properties: ["openDirectory", "createDirectory"], buttonLabel: "Open" };
      const { canceled, filePaths } = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      return canceled || !filePaths.length ? null : filePaths[0];
    },
    showInFolder(absolutePath, kind) { if (kind === "file") shell.showItemInFolder(absolutePath); else void shell.openPath(absolutePath); },
    sendChange(change) { broadcast(VAULT_BRIDGE_CHANGED_CHANNEL, change); },
    vault: {
      journalRoot: path.join(dataDir, "vaults"),
      // net.fetch uses the default session's cookie jar, so the HttpOnly auth cookie never reaches the renderer.
      transportFor: (userId) => createMainTransport({ fetchImpl: (url, init) => net.fetch(url, init), serverUrl: apiOrigin, userId }),
      sendStatus(status) { broadcast(VAULT_BRIDGE_STATUS_CHANNEL, status); },
      sendVaultChanged() { broadcast(VAULT_BRIDGE_VAULT_CHANGED_CHANNEL, null); },
    },
  });

  ipcMain.handle(VAULT_BRIDGE_CHANNEL, async (event, name, ...args) => {
    // Only the app's own pages may touch the vault; a foreign page in this window gets nothing.
    if (!isAppUrl(event.senderFrame?.url ?? event.sender.getURL())) return failure(new DOMException("Not allowed.", "NotAllowedError"));
    try {
      return await service.handle(name, ...args);
    } catch (error) {
      // Errors cross as data so the renderer can throw the same DOMException by name.
      return failure(error);
    }
  });

  return service;
}

function failure(error) {
  return { error: { name: error?.name ?? "Error", message: error?.message ?? String(error) } };
}
