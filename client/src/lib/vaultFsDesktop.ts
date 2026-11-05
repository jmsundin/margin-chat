import { assertVaultFsPath, joinVaultFsPath, type VaultFs, type VaultFsStat } from "@margin-chat/vault-sync";

/** A vault folder the desktop app handed out: the page knows it only by ID and name. */
export interface DesktopVaultFolder {
  id: string;
  name: string;
}

type Answer<T> = { ok: true; value: T } | { ok: false; error: { name: string; message: string; folder?: DesktopVaultFolder } };
type Listed = { name: string; kind: "file" | "directory"; size?: number; modifiedMs?: number };

export type DesktopSyncState = "starting" | "syncing" | "synced" | "offline" | "paused" | "attention";

/** What the desktop app's own vault sync reports (desktop/sync/vaultSyncDaemon.ts). */
export interface DesktopSyncStatus {
  folderId: string;
  folderName: string;
  folderPath: string;
  state: DesktopSyncState;
  /** When the folder and the cloud last matched, in milliseconds. */
  lastSyncedAt: number | null;
  /** Files changed on this computer that the cloud doesn't have yet. */
  pending: number;
  paused: boolean;
  /** Why sync needs the person, in the app's own words. */
  attention?: { reason: "held" | "missing" | "signed-out" | "failing"; message: string; held?: { folderName: string; paths: string[] } };
  /** Why the last attempt didn't finish, while it will retry by itself. */
  message?: string;
}

export type DesktopSyncAction = "syncNow" | "pause" | "resume" | "restore" | "delete" | "openFolder";

/** What desktop/preload.cjs exposes as window.marginDesktop.vault. */
export interface DesktopVaultBridge {
  version: number;
  selection(userId: string): Promise<Answer<{ current: DesktopVaultFolder | null; folders: DesktopVaultFolder[] }>>;
  choose(): Promise<Answer<DesktopVaultFolder | null>>;
  createVault(name: string): Promise<Answer<DesktopVaultFolder | null>>;
  connect(userId: string, id: string): Promise<Answer<DesktopVaultFolder>>;
  forget(userId: string): Promise<Answer<void>>;
  list(id: string, directory: string): Promise<Answer<Listed[]>>;
  stat(id: string, path: string): Promise<Answer<VaultFsStat | null>>;
  read(id: string, path: string): Promise<Answer<{ bytes: Uint8Array; stat: VaultFsStat } | null>>;
  writeAtomic(id: string, path: string, contents: Uint8Array | string): Promise<Answer<void>>;
  move(id: string, from: string, to: string): Promise<Answer<void>>;
  delete(id: string, path: string): Promise<Answer<void>>;
  availability(id: string): Promise<Answer<"available" | "missing" | "refused">>;
  /** Newer apps watch the folder themselves (phase 2). */
  watch?(id: string): Promise<Answer<{ active: boolean }>>;
  unwatch?(id: string): Promise<Answer<void>>;
  onChange?(listener: (change: { id: string; paths: string[] | null }) => void): () => void;
  /**
   * Newer apps keep the folder and the cloud in step themselves (phase 3). Status is null for a folder this
   * account never handed over, and { state: "stopped" } for one handed over before that isn't running now.
   */
  syncStatus?(userId: string, folderId: string): Promise<Answer<DesktopSyncStatus | { folderId: string; state: "stopped" } | null>>;
  syncStart?(userId: string, folderId: string): Promise<Answer<DesktopSyncStatus>>;
  syncControl?(userId: string, folderId: string, action: DesktopSyncAction): Promise<Answer<DesktopSyncStatus>>;
  onSyncStatus?(listener: (status: DesktopSyncStatus) => void): () => void;
  /** Newer apps (phase 4): shows a vault file selected in Finder or Explorer; "" or a missing file opens the folder. */
  reveal?(id: string, path: string): Promise<Answer<"file" | "folder">>;
}

/** What the computer's file manager is called, for "Show in Finder" and the like. */
export function fileManagerName(platform = typeof navigator === "undefined" ? "" : navigator.platform || navigator.userAgent) {
  return /mac/i.test(platform) ? "Finder" : /win/i.test(platform) ? "Explorer" : "Files";
}

/** The desktop app's bridge when it syncs the vault itself; null in browsers and older apps. */
export function desktopSyncBridge(): (DesktopVaultBridge & Required<Pick<DesktopVaultBridge, "syncStatus" | "syncStart" | "syncControl" | "onSyncStatus">>) | null {
  const bridge = desktopVaultBridge();
  return bridge && typeof bridge.syncStart === "function" && typeof bridge.syncStatus === "function"
    && typeof bridge.syncControl === "function" && typeof bridge.onSyncStatus === "function" ? bridge as never : null;
}

