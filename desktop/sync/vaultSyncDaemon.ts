// Keeps one vault folder and the cloud vault in step from the desktop app's main process, so sync runs
// while the page reloads, crashes or is closed. It uses the page's own sync code (client/src/lib): the same
// folder scan, deletion guard and folder writes as a page with a connected folder, the same engine, merge and
// cloud transport. The page then only reads and writes the folder; this takes the folder to the cloud and back.
// Bundled for Node into desktop/vaultSyncEngine.mjs (scripts/build-desktop-engine.mjs).
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { VaultFs } from "@margin-chat/vault-sync";
import { setApiTransport } from "../../client/src/lib/apiTransport";
import { createVaultTransport } from "../../client/src/lib/vaultApi";
import { createJournalVaultStore } from "../../client/src/lib/vaultLocal";
import { VaultSync, pendingVaultChanges } from "../../client/src/lib/vaultSync";
import type { VaultSnapshot, VaultTransport } from "../../client/src/lib/vaultTypes";
import { FolderDeletionHeldError, type HeldFolderDeletion } from "../../client/src/lib/folderDeletionGuard";
import { FolderChangingError } from "../../client/src/lib/fileSnapshot";
import { FolderUnavailableError, LocalDirectoryConflictError } from "../../client/src/lib/workspaceStorage";
import {
  checkFolderAvailable, folderReadingFromBaseline, scanConnectedFolder, takeInFolderScan, writeVaultToFolder, type FolderReading,
} from "../../client/src/lib/vaultFolderSync";
import type { DesktopSyncStatus } from "../../client/src/lib/vaultFsDesktop";
import { nodeDirectoryHandle } from "./nodeDirectoryHandle";

/** While a window is in front, the cloud is asked for other devices' changes this often. */
export const FOCUSED_SYNC_MS = 15_000;
/** Otherwise this often. */
export const BACKGROUND_SYNC_MS = 60_000;
/** A failed sync is tried again after this, doubling each time up to RETRY_MAX_MS. */
export const RETRY_FIRST_MS = 5_000;
export const RETRY_MAX_MS = 5 * 60_000;
/** Changes in the folder (from the page or another app) wait this long, so a burst syncs once. */
export const CHANGE_DEBOUNCE_MS = 750;
/** Failures in a row before sync says it needs attention rather than "will retry". */
const FAILURES_BEFORE_ATTENTION = 3;

export type { DesktopSyncState, DesktopSyncStatus } from "../../client/src/lib/vaultFsDesktop";

export interface DesktopSyncOptions {
  userId: string;
  folder: { id: string; name: string; fs: VaultFs & { root?: string } };
  /** Where this folder's device copy and sync settings live (inside the app's data folder, never the vault). */
  stateDirectory: string;
  /** Sends a request to the Margin Chat server with this app's sign-in; `input` is an /api path or full URL. */
  fetch: typeof globalThis.fetch;
  /** The server's origin, for the few requests the cloud transport builds as full URLs. */
  serverUrl: string;
  onStatus?(status: DesktopSyncStatus): void;
  /** The folder's files changed because sync wrote them; pages showing the folder should read it again. */
  onFolderWritten?(paths: string[] | null): void;
  /** Overrides for tests. */
  transport?: VaultTransport;
  timers?: { set(handler: () => void, ms: number): unknown; clear(timer: unknown): void };
  now?(): number;
}

type Settings = { paused?: boolean; lastSyncedAt?: number };

async function readSettings(file: string): Promise<Settings> {
  try { return JSON.parse(await readFile(file, "utf8")) as Settings; } catch { return {}; }
}

async function writeSettings(file: string, settings: Settings) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(settings));
  await rename(temporary, file);
}

/** A network failure or a server that is down, rather than something wrong with the vault. */
function isOffline(error: unknown) {
  if (error instanceof TypeError) return true;
  if (error && typeof error === "object" && "name" in error && ["AbortError", "TimeoutError"].includes(String(error.name))) return true;
  const status = error && typeof error === "object" && "statusCode" in error ? Number(error.statusCode) : 0;
  return status >= 500 || /failed to fetch|network|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ERR_INTERNET_DISCONNECTED|ERR_NETWORK/i.test(error instanceof Error ? error.message : "");
}

function isSignedOut(error: unknown) {
  const status = error && typeof error === "object" && "statusCode" in error ? Number(error.statusCode) : 0;
  return status === 401 || status === 403;
}

const routed = new WeakSet<object>();

/**
 * The cloud transport sends a few requests (large file uploads) with the global fetch and a full URL. In the
 * main process that fetch has no sign-in, so requests to the server go through `fetch` like the rest.
 */
function routeServerRequests(fetchWithSignIn: typeof globalThis.fetch, serverUrl: string) {
  const original = globalThis.fetch;
  if (routed.has(original)) return;
  const origin = new URL(serverUrl).origin;
  const fetchRouted = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return url.startsWith(`${origin}/`) || url.startsWith("/") ? fetchWithSignIn(input, init) : original(input, init);
  }) as typeof globalThis.fetch;
  routed.add(fetchRouted);
  globalThis.fetch = fetchRouted;
}

