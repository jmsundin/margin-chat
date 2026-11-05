/**
 * Watches the vault folder on desktop and reports changes worth a scan.
 *
 * Raw events from `fs.watch` (recursive: FSEvents on macOS, ReadDirectoryChangesW
 * on Windows, inotify per folder on Linux) are coalesced per path
 * (`WATCH_DEBOUNCE_MS`), then each path is checked for stability before it is
 * reported: its size, date and content hash must read the same twice,
 * `STABILITY_RECHECK_MS` apart, and the file must open for reading. That keeps a
 * file still being copied, downloaded or saved out of the vault until it is
 * whole. Ignored names (ignore.ts) never cost a check; the app's own writes are
 * recognized by hash (echoSuppression.ts) and dropped.
 *
 * Linux's recursive watch can miss files created inside a folder that itself
 * just appeared, so a new folder is listed once and its files reported. A raw
 * event without a path (some platforms report only "something changed") is
 * passed on as a whole-folder change, which the scan handles cheaply through
 * its size-and-date checks.
 *
 * The watcher never reads the folder's contents into memory beyond hashing the
 * changed file, and it never decides what a change means: classification
 * (external edit, drop-in, rename, deletion) is the scan's job, as it is on the
 * web today.
 */
import { watch as fsWatch, type FSWatcher } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createEchoSuppressor, hashBytes, type EchoSuppressor } from "./echoSuppression";
import { isIgnoredVaultPath } from "./ignore";
import { isTempFileName } from "./nodeVaultFs";

/** How long a path waits after its last raw event before it is checked. */
export const WATCH_DEBOUNCE_MS = 500;
/** How far apart the two stability reads are. */
export const STABILITY_RECHECK_MS = 250;
/** How long reported changes are gathered before one callback delivers them. */
export const REPORT_BATCH_MS = 100;
/** Hashing a huge file twice is wasteful; above this, size and date alone decide stability. */
export const HASH_LIMIT_BYTES = 64 * 1024 * 1024;
/** A file reported with these bytes this recently is not reported again (a late raw event for a file a folder listing already covered). */
export const REPEAT_WINDOW_MS = 5_000;

export interface FolderChange {
  /** Vault-relative, `/`-separated; "" means the whole folder should be looked at. */
  path: string;
  kind: "changed" | "removed";
}

/** A source of raw change notifications; `null` means the platform did not say which file. */
export type RawWatchSource = (root: string, listener: (relativePath: string | null) => void, onError: (error: unknown) => void) => () => void;

export interface FolderWatcherOptions {
  root: string;
  onChanges: (changes: FolderChange[]) => void;
  onError?: (error: unknown) => void;
  echo?: EchoSuppressor;
  debounceMs?: number;
  recheckMs?: number;
  batchMs?: number;
  /** A periodic whole-folder look, as a safety net only; 0 (the default) turns it off. */
  rescanEveryMs?: number;
  source?: RawWatchSource;
  wait?: (ms: number) => Promise<void>;
}

export interface FolderWatcher {
  close(): void;
  /** Resolves once every path reported so far has been checked and delivered (for tests). */
  settle(): Promise<void>;
}

const defaultWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const toVaultPath = (relative: string) => relative.split(path.sep).join("/").replace(/^\.\//u, "");

/** `fs.watch` with `recursive`, which every platform the desktop app ships on supports in its Node. */
export const nodeWatchSource: RawWatchSource = (root, listener, onError) => {
  let watcher: FSWatcher;
  try {
    watcher = fsWatch(root, { recursive: true, persistent: true }, (_event, filename) => {
      listener(filename === null || filename === undefined ? null : toVaultPath(filename.toString()));
    });
  } catch (error) {
    onError(error);
    return () => undefined;
  }
  watcher.on("error", onError);
  return () => watcher.close();
};

/** Whether this Node can watch a folder tree with one watcher. */
export function supportsRecursiveWatch(directory: string): boolean {
  try {
    const watcher = fsWatch(directory, { recursive: true, persistent: false }, () => undefined);
    watcher.close();
    return true;
  } catch {
    return false;
  }
}

type Reading = { size: number; mtimeMs: number; hash: string | null } | "missing" | "directory";

export function watchVaultFolder(options: FolderWatcherOptions): FolderWatcher {
  const { root, onChanges } = options;
  const echo = options.echo ?? createEchoSuppressor();
  const debounceMs = options.debounceMs ?? WATCH_DEBOUNCE_MS;
  const recheckMs = options.recheckMs ?? STABILITY_RECHECK_MS;
  const batchMs = options.batchMs ?? REPORT_BATCH_MS;
  const wait = options.wait ?? defaultWait;
  const onError = options.onError ?? (() => undefined);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const inFlight = new Set<Promise<void>>();
  const recentlyReported = new Map<string, { hash: string | null; at: number }>();
  let pending: FolderChange[] = [];
  let batchTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  function report(change: FolderChange) {
    if (closed) return;
    if (!pending.some((item) => item.path === change.path && item.kind === change.kind)) pending.push(change);
    batchTimer ??= setTimeout(() => {
      batchTimer = null;
      const changes = pending;
      pending = [];
      if (changes.length) onChanges(changes);
    }, batchMs);
  }

  async function read(absolute: string): Promise<Reading> {
    let info;
    try { info = await stat(absolute); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return "missing";
      throw error;
    }
    if (info.isDirectory()) return "directory";
    if (!info.isFile()) return "missing";
    if (info.size > HASH_LIMIT_BYTES) return { size: info.size, mtimeMs: info.mtimeMs, hash: null };
    // Opening proves the file is readable now, not still locked by whoever is writing it.
    const handle = await open(absolute, "r");
    try {
      const bytes = await handle.readFile();
      return { size: info.size, mtimeMs: info.mtimeMs, hash: await hashBytes(bytes) };
    } finally {
      await handle.close();
    }
  }

  const same = (a: Reading, b: Reading) => typeof a === "string" || typeof b === "string" ? a === b
    : a.size === b.size && a.mtimeMs === b.mtimeMs && a.hash === b.hash;

  /** Reports every file in a folder that just appeared; its own events may have been missed. */
  async function reportFolderContents(absolute: string, vaultPath: string) {
    let entries;
    try { entries = await readdir(absolute, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const childPath = vaultPath ? `${vaultPath}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (isIgnoredVaultPath(childPath)) continue;
      if (entry.isDirectory()) await reportFolderContents(path.join(absolute, entry.name), childPath);
      else if (entry.isFile()) schedule(childPath);
    }
  }

  async function check(vaultPath: string) {
    const absolute = path.join(root, ...vaultPath.split("/"));
    const first = await read(absolute);
    if (first === "missing") {
      recentlyReported.delete(vaultPath);
      if (!echo.isEcho(vaultPath, null)) report({ path: vaultPath, kind: "removed" });
      return;
    }
    if (first === "directory") {
      await reportFolderContents(absolute, vaultPath);
      return;
    }
    await wait(recheckMs);
    const second = await read(absolute);
    if (!same(first, second)) {
      // Still being written: look again after it has been quiet for the debounce time.
      schedule(vaultPath);
      return;
    }
    if (first.hash !== null && echo.isEcho(vaultPath, first.hash)) return;
    const now = Date.now();
    const recent = recentlyReported.get(vaultPath);
    if (recent && recent.hash !== null && recent.hash === first.hash && now - recent.at < REPEAT_WINDOW_MS) return;
    for (const [reportedPath, entry] of recentlyReported) if (now - entry.at >= REPEAT_WINDOW_MS) recentlyReported.delete(reportedPath);
    recentlyReported.set(vaultPath, { hash: first.hash, at: now });
    report({ path: vaultPath, kind: "changed" });
  }

  function schedule(vaultPath: string) {
    if (closed) return;
    const existing = timers.get(vaultPath);
    if (existing) clearTimeout(existing);
    timers.set(vaultPath, setTimeout(() => {
      timers.delete(vaultPath);
      const run = check(vaultPath).catch(onError);
      inFlight.add(run);
      void run.finally(() => inFlight.delete(run));
    }, debounceMs));
  }

  function onRaw(relativePath: string | null) {
    if (closed) return;
    if (relativePath === null || relativePath === "") { report({ path: "", kind: "changed" }); return; }
    const vaultPath = toVaultPath(relativePath);
    const name = vaultPath.split("/").pop() ?? "";
    if (isTempFileName(name) || isIgnoredVaultPath(vaultPath)) return;
    schedule(vaultPath);
  }

  const stopSource = (options.source ?? nodeWatchSource)(root, onRaw, onError);
  const rescan = options.rescanEveryMs ? setInterval(() => report({ path: "", kind: "changed" }), options.rescanEveryMs) : null;

  return {
    close() {
      closed = true;
      stopSource();
      if (rescan) clearInterval(rescan);
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
      pending = [];
    },
    async settle() {
      // Debounce timers, then checks, then the report batch; a check may schedule another round.
      for (;;) {
        while (timers.size) await wait(debounceMs + 5);
        if (inFlight.size) { await Promise.allSettled([...inFlight]); continue; }
        if (!timers.size) break;
      }
      if (batchTimer) await wait(batchMs + 5);
    },
  };
}
