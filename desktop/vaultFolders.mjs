// Which vault folder each signed-in account uses on this computer, remembered in the app's
// own data (not in the folder, not in the page). The page refers to folders only by the IDs
// handed out here, so it can reach no folder the person didn't choose in a system dialog.
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { nodeVaultFs } from "./vaultFs.mjs";

const STATE_VERSION = 1;
/** Files the system adds to folders by itself; a folder holding only these is still empty. */
const SYSTEM_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

function emptyState() {
  return { version: STATE_VERSION, accounts: {} };
}

/** The name for a new vault folder, or an error saying why it can't be used (the page checks the same rules first). */
export function vaultFolderName(name) {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) throw new Error("Give your vault a name.");
  // eslint-disable-next-line no-control-regex
  if (/[\\/:*?"<>|\u0000-\u001f]/u.test(trimmed)) throw new Error("A vault name can’t contain / \\ : * ? \" < > or |.");
  if (trimmed.startsWith(".") || trimmed.endsWith(".")) throw new Error("A vault name can’t start or end with a dot.");
  if (/^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/iu.test(trimmed)) throw new Error(`“${trimmed}” can’t be used as a folder name. Choose another name.`);
  if (trimmed.length > 100) throw new Error("Choose a shorter name for your vault.");
  return trimmed;
}

/** An error the page can tell apart by name. */
function namedError(name, message, extra = {}) {
  return Object.assign(new Error(message), { name, ...extra });
}

/**
 * @param {{
 *   statePath: string,
 *   chooseFolder: (options: { title: string, defaultPath?: string }) => Promise<string | null>,
 *   defaultLocation?: () => string,
 *   platform?: string,
 * }} options
 */
export function createVaultFolders({ statePath, chooseFolder, defaultLocation = () => undefined, platform = process.platform }) {
  let state = null;
  let saving = Promise.resolve();
  // Folders chosen in a dialog this session but not connected yet, by ID.
  const chosen = new Map();
  const adapters = new Map();

  async function load() {
    if (state) return state;
    try {
      const parsed = JSON.parse(await readFile(statePath, "utf8"));
      state = parsed?.version === STATE_VERSION && parsed.accounts && typeof parsed.accounts === "object" ? parsed : emptyState();
    } catch {
      state = emptyState();
    }
    return state;
  }

  function save() {
    const snapshot = `${JSON.stringify(state, null, 2)}\n`;
    saving = saving.then(async () => {
      await mkdir(path.dirname(statePath), { recursive: true });
      const temporary = `${statePath}.${process.pid}.tmp`;
      await writeFile(temporary, snapshot);
      await rename(temporary, statePath);
    });
    return saving;
  }

  const account = (userId) => {
    if (typeof userId !== "string" || !userId) throw new TypeError("An account is needed to remember its vault folder.");
    return (state.accounts[userId] ??= { current: null, folders: [] });
  };
  const describe = (folder) => ({ id: folder.id, name: folder.name });

  async function identity(folderPath) {
    const info = await stat(folderPath);
    if (!info.isDirectory()) throw namedError("TypeMismatchError", `“${path.basename(folderPath)}” isn’t a folder.`);
    return { dev: info.dev, ino: info.ino };
  }

  /** Every folder ID known now: remembered by any account on this computer, or chosen this session. */
  function known(id) {
    if (chosen.has(id)) return chosen.get(id);
    for (const record of Object.values(state.accounts)) {
      const folder = record.folders.find((candidate) => candidate.id === id);
      if (folder) return folder;
    }
    return null;
  }

  /**
   * A folder the person just chose. A folder remembered before keeps its ID, even if it was
   * renamed or moved since (the same folder on disk), so its saved baseline still applies.
   */
  async function offer(folderPath) {
    await load();
    const absolute = path.resolve(folderPath);
    const { dev, ino } = await identity(absolute);
    let folder = null;
    for (const record of Object.values(state.accounts)) {
      folder ??= record.folders.find((candidate) => candidate.path === absolute)
        ?? record.folders.find((candidate) => candidate.dev === dev && candidate.ino === ino) ?? null;
    }
    folder = folder ? { ...folder, path: absolute, name: path.basename(absolute), dev, ino }
      : { id: randomUUID(), path: absolute, name: path.basename(absolute), dev, ino };
    chosen.set(folder.id, folder);
    adapters.delete(folder.id);
    return describe(folder);
  }

  return {
    async selection(userId) {
      await load();
      const record = state.accounts[userId];
      if (!record) return { current: null, folders: [] };
      const current = record.folders.find((folder) => folder.id === record.current) ?? null;
      return { current: current ? describe(current) : null, folders: record.folders.map(describe) };
    },
    /** Shows the system's folder dialog. Null when it was closed without choosing. */
    async choose() {
      const folderPath = await chooseFolder({ title: "Open a vault folder" });
      return folderPath ? offer(folderPath) : null;
    },
    /**
     * Asks where a new vault goes and makes a folder named `name` there. An empty folder with
     * that name is used as it is; one holding files is refused with VaultFolderExistsError and
     * offered (`folder`) so the page can open it instead.
     */
    async createVault(name) {
      const folderName = vaultFolderName(name);
      const parent = await chooseFolder({ title: `Choose where to put “${folderName}”`, defaultPath: defaultLocation() });
      if (!parent) return null;
      const target = path.join(parent, folderName);
      let entries = null;
      try {
        entries = await readdir(target);
      } catch (error) {
        if (error?.code === "ENOTDIR") throw new Error(`There’s already a file named “${folderName}” there. Choose another name.`);
        if (error?.code !== "ENOENT") throw error;
      }
      if (entries === null) await mkdir(target);
      else if (entries.some((entry) => !SYSTEM_FILES.has(entry))) {
        throw namedError("VaultFolderExistsError",
          `There’s already a folder named “${folderName}” there, and it has files in it. Open it instead, or choose another name.`,
          { folder: await offer(target) });
      }
      return offer(target);
    },
    /** Makes a chosen or remembered folder this account's vault folder. */
    async connect(userId, id) {
      await load();
      const folder = known(id);
      if (!folder) throw namedError("NotFoundError", "Choose the folder again.");
      const record = account(userId);
      record.folders = [...record.folders.filter((candidate) => candidate.id !== id), { id: folder.id, path: folder.path, name: folder.name, dev: folder.dev, ino: folder.ino }];
      record.current = id;
      chosen.delete(id);
      await save();
      return describe(folder);
    },
    /** Forgets this account's folders on this computer; nothing in them changes. */
    async forget(userId) {
      await load();
      delete state.accounts[userId];
      await save();
    },
    /** The folder's files, for a folder ID handed out here; null for any other ID. */
    async fs(id) {
      await load();
      const folder = known(id);
      if (!folder) return null;
      let adapter = adapters.get(id);
      if (!adapter || adapter.root !== folder.path) {
        adapter = nodeVaultFs(folder.path, { name: folder.name, platform });
        adapters.set(id, adapter);
      }
      return adapter;
    },
  };
}
