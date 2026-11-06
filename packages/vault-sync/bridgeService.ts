/**
 * The main-process side of the vault bridge.
 *
 * Owns the vault folder: which folder is connected, which were connected
 * before, and every read and write the renderer asks for, through the native
 * adapter (nodeVaultFs.ts). Everything that arrives is checked here: the folder
 * id must be one this process handed out, the path must be a plain relative
 * path, and the adapter refuses symbolic links, so the renderer cannot reach
 * outside a folder the person chose.
 *
 * Remembered folders live in a small JSON file in the app's data folder, keyed
 * by an id that stays with the folder: the same real path, or the same
 * filesystem identity (device and inode) chosen again at a new path, gets the
 * same id, so the baselines and journal the id keys survive a move. This is the
 * vault identity of the spec's §4.5 for now; a vault id inside workspace.json
 * is a manifest change left for review.
 *
 * Electron-specific pieces (dialogs, IPC registration, opening a folder in the
 * file manager) are injected, so this runs under bun's tests against a real
 * temporary folder.
 */
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isValidBridgePath, VAULT_BRIDGE_PROTOCOL_VERSION, type BridgeEntry, type BridgeFolder, type BridgeFolderChange, type BridgeRef, type BridgeRequestName, type BridgeRequests, type BridgeStat, type BridgeStatus } from "./bridgeProtocol";
import { createEchoSuppressor, hashBytes } from "./echoSuppression";
import { watchVaultFolder, type FolderWatcher } from "./folderWatcher";
import { nodeFolderAvailability, openNodeVaultDirectory, type NodeVaultFsOptions } from "./nodeVaultFs";
import { domError, isDomErrorNamed, type NativeVaultDirectory, type VaultDirectory, type VaultFileHandle } from "./vaultFs";

export interface BridgeServiceDeps {
  /** Where `vault-folders.json` lives: the app's userData. */
  dataDir: string;
  /** Opens the system folder picker; null when cancelled. */
  pickFolder(): Promise<string | null>;
  /** Shows a path in the file manager. */
  showInFolder?(absolutePath: string): void;
  /** Delivers folder changes to the renderer(s). */
  sendChange?(change: BridgeFolderChange): void;
  /** Whether to watch the connected folder (off in tests that don't need it). */
  watch?: boolean;
  now?: () => number;
  randomId?: () => string;
}

interface RememberedFolder extends BridgeFolder {
  /** `${dev}:${ino}` of the folder when last opened, so a moved folder chosen again keeps its id. */
  fileId?: string;
  lastOpened?: number;
}

interface FolderSettings {
  version: 1;
  current: string | null;
  folders: RememberedFolder[];
}

export const FOLDER_SETTINGS_FILE = "vault-folders.json";
const MAX_REMEMBERED = 12;

export interface BridgeService {
  handle<Name extends BridgeRequestName>(name: Name, ...args: BridgeRequests[Name]["args"]): Promise<BridgeRequests[Name]["result"]>;
  /** The current folder's absolute path, for menus. */
  currentPath(): string | null;
  /** Stops watching and forgets open handles. */
  close(): Promise<void>;
}

const fileIdentity = async (absolutePath: string) => {
  const info = await stat(absolutePath);
  return `${info.dev}:${info.ino}`;
};

