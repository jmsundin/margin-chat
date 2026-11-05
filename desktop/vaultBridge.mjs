// The main-process side of the vault bridge (preload.cjs). The page asks by folder ID and
// vault-relative path; this checks the request came from the app's own page, finds the folder
// among those the person chose, and answers with { ok, value } or { ok: false, error }, so an
// error keeps its name ("NotFoundError" and so on) across the process boundary.

export const VAULT_CHANNEL = "margin-vault";
/** What the page can call; preload.cjs exposes the same list. */
export const VAULT_OPERATIONS = ["selection", "choose", "createVault", "connect", "forget", "list", "stat", "read", "writeAtomic", "move", "delete", "availability"];

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

/** Registers the bridge's handler; only the app's own pages get answers. */
export function registerVaultBridge({ ipcMain, folders, isAppUrl }) {
  ipcMain.handle(VAULT_CHANNEL, (event, operation, args) => {
    const url = event.senderFrame?.url ?? "";
    if (!isAppUrl(url)) return { ok: false, error: { name: "NotAllowedError", message: "Only Margin Chat's own pages can use the vault folder." } };
    return answerVaultRequest(folders, operation, args);
  });
}
