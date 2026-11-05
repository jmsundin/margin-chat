// The main-process side of the vault bridge (preload.cjs). The page asks by folder ID and
// vault-relative path; this checks the request came from the app's own page, finds the folder
// among those the person chose, and answers with { ok, value } or { ok: false, error }, so an
// error keeps its name ("NotFoundError" and so on) across the process boundary.

import { createVaultWatcher } from "./vaultWatcher.mjs";

export const VAULT_CHANNEL = "margin-vault";
/** Where the page hears which paths changed in a folder it watches: { id, paths } (paths null: look at everything). */
export const VAULT_CHANGED_CHANNEL = "margin-vault-changed";
/** What the page can call; preload.cjs exposes the same list. */
export const VAULT_OPERATIONS = ["selection", "choose", "createVault", "connect", "forget", "list", "stat", "read", "writeAtomic", "move", "delete", "availability", "watch", "unwatch",
  "syncStatus", "syncStart", "syncControl"];
/** Operations that change the folder's files; the app's sync takes them to the cloud. */
const FOLDER_WRITES = new Set(["writeAtomic", "move", "delete"]);

function serializeError(error) {
  if (!error || typeof error !== "object") return { name: "Error", message: String(error) };
  return {
    name: typeof error.name === "string" ? error.name : "Error",
    message: typeof error.message === "string" ? error.message : "The vault folder couldn't be used.",
    ...(error.folder ? { folder: error.folder } : {}),
  };
}

/**
 * Answers one vault request.
 * @param {ReturnType<import("./vaultFolders.mjs").createVaultFolders>} folders
 */
export async function answerVaultRequest(folders, operation, args) {
  try {
    if (!VAULT_OPERATIONS.includes(operation) || !Array.isArray(args)) throw new TypeError("Unknown vault request.");
    switch (operation) {
      case "selection": return { ok: true, value: await folders.selection(args[0]) };
      case "choose": return { ok: true, value: await folders.choose() };
      case "createVault": return { ok: true, value: await folders.createVault(args[0]) };
      case "connect": return { ok: true, value: await folders.connect(args[0], args[1]) };
      case "forget": return { ok: true, value: await folders.forget(args[0]) };
      default: break;
    }
    const [id, ...rest] = args;
    const fs = typeof id === "string" ? await folders.fs(id) : null;
    if (!fs) throw Object.assign(new Error("Choose the vault folder again."), { name: "NotFoundError" });
    switch (operation) {
      case "list": {
        // Files come with their size and time, so a scan needs one request per folder, not one per file.
        const entries = [];
        for await (const entry of fs.list(rest[0])) {
          if (entry.kind !== "file") { entries.push(entry); continue; }
          const childPath = rest[0] ? `${rest[0]}/${entry.name}` : entry.name;
          const stat = await fs.stat(childPath).catch(() => null);
          if (stat) entries.push({ ...entry, ...stat });
        }
        return { ok: true, value: entries };
      }
      case "stat": return { ok: true, value: await fs.stat(rest[0]) };
      case "read": return { ok: true, value: await fs.read(rest[0]) };
      case "writeAtomic": {
        const contents = rest[1];
        if (typeof contents !== "string" && !(contents instanceof Uint8Array)) throw new TypeError("A file's contents must be text or bytes.");
        return { ok: true, value: await fs.writeAtomic(rest[0], contents) };
      }
      case "move": return { ok: true, value: await fs.move(rest[0], rest[1]) };
      case "delete": return { ok: true, value: await fs.delete(rest[0]) };
      case "availability": return { ok: true, value: await fs.availability() };
      default: throw new TypeError("Unknown vault request.");
    }
  } catch (error) {
    return { ok: false, error: serializeError(error) };
  }
}

/**
 * Keeps the folder watchers each page asked for: one per page and folder, stopped when the page
 * asks, reloads or closes. Changes the app made itself aren't reported back.
 */