export async function createBridgeService(deps: BridgeServiceDeps): Promise<BridgeService> {
  const settingsPath = path.join(deps.dataDir, FOLDER_SETTINGS_FILE);
  const now = deps.now ?? (() => Date.now());
  const randomId = deps.randomId ?? (() => crypto.randomUUID());
  let settings = await readSettings(settingsPath);
  /** Folders picked but not connected, and open handles for every folder the renderer may address. */
  const known = new Map<string, BridgeFolder>();
  const open = new Map<string, Promise<NativeVaultDirectory>>();
  const echo = createEchoSuppressor();
  let watcher: FolderWatcher | null = null;
  let watching: string | null = null;

  const adapterOptions: NodeVaultFsOptions = {
    onWritten: (vaultPath, bytes) => { void hashBytes(bytes).then((hash) => echo.expect(vaultPath, hash)).catch(() => undefined); },
    onRemoved: (vaultPath) => echo.expectRemoved(vaultPath),
  };

  function folderById(folderId: string): BridgeFolder {
    const folder = settings.folders.find((entry) => entry.id === folderId) ?? known.get(folderId);
    if (!folder) throw domError("NotFoundError", "That folder is no longer open in Margin Chat.");
    return folder;
  }

  function root(folderId: string): Promise<NativeVaultDirectory> {
    let opening = open.get(folderId);
    if (!opening) {
      const folder = folderById(folderId);
      opening = openNodeVaultDirectory(folder.path, adapterOptions);
      open.set(folderId, opening);
      opening.catch(() => open.delete(folderId));
    }
    return opening;
  }

  async function directoryAt(ref: BridgeRef): Promise<VaultDirectory> {
    checkRef(ref);
    let directory: VaultDirectory = await root(ref.folderId);
    for (const segment of ref.path ? ref.path.split("/") : []) directory = await directory.getDirectoryHandle(segment);
    return directory;
  }

  async function parentAndName(ref: BridgeRef): Promise<[VaultDirectory, string]> {
    checkRef(ref);
    if (!ref.path) throw domError("TypeMismatchError", "The folder itself was named where a file or sub-folder was expected.");
    const segments = ref.path.split("/");
    const name = segments.pop()!;
    return [await directoryAt({ folderId: ref.folderId, path: segments.join("/") }), name];
  }

  async function fileAt(ref: BridgeRef): Promise<VaultFileHandle> {
    const [directory, name] = await parentAndName(ref);
    return directory.getFileHandle(name);
  }

  function checkRef(ref: BridgeRef) {
    if (!ref || typeof ref !== "object" || typeof ref.folderId !== "string" || typeof ref.path !== "string" || !isValidBridgePath(ref.path)) {
      throw domError("TypeMismatchError", "Margin Chat refused an invalid vault path.");
    }
  }

  const status = (): BridgeStatus => {
    const current = settings.folders.find((folder) => folder.id === settings.current) ?? null;
    const folders = [...settings.folders].sort((a, b) => Number(b.id === settings.current) - Number(a.id === settings.current) || (b.lastOpened ?? 0) - (a.lastOpened ?? 0));
    return { protocolVersion: VAULT_BRIDGE_PROTOCOL_VERSION, current: current && publicFolder(current), folders: folders.map(publicFolder) };
  };

  /** A folder picked for a look keeps the id its handles already carry once connected; a known folder keeps its old one. */
  async function remember(absolutePath: string, pickedId?: string): Promise<RememberedFolder> {
    const fileId = await fileIdentity(absolutePath).catch(() => undefined);
    const existing = settings.folders.find((folder) => folder.path === absolutePath)
      ?? (fileId ? settings.folders.find((folder) => folder.fileId === fileId) : undefined);
    const folder: RememberedFolder = existing
      ? { ...existing, path: absolutePath, name: path.basename(absolutePath) || absolutePath, fileId, lastOpened: now() }
      : { id: pickedId && !settings.folders.some((entry) => entry.id === pickedId) ? pickedId : randomId(),
        path: absolutePath, name: path.basename(absolutePath) || absolutePath, fileId, lastOpened: now() };
    const others = settings.folders.filter((entry) => entry.id !== folder.id);
    settings = { ...settings, folders: [folder, ...others].slice(0, MAX_REMEMBERED) };
    return folder;
  }

  async function save() {
    await mkdir(deps.dataDir, { recursive: true });
    const temp = `${settingsPath}.tmp`;
    await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`);
    await rename(temp, settingsPath);
  }

  function startWatching(folder: BridgeFolder | null) {
    if (watcher && watching === folder?.id) return;
    watcher?.close();
    watcher = null;
    watching = null;
    if (!folder || deps.watch === false || !deps.sendChange) return;
    const folderId = folder.id;
    watcher = watchVaultFolder({
      root: folder.path, echo,
      onChanges: (changes) => deps.sendChange?.({ folderId, changes }),
      onError: () => { /* A folder that stops answering is reported by the scan's availability check. */ },
    });
    watching = folderId;
  }

  startWatching(settings.folders.find((folder) => folder.id === settings.current) ?? null);

  const handlers: { [Name in BridgeRequestName]: (...args: BridgeRequests[Name]["args"]) => Promise<BridgeRequests[Name]["result"]> } = {
    async status() { return status(); },
    async pickFolder() {
      const picked = await deps.pickFolder();
      if (!picked) return null;
      const real = (await openNodeVaultDirectory(picked, adapterOptions)).path;
      const remembered = settings.folders.find((folder) => folder.path === real);
      if (remembered) return publicFolder(remembered);
      const folder: BridgeFolder = { id: randomId(), name: path.basename(real) || real, path: real };
      known.set(folder.id, folder);
      return folder;
    },
    async connect(ref) {
      checkRef(ref);
      const directory = await directoryAt(ref) as NativeVaultDirectory;
      // The folder itself keeps the picked id; a sub-folder (a new vault made inside the pick) gets its own.
      const folder = await remember(directory.path, ref.path ? undefined : ref.folderId);
      settings = { ...settings, current: folder.id };
      await save();
      // The pick itself became a remembered folder; a parent a new vault was made in stays known for the rest of this run.
      if (folder.id === ref.folderId) known.delete(ref.folderId);
      startWatching(folder);
      return status();
    },
    async reconnect(folderId) {
      const folder = settings.folders.find((entry) => entry.id === folderId);
      if (!folder) return null;
      return publicFolder(folder);
    },
    async disconnect() {
      settings = { ...settings, current: null };
      await save();
      startWatching(null);
      return status();
    },
    async availability(folderId) {
      const folder = settings.folders.find((entry) => entry.id === folderId) ?? known.get(folderId);
      if (!folder) return "missing";
      const availability = await nodeFolderAvailability(folder.path);
      // A folder that went away and came back is opened afresh.
      if (availability !== "available") open.delete(folderId);
      return availability;
    },
    async showFolder(ref) {
      const directory = await directoryAt(ref) as NativeVaultDirectory;
      deps.showInFolder?.(directory.path);
    },
    async list(ref) {
      const directory = await directoryAt(ref);
      const entries: BridgeEntry[] = [];
      for await (const [name, handle] of directory.entries()) entries.push({ name, kind: handle.kind });
      return entries;
    },
    async kind(ref) {
      const [directory, name] = await parentAndName(ref);
      try { await directory.getFileHandle(name); return "file"; }
      catch (error) {
        if (isDomErrorNamed(error, "TypeMismatchError")) return "directory";
        if (isDomErrorNamed(error, "NotFoundError")) return null;
        throw error;
      }
    },
    async stat(ref) {
      const snapshot = await (await fileAt(ref)).getFile();
      return { size: snapshot.size, lastModified: snapshot.lastModified };
    },
    async read(ref, expected) {
      const snapshot = await (await fileAt(ref)).getFile();
      if (expected && (expected.size !== snapshot.size || expected.lastModified !== snapshot.lastModified)) {
        throw domError("InvalidStateError", `“${snapshot.name}” changed since it was looked at.`);
      }
      return new Uint8Array(await snapshot.arrayBuffer());
    },
    async write(ref, bytes) {
      if (!(bytes instanceof Uint8Array)) throw domError("TypeMismatchError", "Only bytes can be written to a vault file.");
      checkRef(ref);
      if (!ref.path) throw domError("TypeMismatchError", "A folder can't be written as a file.");
      const segments = ref.path.split("/");
      const name = segments.pop()!;
      let directory: VaultDirectory = await root(ref.folderId);
      for (const segment of segments) directory = await directory.getDirectoryHandle(segment, { create: true });
      const handle = await directory.getFileHandle(name, { create: true });
      const writer = await handle.createWritable();
      try { await writer.write(bytes); await writer.close(); }
      catch (error) { await writer.abort().catch(() => undefined); throw error; }
      const snapshot = await handle.getFile();
      return { size: snapshot.size, lastModified: snapshot.lastModified } satisfies BridgeStat;
    },
    async createFile(ref) {
      const [directory, name] = await parentAndName(ref);
      await directory.getFileHandle(name, { create: true });
    },
    async createDirectory(ref) {
      const [directory, name] = await parentAndName(ref);
      await directory.getDirectoryHandle(name, { create: true });
    },
    async remove(ref, recursive) {
      const [directory, name] = await parentAndName(ref);
      await directory.removeEntry(name, { recursive: recursive === true });
    },
  };

  return {
    handle(name, ...args) {
      const handler = handlers[name] as ((...handlerArgs: unknown[]) => Promise<unknown>) | undefined;
      if (!handler) return Promise.reject(domError("NotAllowedError", `Unknown vault request: ${String(name)}`));
      return handler(...args) as Promise<BridgeRequests[typeof name]["result"]>;
    },
    currentPath() { return settings.folders.find((folder) => folder.id === settings.current)?.path ?? null; },
    async close() { watcher?.close(); watcher = null; open.clear(); },
  };
}

const publicFolder = ({ id, name, path: folderPath }: BridgeFolder): BridgeFolder => ({ id, name, path: folderPath });

async function readSettings(settingsPath: string): Promise<FolderSettings> {
  const empty: FolderSettings = { version: 1, current: null, folders: [] };
  let text: string;
  try { text = await readFile(settingsPath, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty; throw error; }
  try {
    const parsed = JSON.parse(text) as Partial<FolderSettings>;
    if (parsed?.version !== 1 || !Array.isArray(parsed.folders)) return empty;
    const folders = parsed.folders.filter((folder): folder is RememberedFolder => !!folder && typeof folder.id === "string" && typeof folder.path === "string" && path.isAbsolute(folder.path))
      .map((folder) => ({ ...folder, name: path.basename(folder.path) || folder.path }));
    return { version: 1, current: typeof parsed.current === "string" && folders.some((folder) => folder.id === parsed.current) ? parsed.current : null, folders };
  } catch {
    // Unreadable settings forget the folders rather than refuse to start; the person chooses again.
    return empty;
  }
}
