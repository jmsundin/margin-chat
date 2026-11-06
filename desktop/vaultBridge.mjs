// The main-process end of the vault bridge: owns the vault folder with node:fs
// and answers the renderer's requests (desktop/preload.cjs). The logic lives in
// packages/vault-sync (bridgeService.ts), bundled into vault-sync.bundle.mjs by
// desktop/build.mjs; this file adds what only Electron has: the folder dialog,
// IPC, the file manager, and the windows to tell about folder changes.
import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { createBridgeService, VAULT_BRIDGE_CHANNEL, VAULT_BRIDGE_CHANGED_CHANNEL } from "./vault-sync.bundle.mjs";

/**
 * Starts the bridge. `isAppUrl` keeps requests to the app's own pages, as the
 * permission handlers do. Returns the service, for menus (current folder path).
 */
export async function startVaultBridge({ dataDir, isAppUrl }) {
  const service = await createBridgeService({
    dataDir,
    async pickFolder() {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const options = { properties: ["openDirectory", "createDirectory"], buttonLabel: "Open" };
      const { canceled, filePaths } = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      return canceled || !filePaths.length ? null : filePaths[0];
    },
    showInFolder(absolutePath) { void shell.openPath(absolutePath); },
    sendChange(change) {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(VAULT_BRIDGE_CHANGED_CHANNEL, change);
      }
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