export function createVaultWatchers({ folders, watcherOptions = {} }) {
  const watching = new Map();
  const key = (sender, id) => `${sender.id}\u0000${id}`;
  return {
    async watch(sender, id) {
      const fs = typeof id === "string" ? await folders.fs(id) : null;
      if (!fs) throw Object.assign(new Error("Choose the vault folder again."), { name: "NotFoundError" });
      const existing = watching.get(key(sender, id));
      if (existing?.root === fs.root) return { active: existing.watcher.active };
      existing?.watcher.close();
      const watcher = createVaultWatcher({
        root: fs.root,
        isOwnChange: (relativePath, stat) => fs.isOwnChange?.(relativePath, stat) ?? false,
        onChange: (paths) => { if (!sender.isDestroyed?.()) sender.send(VAULT_CHANGED_CHANNEL, { id, paths }); },
        ...watcherOptions,
      });
      watching.set(key(sender, id), { root: fs.root, watcher, sender });
      // A reload or a closed window stops its watchers.
      if (!existing) sender.once?.("destroyed", () => this.unwatchAll(sender));
      await watcher.started;
      return { active: watcher.active };
    },
    unwatch(sender, id) {
      watching.get(key(sender, id))?.watcher.close();
      watching.delete(key(sender, id));
    },
    /** Tells every page watching `id` which paths changed, such as after the app's sync wrote them. */
    broadcast(id, paths) {
      for (const [entry, value] of watching) {
        if (!entry.endsWith(`\u0000${id}`) || value.sender.isDestroyed?.()) continue;
        value.sender.send(VAULT_CHANGED_CHANNEL, { id, paths });
      }
    },
    unwatchAll(sender) {
      for (const [entry, value] of watching) if (entry.startsWith(`${sender.id}\u0000`)) { value.watcher.close(); watching.delete(entry); }
    },
    closeAll() {
      for (const value of watching.values()) value.watcher.close();
      watching.clear();
    },
  };
}

/** Registers the bridge's handler; only the app's own pages get answers. */
export function registerVaultBridge({ ipcMain, folders, isAppUrl, watchers = createVaultWatchers({ folders }), sync = null }) {
  ipcMain.handle(VAULT_CHANNEL, async (event, operation, args) => {
    const url = event.senderFrame?.url ?? "";
    if (!isAppUrl(url)) return { ok: false, error: { name: "NotAllowedError", message: "Only Margin Chat's own pages can use the vault folder." } };
    if (operation === "syncStatus" || operation === "syncStart" || operation === "syncControl") {
      try {
        const [userId, folderId, action] = Array.isArray(args) ? args : [];
        // An app without its own sync answers like one that never synced, and the page keeps syncing itself.
        if (!sync) return operation === "syncStatus" ? { ok: true, value: null } : { ok: false, error: { name: "NotSupportedError", message: "This copy of the app can't sync on its own." } };
        if (operation === "syncStatus") return { ok: true, value: await sync.status(userId, folderId) };
        if (operation === "syncStart") return { ok: true, value: await sync.start(userId, folderId) };
        return { ok: true, value: await sync.control(userId, folderId, action) };
      } catch (error) {
        return { ok: false, error: serializeError(error) };
      }
    }
    if (operation === "watch" || operation === "unwatch") {
      try {
        const id = Array.isArray(args) ? args[0] : undefined;
        if (operation === "unwatch") { watchers.unwatch(event.sender, id); return { ok: true, value: undefined }; }
        return { ok: true, value: await watchers.watch(event.sender, id) };
      } catch (error) {
        return { ok: false, error: serializeError(error) };
      }
    }
    const answer = await answerVaultRequest(folders, operation, args);
    if (answer.ok && Array.isArray(args)) {
      if (FOLDER_WRITES.has(operation)) sync?.folderChanged(args[0]);
      if (operation === "forget") sync?.stop(args[0]);
      if (operation === "connect") sync?.connected(args[0], args[1]);
    }
    return answer;
  });
  return watchers;
}
