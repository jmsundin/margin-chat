/**
 * The desktop app's vault, run by the main process.
 *
 * One vault engine (`VaultSync`, unchanged from the web) over the journal store
 * in the app's data folder, the cloud transport through the app's own session,
 * and the folder mirror over the native adapter. The loop that the web client
 * runs in its page runs here instead: read what changed in the folder, sync
 * with the cloud, write the vault back, prune old trash. It starts with the
 * app, runs on an interval, when the folder changes, when asked, and survives
 * the window being reloaded or closed. The renderer edits the vault through
 * `engine(...)` and learns about changes and status through events; it never
 * drives sync.
 *
 * Status follows the spec's §6: synced, syncing, offline, paused, or needs
 * attention (only for a held deletion, a missing folder, an expired session or
 * repeated failures). No other decision is ever asked of the person.
 */
import { VaultSync } from "../../client/src/lib/vaultSync";
import { createJournalVaultStore } from "../../client/src/lib/vaultLocal";
import type { VaultFile, VaultSnapshot, VaultStore, VaultTransport } from "../../client/src/lib/vaultTypes";
import { FolderMirror } from "../../client/src/lib/vaultFolderMirror";
import { FolderDeletionHeldError, type HeldFolderDeletion } from "../../client/src/lib/folderDeletionGuard";
import { FolderUnavailableError, LocalDirectoryConflictError } from "../../client/src/lib/workspaceStorage";
import { FolderChangingError } from "../../client/src/lib/fileSnapshot";
import { isSafeMarkdownPath } from "../../client/src/lib/workspaceMarkdown";
import { isVaultFileDocumentPath } from "../../client/src/lib/vaultFileDocuments";
import { pendingVaultChanges } from "../../client/src/lib/vaultSync";
import { createNativeFolderAccess, type NativeFolder } from "./nativeFolderAccess";
import { asFileSystemDirectoryHandle, openNodeVaultDirectory } from "./nodeVaultFs";
import { isAppOwnedPath, isIgnoredVaultPath } from "./ignore";
import type { VaultDirectory } from "./vaultFs";

export type SyncState = "synced" | "syncing" | "offline" | "paused" | "attention" | "local";

export interface SyncStatus {
  state: SyncState;
  /** When the last complete sync finished, if any. */
  lastSyncedAt: number | null;
  /** Local changes not yet in the cloud. */
  pending: number;
  /** Why attention is needed, when it is. */
  attention: { kind: "deletion-hold" | "folder-missing" | "auth" | "error"; message: string } | null;
  /** A held deletion waiting for an answer. */
  held: HeldFolderDeletion | null;
  folder: { id: string; name: string; path: string } | null;
  cloud: boolean;
  paused: boolean;
  /** The most recent failure, for the Sync settings page; attention is raised only after repeated ones. */
  lastError: string | null;
}

export interface DesktopVaultServiceOptions {
  /** The folder for this account's journal: `<userData>/vaults/<account>`, created if missing. */
  journalDir: string;
  userId: string;
  /** The connected vault folder, or null to run the vault from the journal alone. */
  folder: { id: string; name: string; path: string } | null;
  /** Cloud sync, when the account's plan allows it. Null keeps the vault local. */
  transport: VaultTransport | null;
  onStatus?(status: SyncStatus): void;
  /** The vault changed (a sync, a folder read, a trash purge): the renderer should read it again. */
  onChanged?(): void;
  /** How often to look at the cloud while idle. */
  intervalMs?: number;
  /** Consecutive failures before "needs attention". */
  failureThreshold?: number;
  now?: () => number;
}

/** The engine operations the renderer may call, by name. Everything else stays in this process. */
export const ENGINE_OPERATIONS = ["read", "edit", "restoreDeleted", "purgeTrash", "import", "resolve", "importChatHistory", "undoChatHistory", "deferFresh", "pull", "hydrate", "evict", "rememberDirectory"] as const;
export type EngineOperation = typeof ENGINE_OPERATIONS[number];