export function createDesktopVaultSync(options: DesktopSyncOptions) {
  const now = options.now ?? (() => Date.now());
  const timers = options.timers ?? { set: (handler: () => void, ms: number) => setTimeout(handler, ms), clear: (timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>) };
  const { fs, id: folderId, name: folderName } = options.folder;
  const folderPath = fs.root ?? folderName;
  const settingsFile = path.join(options.stateDirectory, "sync-settings.json");
  if (!options.transport) {
    setApiTransport({ fetch: options.fetch, serverUrl: options.serverUrl });
    routeServerRequests(options.fetch, options.serverUrl);
  }
  // Only one sync at a time touches this copy; the page's copy is separate.
  let lockTail: Promise<unknown> = Promise.resolve();
  const store = createJournalVaultStore({
    async open() {
      const directory = path.join(options.stateDirectory, "device-copy");
      await mkdir(directory, { recursive: true });
      return nodeDirectoryHandle(directory);
    },
    lock<T>(operation: () => Promise<T>) {
      const result = lockTail.then(operation);
      lockTail = result.then(() => undefined, () => undefined);
      return result;
    },
  });
  const engine = new VaultSync(store, options.transport ?? createVaultTransport(options.userId));

  let settings: Settings = {};
  let reading: FolderReading | null = null;
  let status: DesktopSyncStatus = { folderId, folderName, folderPath, state: "starting", lastSyncedAt: null, pending: 0, paused: false };
  let running: Promise<void> | null = null;
  let again = false;
  let stopped = false;
  let suspended = false;
  let focused = true;
  let timer: unknown = null;
  let failures = 0;
  let signedOut = false;
  /** The person's answer for the held deletion with this key. */
  let heldChoice: { key: string; choice: "restore" | "delete" } | null = null;
  let heldKey: string | null = null;
  let heldPending: HeldFolderDeletion | null = null;

  function publish(next: Partial<DesktopSyncStatus>) {
    status = { ...status, ...next };
    if (!("attention" in next) && next.state && next.state !== "attention") delete status.attention;
    options.onStatus?.(status);
  }

  function schedule(ms: number) {
    if (stopped || suspended) return;
    if (timer !== null) timers.clear(timer);
    timer = timers.set(() => { timer = null; void syncNow("timer"); }, ms);
  }

  function nextRegularSync() {
    schedule(focused ? FOCUSED_SYNC_MS : BACKGROUND_SYNC_MS);
  }

  /** Which folder files differ between two readings, for pages to read again. */
  function changedPaths(before: FolderReading | null, after: FolderReading) {
    if (!before?.workspace || !after.workspace) return null;
    const paths = new Set<string>();
    for (const file of new Set([...Object.keys(before.workspace.files), ...Object.keys(after.workspace.files)])) {
      if (before.workspace.files[file] !== after.workspace.files[file]) paths.add(file);
    }
    for (const file of new Set([...Object.keys(before.companions), ...Object.keys(after.companions)])) {
      const left = before.companions[file];
      const right = after.companions[file];
      if (!left || !right || left.content !== right.content || left.encoding !== right.encoding) paths.add(file);
    }
    return [...paths].sort();
  }

  async function pass() {
    if (!reading) {
      settings = await readSettings(settingsFile);
      reading = folderReadingFromBaseline((await engine.read()).directoryBaselines?.[folderId]);
      publish({ paused: !!settings.paused, lastSyncedAt: settings.lastSyncedAt ?? null });
    }
    const paused = !!settings.paused;
    publish({ state: paused ? "paused" : "syncing" });
    // A folder that can't be opened is never read as an empty one: nothing is taken in, sent or written.
    await checkFolderAvailable(fs, folderName);
    const fresh = !reading.workspace && !(await engine.read()).remoteRevision;
    // This copy has never synced: bring the cloud vault in first, so the folder (which the page kept in
    // step with the cloud until now) is compared with it file by file rather than taken as newer.
    if (fresh && !paused) await engine.sync();
    const scan = await scanConnectedFolder(fs, options.userId, reading);
    reading = await takeInFolderScan(engine, { id: folderId, name: folderName }, reading, scan, {
      choice: (key) => heldChoice?.key === key ? heldChoice.choice : null,
      hold(pending, key) { heldKey = key; heldPending = pending; },
      release() { heldKey = null; heldPending = null; heldChoice = null; },
    });
    let snapshot: VaultSnapshot = paused ? await engine.read() : await engine.sync();
    if (reading.workspace) {
      const before = reading;
      reading = await writeVaultToFolder(engine, fs, folderId, options.userId, snapshot, { ...reading, workspace: reading.workspace });
      const changed = changedPaths(before, reading);
      if (changed === null || changed.length) options.onFolderWritten?.(changed);
    }
    // Copies of documents deleted over 30 days ago are removed; that syncs on the next pass.
    if (await engine.purgeTrash(now()).catch(() => 0)) schedule(CHANGE_DEBOUNCE_MS);
    snapshot = await engine.read();
    const pending = pendingVaultChanges(snapshot).length;
    if (paused) { publish({ state: "paused", pending }); return; }
    settings = { ...settings, lastSyncedAt: now() };
    await writeSettings(settingsFile, settings).catch(() => undefined);
    publish({ state: "synced", pending, lastSyncedAt: settings.lastSyncedAt, message: undefined });
  }

  function failed(error: unknown) {
    const message = error instanceof Error ? error.message : "Your vault could not be synchronized.";
    if (error instanceof FolderDeletionHeldError) {
      publish({ state: "attention", attention: { reason: "held", message, held: heldPending ?? error.held } });
      return null;
    }
    if (error instanceof FolderUnavailableError) {
      publish({ state: "attention", attention: { reason: "missing", message } });
      // Look for it again now and then, such as after its drive is plugged back in.
      return BACKGROUND_SYNC_MS;
    }
    if (isSignedOut(error)) {
      signedOut = true;
      publish({ state: "attention", attention: { reason: "signed-out", message: "Sign in to Margin Chat again to keep your vault in sync. Your files are saved on this computer." } });
      return null;
    }
    failures += 1;
    const retry = Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** (failures - 1));
    // A busy folder, or one changed while being written, is simply read again shortly.
    if (error instanceof FolderChangingError || error instanceof LocalDirectoryConflictError) {
      publish({ state: "syncing", message });
      return Math.min(retry, RETRY_FIRST_MS);
    }
    if (isOffline(error)) {
      publish({ state: "offline", message: "Offline — changes saved locally. Sync will retry when connected." });
      return retry;
    }
    if (failures >= FAILURES_BEFORE_ATTENTION) publish({ state: "attention", attention: { reason: "failing", message } });
    else publish({ state: "syncing", message });
    return retry;
  }

  /** Runs one pass now, or right after the one running. Resolves once the folder and the cloud were compared. */
  function syncNow(_reason: string): Promise<void> {
    if (stopped) return Promise.resolve();
    // The pass that follows the running one is the one that sees this request.
    if (running) { again = true; return running.then(() => running ?? undefined); }
    if (timer !== null) { timers.clear(timer); timer = null; }
    running = (async () => {
      try {
        await pass();
        failures = 0;
        nextRegularSync();
      } catch (error) {
        // What the device copy holds but the cloud doesn't yet, so "Offline" says how much is waiting.
        const pending = await engine.read().then((snapshot) => pendingVaultChanges(snapshot).length, () => status.pending);
        if (pending !== status.pending) status = { ...status, pending };
        const retry = failed(error);
        if (retry !== null) schedule(retry);
      } finally {
        running = null;
        if (again && !stopped) { again = false; void syncNow("again"); }
      }
    })();
    return running;
  }

  /** Changes in the folder: sync once they stop arriving. */
  function folderChanged() {
    if (stopped || signedOut) return;
    if (running) { again = true; return; }
    schedule(CHANGE_DEBOUNCE_MS);
  }

  return {
    folderId,
    userId: options.userId,
    status: () => status,
    /** Starts syncing: the first pass runs straight away. */
    start() { void syncNow("start"); },
    syncNow() { signedOut = false; return syncNow("asked"); },
    folderChanged,
    /** Whether a window is in front; sync asks the cloud more often then. */
    setFocused(value: boolean) {
      if (focused === value) return;
      focused = value;
      if (value) void syncNow("focus");
    },
    /** Waking from sleep or the network coming back: look straight away. */
    wake() { if (!signedOut) void syncNow("wake"); },
    /** No window is open (and the app keeps running): stop until one opens. */
    suspend() { suspended = true; if (timer !== null) { timers.clear(timer); timer = null; } },
    resume() { if (!suspended) return; suspended = false; void syncNow("resume"); },
    async setPaused(paused: boolean) {
      settings = { ...(reading ? settings : await readSettings(settingsFile)), paused };
      await mkdir(options.stateDirectory, { recursive: true });
      await writeSettings(settingsFile, settings);
      publish({ paused, state: paused ? "paused" : "syncing" });
      if (!paused) await syncNow("resumed");
    },
    /** The person's answer to held deletions: put the files back in the folder, or delete them everywhere. */
    resolveHeld(choice: "restore" | "delete") {
      if (heldKey === null) return Promise.resolve();
      heldChoice = { key: heldKey, choice };
      return syncNow("held");
    },
    /** Resolves once any pass that is running has finished. */
    async idle() { while (running) await running; },
    stop() {
      stopped = true;
      if (timer !== null) { timers.clear(timer); timer = null; }
    },
  };
}

export type DesktopVaultSync = ReturnType<typeof createDesktopVaultSync>;
