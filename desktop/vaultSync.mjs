// Runs the desktop app's vault sync (vaultSyncEngine.mjs, built from desktop/sync) for the folder the
// signed-in account chose, one folder at a time. The page asks for it once it has synced the folder
// itself; from then on the app keeps the folder and the cloud vault in step, through page reloads and
// with the window in the background, and the page only reads and writes the folder.
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { createVaultWatcher } from "./vaultWatcher.mjs";

/** Where the page hears sync status: a DesktopSyncStatus (desktop/sync/vaultSyncDaemon.ts). */
export const VAULT_SYNC_CHANNEL = "margin-vault-sync";
export const SYNC_ACTIONS = ["syncNow", "pause", "resume", "restore", "delete", "openFolder"];

function namedError(name, message) {
  return Object.assign(new Error(message), { name });
}

/** Each account's sync state goes in its own folder, named by a hash so the account ID isn't on disk as a name. */
function accountFolder(userId) {
  return createHash("sha256").update(String(userId)).digest("hex").slice(0, 32);
}

function validUserId(userId) {
  return typeof userId === "string" && userId.length > 0 && userId.length <= 200;
}

/**
 * @param {{
 *   folders: ReturnType<import("./vaultFolders.mjs").createVaultFolders>,
 *   loadEngine: () => Promise<{ createDesktopVaultSync: Function } | null>,
 *   stateRoot: string,
 *   fetch: typeof fetch,
 *   serverUrl: string,
 *   broadcast: (channel: string, payload: unknown) => void,
 *   folderWritten?: (folderId: string, paths: string[] | null) => void,
 *   openPath?: (folderPath: string) => Promise<unknown>,
 *   watcherOptions?: object,
 * }} options
 */
export function createVaultSyncManager({ folders, loadEngine, stateRoot, fetch, serverUrl, broadcast, folderWritten = () => {}, openPath = async () => {}, watcherOptions = {} }) {
  let current = null;
  let focused = true;
  let suspended = false;

  function stateDirectory(userId, folderId) {
    return path.join(stateRoot, accountFolder(userId), folderId);
  }

  async function currentFolder(userId, folderId) {
    if (!validUserId(userId) || typeof folderId !== "string") throw new TypeError("Unknown vault folder.");
    // Only the account's own current folder syncs: one it chose here, never one handed out to another account.
    const selection = await folders.selection(userId);
    if (selection.current?.id !== folderId) throw namedError("NotFoundError", "Choose the vault folder again.");
    const fs = await folders.fs(folderId);
    if (!fs) throw namedError("NotFoundError", "Choose the vault folder again.");
    return { folder: selection.current, fs };
  }

  function stopCurrent() {
    if (!current) return;
    current.sync.stop();
    current.watcher.close();
    current = null;
  }

  return {
    /** The running sync's status, or whether this account handed this folder over before (null: never). */
    async status(userId, folderId) {
      if (current && current.userId === userId && current.folderId === folderId) return current.sync.status();
      if (!validUserId(userId) || typeof folderId !== "string" || !/^[0-9a-f-]{1,64}$/iu.test(folderId)) return null;
      const known = await stat(stateDirectory(userId, folderId)).then((info) => info.isDirectory(), () => false);
      return known ? { folderId, state: "stopped" } : null;
    },
    /** Starts syncing this account's current folder (stopping any other); answers with its status. */
    async start(userId, folderId) {
      if (current && current.userId === userId && current.folderId === folderId) {
        current.sync.wake();
        return current.sync.status();
      }
      const { folder, fs } = await currentFolder(userId, folderId);
      const engine = await loadEngine();
      if (!engine) throw namedError("NotSupportedError", "This copy of the app can't sync on its own.");
      stopCurrent();
      const sync = engine.createDesktopVaultSync({
        userId,
        folder: { id: folder.id, name: folder.name, fs },
        stateDirectory: stateDirectory(userId, folderId),
        fetch,
        serverUrl,
        onStatus: (status) => broadcast(VAULT_SYNC_CHANNEL, status),
        onFolderWritten: (paths) => folderWritten(folderId, paths),
      });
      // Other apps' changes in the folder; the page's own writes arrive through folderChanged.
      const watcher = createVaultWatcher({ root: fs.root, isOwnChange: fs.isOwnChange, onChange: () => sync.folderChanged(), ...watcherOptions });
      current = { userId, folderId, sync, watcher };
      sync.setFocused(focused);
      if (suspended) sync.suspend();
      sync.start();
      return sync.status();
    },
    async control(userId, folderId, action) {
      if (!SYNC_ACTIONS.includes(action)) throw new TypeError("Unknown sync request.");
      if (!current || current.userId !== userId || current.folderId !== folderId) throw namedError("InvalidStateError", "Sync isn't running for this folder.");
      const { sync } = current;
      switch (action) {
        case "syncNow": await sync.syncNow(); break;
        case "pause": await sync.setPaused(true); break;
        case "resume": await sync.setPaused(false); break;
        case "restore": await sync.resolveHeld("restore"); break;
        case "delete": await sync.resolveHeld("delete"); break;
        case "openFolder": {
          const fs = await folders.fs(folderId);
          if (fs) await openPath(fs.root);
          break;
        }
        default: break;
      }
      return sync.status();
    },
    /** The page wrote to the folder: take its changes to the cloud. */
    folderChanged(folderId) {
      if (current?.folderId === folderId) current.sync.folderChanged();
    },
    /** The account chose another folder: the old one stops syncing until the page hands the new one over. */
    connected(userId, folderId) {
      if (current && current.userId === userId && current.folderId !== folderId) stopCurrent();
    },
    /** The account stopped using its folder here (or signed out of it). */
    stop(userId) {
      if (current && (userId === undefined || current.userId === userId)) stopCurrent();
    },
    setFocused(value) {
      focused = value;
      current?.sync.setFocused(value);
    },
    /** Waking from sleep, or the network coming back. */
    wake() { current?.sync.wake(); },
    /** No window is open while the app keeps running (macOS): sync waits until one opens. */
    suspend() { suspended = true; current?.sync.suspend(); },
    resume() { suspended = false; current?.sync.resume(); },
    /** For tests: the running sync. */
    get running() { return current?.sync ?? null; },
    closeAll: stopCurrent,
  };
}
