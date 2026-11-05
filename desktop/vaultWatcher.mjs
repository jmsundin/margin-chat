// Watches the vault folder for files other apps add, change, rename or remove, and says which
// paths changed once they have settled. Events from the system are only hints: each path is
// checked with lstat after a quiet moment and again a little later, and is reported only when
// its size and time held still and it opens for reading, so a half-copied file or a download
// still in progress is never reported. See docs/desktop-vault-sync.md for why this uses
// node:fs.watch rather than a library.
import { watch as fsWatch } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { TEMPORARY_FILE } from "./vaultFs.mjs";

/** How long a path must be quiet before it is checked. */
export const WATCH_DEBOUNCE_MS = 500;
/** The wait between the two checks that must agree before a changed file counts as settled. */
export const STABILITY_CHECK_MS = 500;
/** While the folder is missing, how often to look for it again. */
export const MISSING_FOLDER_CHECK_MS = 5_000;
/** One watcher per folder (Linux) stops here; past it the page checks the folder itself. */
export const MAX_WATCHED_FOLDERS = 10_000;

/** Folders whose contents are never vault content or drop-ins. `.margin-chat` is the app's own. */
const IGNORED_FOLDERS = new Set([".git", ".obsidian", ".trash", ".margin-chat", "node_modules", ".Trash", "$RECYCLE.BIN"]);
/** Files other apps leave behind while they work, or that the system makes by itself. */
const IGNORED_FILE = /^(?:\.DS_Store|Thumbs\.db|desktop\.ini|4913|\.~lock\..*#|~\$.*|\._.*|.*\.(?:tmp|temp|swp|swo|swx|crdownload|part|partial|download|icloud))$/iu;

/** Whether a change at `relativePath` is noise to skip rather than something to look at. */
export function isIgnoredVaultPath(relativePath) {
  const segments = relativePath.split("/");
  const name = segments.at(-1) ?? "";
  if (segments.slice(0, -1).some((segment) => IGNORED_FOLDERS.has(segment))) return true;
  return IGNORED_FOLDERS.has(name) || IGNORED_FILE.test(name) || TEMPORARY_FILE.test(name);
}

const sameStat = (a, b) => (!a && !b) || (!!a && !!b && a.kind === b.kind && a.size === b.size && a.modifiedMs === b.modifiedMs);

/**
 * @param {{
 *   root: string,
 *   onChange: (paths: string[] | null) => void,
 *   isOwnChange?: (relativePath: string, stat: { size: number, modifiedMs: number } | null) => boolean,
 *   platform?: string,
 *   debounceMs?: number,
 *   stabilityMs?: number,
 *   missingCheckMs?: number,
 *   watchImpl?: typeof fsWatch,
 * }} options
 */
export function createVaultWatcher({
  root, onChange, isOwnChange = () => false, platform = process.platform,
  debounceMs = WATCH_DEBOUNCE_MS, stabilityMs = STABILITY_CHECK_MS, missingCheckMs = MISSING_FOLDER_CHECK_MS, watchImpl = fsWatch,
}) {
  const base = path.resolve(root);
  // macOS and Windows watch a whole tree natively; Node's recursive mode on Linux is a JavaScript
  // layer that has crashed on unreadable folders, so Linux gets one plain watcher per folder.
  const recursive = platform === "darwin" || platform === "win32";
  const watchers = new Map();
  const timers = new Map();
  let closed = false;
  let missingTimer = null;
  let active = false;
  let flushTimer = null;
  const ready = new Set();

  function report(paths) {
    if (closed) return;
    if (paths === null) { ready.clear(); clearTimeout(flushTimer); flushTimer = null; onChange(null); return; }
    for (const entry of paths) ready.add(entry);
    // Paths that settle together go in one report.
    flushTimer ??= setTimeout(() => {
      flushTimer = null;
      if (closed || !ready.size) return;
      const batch = [...ready].sort();
      ready.clear();
      onChange(batch);
    }, 25);
  }

  async function check(relativePath) {
    const absolute = path.join(base, ...relativePath.split("/"));
    try {
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) return { kind: "link", size: 0, modifiedMs: 0 };
      return { kind: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other", size: info.size, modifiedMs: Math.floor(info.mtimeMs) };
    } catch {
      return null;
    }
  }

  async function opens(relativePath) {
    try {
      const handle = await open(path.join(base, ...relativePath.split("/")), "r");
      await handle.close();
      return true;
    } catch {
      return false;
    }
  }

  /** Looks at a path once it has been quiet, and reports it once it holds still. */
  async function settle(relativePath) {
    timers.delete(relativePath);
    if (closed) return;
    const first = await check(relativePath);
    await new Promise((resolve) => setTimeout(resolve, stabilityMs));
    if (closed || timers.has(relativePath)) return;
    const second = await check(relativePath);
    if (!sameStat(first, second) || (second?.kind === "file" && !await opens(relativePath))) {
      // Still being written: look again after another quiet moment.
      schedule(relativePath);
      return;
    }
    if (second?.kind === "directory") {
      // A folder dropped in whole, or one appearing on Linux, needs watching and reading as a whole.
      if (!recursive) await watchTree(relativePath);
      report(null);
      return;
    }
    if (second && second.kind !== "file") return;
    if (isOwnChange(relativePath, second ? { size: second.size, modifiedMs: second.modifiedMs } : null)) return;
    report([relativePath]);
  }

  function schedule(relativePath) {
    if (closed) return;
    clearTimeout(timers.get(relativePath));
    timers.set(relativePath, setTimeout(() => void settle(relativePath), debounceMs));
  }

  function heard(directory, filename) {
    if (closed) return;
    if (!filename) { report(null); return; }
    const relativePath = [directory, String(filename).split(path.sep).join("/")].filter(Boolean).join("/");
    if (isIgnoredVaultPath(relativePath)) return;
    schedule(relativePath);
  }

  function lost() {
    // The system dropped events or the watcher failed: start over, and have everything looked at.
    stopWatching();
    report(null);
    void start();
  }

  function addWatcher(relativeDirectory) {
    if (watchers.has(relativeDirectory) || watchers.size >= MAX_WATCHED_FOLDERS) return watchers.size < MAX_WATCHED_FOLDERS;
    const absolute = path.join(base, ...relativeDirectory.split("/").filter(Boolean));
    let watcher;
    try {
      watcher = watchImpl(absolute, { recursive, persistent: false }, (_event, filename) => heard(relativeDirectory, filename));
    } catch {
      return false;
    }
    watcher.on("error", () => {
      watcher.close();
      watchers.delete(relativeDirectory);
      if (relativeDirectory === "") lost();
    });
    watchers.set(relativeDirectory, watcher);
    return true;
  }

  async function watchTree(relativeDirectory) {
    if (!addWatcher(relativeDirectory)) { active = false; return; }
    let entries;
    try {
      entries = await readdir(path.join(base, ...relativeDirectory.split("/").filter(Boolean)), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isDirectory() && !isIgnoredVaultPath(child)) await watchTree(child);
    }
  }

  function stopWatching() {
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  }

  async function start() {
    if (closed) return;
    clearTimeout(missingTimer);
    missingTimer = null;
    const info = await check("").catch(() => null);
    if (!info || info.kind !== "directory") {
      // A missing folder is not an empty one: nothing is reported until it is back.
      active = false;
      missingTimer = setTimeout(() => void start().then(() => { if (active) report(null); }), missingCheckMs);
      return;
    }
    active = true;
    if (recursive) {
      if (!addWatcher("")) active = false;
    } else {
      await watchTree("");
    }
    // A folder moved away or on a drive that was unplugged doesn't always say so; look now and then.
    missingTimer = setTimeout(function look() {
      void check("").then((now) => {
        if (closed) return;
        if (!now || now.kind !== "directory") { active = false; lost(); return; }
        missingTimer = setTimeout(look, missingCheckMs);
      });
    }, missingCheckMs);
  }

  const started = start();

  return {
    /** Resolves once watching has begun (or the folder was found missing). */
    started,
    /** False when the folder is missing or can't be watched; the page then checks it itself. */
    get active() { return active && !closed; },
    close() {
      closed = true;
      stopWatching();
      clearTimeout(missingTimer);
      clearTimeout(flushTimer);
    },
  };
}