/**
 * The desktop app's own vault folder, when this app offers one (newer desktop apps started
 * with the native vault on). Older apps, and every browser, have none: the page then uses
 * the browser's folder access as before. The page updates separately from the app, so this
 * is checked, never assumed.
 */
export function desktopVaultBridge(): DesktopVaultBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as { marginDesktop?: { vault?: DesktopVaultBridge } }).marginDesktop?.vault;
  return bridge && bridge.version >= 1 && typeof bridge.list === "function" ? bridge : null;
}

/** An error that came back from the desktop app, with its name kept. */
export class DesktopVaultError extends Error {
  constructor(name: string, message: string, readonly folder?: DesktopVaultFolder) {
    super(message);
    this.name = name;
  }
}

export async function unwrap<T>(answer: Promise<Answer<T>>): Promise<T> {
  const result = await answer;
  if (result.ok) return result.value;
  throw new DesktopVaultError(result.error.name, result.error.message, result.error.folder);
}

/** A desktop folder as a VaultFs; `folderId` tells it apart from a browser folder. */
export type DesktopVaultFs = VaultFs & {
  readonly folderId: string;
  /** True while the app is watching this folder for the page; the page's own checks are then only a backstop. */
  readonly watchActive: boolean;
};

export function isDesktopVaultFs(folder: unknown): folder is DesktopVaultFs {
  return !!folder && typeof folder === "object" && typeof (folder as Partial<DesktopVaultFs>).folderId === "string";
}

/** How long sizes and times from a listing answer the stats a scan asks for right after. */
const LISTED_STAT_MS = 1_000;

/**
 * A folder the desktop app reads and writes for the page. A listing brings each file's size
 * and time with it, so a scan costs one request per folder rather than one per file; those
 * stats answer for a moment, and anything this page writes is asked about again.
 */
export function desktopVaultFs(bridge: DesktopVaultBridge, folder: DesktopVaultFolder): DesktopVaultFs {
  const listed = new Map<string, { stat: VaultFsStat; at: number }>();
  const forget = (...paths: string[]) => { for (const path of paths) listed.delete(path); };
  let watchActive = false;
  return {
    folderId: folder.id,
    get watchActive() { return watchActive; },
    name: folder.name,
    async *list(directory) {
      assertVaultFsPath(directory, true);
      const entries = await unwrap(bridge.list(folder.id, directory));
      const at = Date.now();
      for (const entry of entries) {
        if (entry.kind === "file" && typeof entry.size === "number" && typeof entry.modifiedMs === "number") {
          listed.set(joinVaultFsPath(directory, entry.name), { stat: { size: entry.size, modifiedMs: entry.modifiedMs }, at });
        }
        yield { name: entry.name, kind: entry.kind };
      }
    },
    async stat(path) {
      assertVaultFsPath(path);
      const recent = listed.get(path);
      if (recent && Date.now() - recent.at < LISTED_STAT_MS) return recent.stat;
      return unwrap(bridge.stat(folder.id, path));
    },
    async read(path) {
      assertVaultFsPath(path);
      const read = await unwrap(bridge.read(folder.id, path));
      return read ? { bytes: new Uint8Array(read.bytes), stat: read.stat } : null;
    },
    async writeAtomic(path, contents) {
      assertVaultFsPath(path);
      forget(path);
      await unwrap(bridge.writeAtomic(folder.id, path, contents));
    },
    async move(from, to) {
      assertVaultFsPath(from);
      assertVaultFsPath(to);
      forget(from, to);
      await unwrap(bridge.move(folder.id, from, to));
    },
    async delete(path) {
      assertVaultFsPath(path);
      forget(path);
      await unwrap(bridge.delete(folder.id, path));
    },
    async availability() {
      try {
        return await unwrap(bridge.availability(folder.id));
      } catch (error) {
        if (error instanceof DesktopVaultError && error.name === "NotFoundError") return "missing";
        throw error;
      }
    },
    // Apps that watch the folder themselves say which files settled; older ones leave it to the page.
    watch(onChange) {
      if (typeof bridge.watch !== "function" || typeof bridge.onChange !== "function") return null;
      const stopListening = bridge.onChange((change) => {
        if (change?.id !== folder.id) return;
        if (change.paths) forget(...change.paths); else listed.clear();
        // "Look at everything" also follows a folder coming back, so ask again whether it's watched.
        if (!change.paths) void bridge.watch!(folder.id).then((answer) => { watchActive = answer.ok && answer.value.active; }, () => undefined);
        onChange(change.paths);
      });
      void bridge.watch(folder.id).then((answer) => { watchActive = answer.ok && answer.value.active; }, () => undefined);
      return () => {
        watchActive = false;
        stopListening();
        void bridge.unwatch?.(folder.id).catch(() => undefined);
      };
    },
  };
}