export interface DesktopVaultService {
  /** Runs one engine operation for the renderer; a write schedules a sync. */
  engine(operation: EngineOperation, ...args: unknown[]): Promise<unknown>;
  /** Read the folder, sync, write the folder. Resolves when done; errors are reflected in status, not thrown. */
  refresh(): Promise<void>;
  /** The folder changed outside the app: scan soon. */
  folderChanged(): void;
  pause(paused: boolean): void;
  resolveHeldDeletion(choice: "restore" | "delete"): Promise<void>;
  status(): SyncStatus;
  /** Files in the folder Margin Chat leaves alone: neither notes nor supported documents nor noise. */
  unsupportedFiles(): Promise<string[]>;
  /** The vault's current files, for one-off reads outside the engine (exports). */
  snapshot(): Promise<VaultSnapshot>;
  close(): Promise<void>;
}

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_FAILURE_THRESHOLD = 3;

const isOffline = (error: unknown) => error instanceof TypeError
  || (error instanceof Error && (/failed to fetch|load failed|networkerror|network request failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT/i.test(error.message)
    || ["AbortError", "TimeoutError"].includes(error.name)));
const isAuthError = (error: unknown) => !!error && typeof error === "object" && "statusCode" in error && ((error as { statusCode: number }).statusCode === 401 || (error as { statusCode: number }).statusCode === 403);

