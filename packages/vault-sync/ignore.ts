/**
 * What arrives in a vault folder that is not the person's content.
 *
 * Nothing here is ingested, synced, counted by the deletion guard or listed as
 * unsupported: the operating system's and other editors' noise, half-finished
 * downloads, lock files, and the hidden folders other tools keep for themselves.
 * The folder scan already skips every hidden name (`.`-prefixed) and Margin
 * Chat's own folders; this list adds the visible noise and names the hidden
 * cases so the watcher can drop their events before they cost a scan.
 */

/** Files the system or an editor puts beside the person's own. */
const NOISE_NAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini", "ehthumbs.db", "Icon\r", "4913"]);

/** Partial or temporary files: a download or save that is not finished yet. */
const NOISE_PATTERNS = [
  /^~\$/u,                 // Office lock files
  /^\.~lock\./u,           // LibreOffice lock files
  /\.(?:tmp|temp|swp|swo|swx|bak|orig|rej)$/iu,
  /\.(?:crdownload|part|partial|download|opdownload)$/iu,
  /^\.#/u,                 // Emacs locks
  /^#.*#$/u,               // Emacs autosaves
  /~$/u,                   // Editor backups (Vim, gedit, Emacs)
  /^\.goutputstream-/u,    // GNOME atomic saves in progress
  /^\.margin-chat-tmp-/u,  // Our own atomic writes in progress
];

/** Hidden folders other tools keep for themselves; `.margin-chat/` is app-owned and handled separately. */
const TOOL_FOLDERS = new Set([".git", ".obsidian", ".trash", ".svn", ".hg", ".idea", ".vscode", "node_modules", ".Trashes", ".Spotlight-V100", ".fseventsd", "$RECYCLE.BIN", "System Volume Information"]);

export function isNoiseFileName(name: string): boolean {
  return NOISE_NAMES.has(name) || NOISE_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Whether a folder path (vault-relative, `/`-separated) is ignored outright.
 * Hidden entries (any segment starting with `.`) are ignored as the folder scan
 * already does, except `.margin-chat/…`, which is watched for the app's own
 * consistency and classified by `isAppOwnedPath`.
 */
export function isIgnoredVaultPath(path: string): boolean {
  const segments = path.split("/").filter(Boolean);
  if (!segments.length) return true;
  if (segments[0] === ".margin-chat") return false;
  return segments.some((segment, index) => TOOL_FOLDERS.has(segment)
    || (segment.startsWith(".") && segment !== ".margin-chat")
    || (index === segments.length - 1 && isNoiseFileName(segment)));
}

/** Margin Chat's own history, trash and metadata: never a drop-in, never counted as the person's deletion. */
export function isAppOwnedPath(path: string): boolean {
  return /^(?:\.margin-chat|_conflicts|attachments)(?:\/|$)/iu.test(path) || path === "workspace.json" || /^margin-chat-workspace-[^/]+\.json$/u.test(path);
}