export async function createDesktopVaultService(options: DesktopVaultServiceOptions): Promise<DesktopVaultService> {
  const now = options.now ?? (() => Date.now());
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;

  // The journal store over a folder in the app's data directory, serialized in this process.
  let tail = Promise.resolve();
  const store: VaultStore = createJournalVaultStore({
    openRoot: async () => asFileSystemDirectoryHandle(await openJournalRoot(options.journalDir)),
    lock<T>(operation: () => Promise<T>) { const next = tail.then(operation); tail = next.then(() => undefined, () => undefined); return next; },
  });
  // Without cloud sync the transport is never called; a stub keeps the engine's type honest.
  const transport: VaultTransport = options.transport ?? {
    manifest: async () => { throw new Error("Cloud sync is off for this account."); },
    read: async () => { throw new Error("Cloud sync is off for this account."); },
    commit: async () => { throw new Error("Cloud sync is off for this account."); },
  };
  const engine = new VaultSync(store, transport);
  const nativeFolder: NativeFolder | null = options.folder
    ? { id: options.folder.id, name: options.folder.name, directory: await openNodeVaultDirectory(options.folder.path) }
    : null;

  let held: HeldFolderDeletion | null = null;
  let folderMissing = false;
  const mirror = new FolderMirror(engine, createNativeFolderAccess(options.userId, nativeFolder), {
    onHeldDeletion(next) { held = next; publish(); },
    onUnavailable(unavailable) { folderMissing = unavailable; publish(); },
  });

  let paused = false;
  let syncing = false;
  let offline = false;
  let lastSyncedAt: number | null = null;
  let pending = 0;
  let failures = 0;
  let lastError: { kind: "auth" | "error"; message: string } | null = null;
  let closed = false;
  let queue = Promise.resolve();
  let refreshQueued = false;
  let refreshAgain = false;
  /** Callers who asked for a refresh while one was running wait for the pass that starts after it. */
  let followUp: { promise: Promise<void>; resolve: () => void } | null = null;
  let folderDirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function status(): SyncStatus {
    const attention = held ? { kind: "deletion-hold" as const, message: `${held.paths.length} files are missing from “${held.folderName}”. Nothing has been deleted; choose what to do with them.` }
      : folderMissing ? { kind: "folder-missing" as const, message: `Margin Chat can’t find or open “${options.folder?.name ?? "your vault folder"}”. Nothing was changed in it or in your vault.` }
      : lastError && failures >= failureThreshold ? lastError
      : null;
    const state: SyncState = attention ? "attention" : paused ? "paused" : !options.transport ? "local" : syncing ? "syncing" : offline ? "offline" : "synced";
    return { state, lastSyncedAt, pending, attention, held, folder: options.folder, cloud: !!options.transport, paused, lastError: lastError?.message ?? null };
  }
  function publish() { if (!closed) options.onStatus?.(status()); }

  async function countPending() {
    try { pending = pendingVaultChanges(await engine.read()).length; } catch { /* Unreadable here is reported by the next sync. */ }
  }

  /** One pass of the loop; never throws. */
  async function pass() {
    if (closed || paused) return;
    syncing = true;
    publish();
    let changed = false;
    try {
      folderDirty = false;
      // Cloud sync still runs when the connected folder could not be read; the folder is retried next time.
      const folderError = await mirror.read().then(() => { changed = true; return null; }, (error: unknown) => error);
      if (options.transport) {
        try {
          await engine.sync();
          changed = true;
          offline = false;
          failures = 0;
          lastError = null;
          lastSyncedAt = now();
        } catch (error) {
          if (isOffline(error)) offline = true;
          else {
            failures += 1;
            lastError = { kind: isAuthError(error) ? "auth" : "error", message: isAuthError(error)
              ? "Sign in again to keep syncing with the cloud. Your edits are saved on this computer."
              : error instanceof Error ? error.message : "Your vault could not be synchronized." };
          }
        }
      }
      if (folderError) throw folderError;
      // Do not write to a folder whose current contents were not read.
      await mirror.write(await engine.read());
      if (await engine.purgeTrash().catch(() => 0)) changed = true;
    } catch (error) {
      if (process.env.MARGIN_VAULT_DEBUG) console.error("vault pass failed", error instanceof Error ? error.stack : error);
      // These have their own place in status; anything else counts as a failure of this pass.
      if (!(error instanceof FolderDeletionHeldError) && !(error instanceof FolderUnavailableError)
        && !(error instanceof LocalDirectoryConflictError) && !(error instanceof FolderChangingError)) {
        failures += 1;
        lastError = { kind: "error", message: error instanceof Error ? error.message : "The vault folder could not be updated." };
      }
      // A folder that changed under a write or mid-scan is read again right away.
      if (error instanceof LocalDirectoryConflictError || error instanceof FolderChangingError) folderDirty = true;
    } finally {
      await countPending();
      syncing = false;
      publish();
      if (changed) options.onChanged?.();
    }
  }

  function schedule(delay = intervalMs) {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void refresh(); }, delay);
  }

  function refresh(): Promise<void> {
    if (closed) return Promise.resolve();
    if (refreshQueued) {
      // The running pass may have read the folder already; the answer is the next complete pass.
      refreshAgain = true;
      if (!followUp) {
        let resolve!: () => void;
        const promise = new Promise<void>((done) => { resolve = done; });
        followUp = { promise, resolve };
      }
      return followUp.promise;
    }
    refreshQueued = true;
    const waiting = followUp;
    followUp = null;
    queue = queue.then(pass).catch(() => undefined).finally(() => {
      refreshQueued = false;
      waiting?.resolve();
      if ((refreshAgain || folderDirty) && !closed) { refreshAgain = false; if (followUp) void refresh(); else schedule(folderDirty ? 500 : 0); return; }
      schedule();
    });
    return queue;
  }

  // Start with the app, like the page did on load.
  void refresh();
  // A folder that changed under a write is looked at again soon; a follow-up asked for mid-pass starts straight away.

  return {
    async engine(operation, ...args) {
      if (!ENGINE_OPERATIONS.includes(operation)) throw new Error(`Unknown vault operation: ${String(operation)}`);
      const method = (engine as unknown as Record<string, (...parameters: unknown[]) => Promise<unknown>>)[operation];
      const result = await method.apply(engine, args);
      if (operation !== "read") { await countPending(); publish(); schedule(900); }
      return result;
    },
    refresh,
    folderChanged() { folderDirty = true; schedule(0); },
    pause(next) {
      paused = next;
      if (timer) { clearTimeout(timer); timer = null; }
      publish();
      if (!paused) schedule(0);
    },
    async resolveHeldDeletion(choice) {
      if (!mirror.resolveHeldDeletion(choice)) return;
      await refresh();
    },
    status,
    async unsupportedFiles() {
      if (!nativeFolder) return [];
      const unsupported: string[] = [];
      const walk = async (directory: VaultDirectory, prefix: string) => {
        for await (const [name, handle] of directory.entries()) {
          const path = prefix ? `${prefix}/${name}` : name;
          if (isIgnoredVaultPath(path) || isAppOwnedPath(path)) continue;
          if (handle.kind === "directory") { await walk(handle, path); continue; }
          if (isSafeMarkdownPath(path) || isVaultFileDocumentPath(path)) continue;
          unsupported.push(path);
        }
      };
      await walk(nativeFolder.directory, "").catch(() => undefined);
      return unsupported.sort();
    },
    snapshot: () => engine.read(),
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      await queue.catch(() => undefined);
    },
  };
}

async function openJournalRoot(journalDir: string) {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(journalDir, { recursive: true });
  return openNodeVaultDirectory(journalDir);
}

/** A map of files for an engine edit, from the renderer's JSON. */
export type FileMap = Record<string, VaultFile>;
