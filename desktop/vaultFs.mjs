// The vault folder on this computer as a VaultFs (packages/vault-sync/index.d.mts), for the
// main process. Every path is checked to stay inside the folder: no "..", no absolute paths,
// and no symbolic links followed on the way, so a link inside the vault can't reach files
// outside it. Writes go to a temporary file beside the target, are flushed to disk, then
// renamed over it, so a crash mid-write leaves the previous file whole.
import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

// The same rules as packages/vault-sync's isVaultFsPath; the desktop app ships without node_modules.
// eslint-disable-next-line no-control-regex
const UNSAFE_PATH_CHARACTERS = /[\\\u0000-\u001f\u007f]/u;
// Windows reads these as drive letters, streams or wildcards; elsewhere they are ordinary characters.
const UNSAFE_WINDOWS_CHARACTERS = /[:*?"<>|]/u;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/iu;

/** A file changed this recently is checked twice before it is read, so another app's half-written save isn't taken in. */
export const RECENT_CHANGE_MS = 2_000;
export const STABLE_READ_MS = 500;
/** How long this app's own changes are remembered, so the folder watcher doesn't report them back. */
const OWN_CHANGE_MS = 30_000;

/** Temporary files this adapter writes before renaming them into place; scans skip names starting with a dot. */
export const TEMPORARY_FILE = /^\.margin-write-[0-9a-f]{12}\.tmp$/u;

export function vaultFsError(name, message = name, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = name;
  return error;
}

const ERROR_NAMES = {
  ENOENT: "NotFoundError",
  ENOTDIR: "TypeMismatchError",
  EISDIR: "TypeMismatchError",
  EACCES: "NotAllowedError",
  EPERM: "NotAllowedError",
  EEXIST: "InvalidModificationError",
  ENOTEMPTY: "InvalidModificationError",
};

/** A node:fs error with the DOMException-style name every VaultFs uses. */
function named(error, relativePath) {
  if (!error || typeof error !== "object" || !("code" in error)) return error;
  const name = ERROR_NAMES[error.code];
  return name ? vaultFsError(name, `${relativePath || "The vault folder"}: ${error.code}`, error) : error;
}

export function isVaultFsPath(relativePath, platform = process.platform) {
  if (typeof relativePath !== "string" || relativePath.length === 0 || relativePath.startsWith("/") || UNSAFE_PATH_CHARACTERS.test(relativePath)) return false;
  return relativePath.split("/").every((part) => part !== "" && part !== "." && part !== ".."
    && (platform !== "win32" || (!UNSAFE_WINDOWS_CHARACTERS.test(part) && !WINDOWS_RESERVED_NAME.test(part) && !/[. ]$/u.test(part))));
}

/**
 * @param {string} root Absolute path of the vault folder.
 * @param {{ name?: string, platform?: string }} [options]
 */
export function nodeVaultFs(root, {
  name = path.basename(root), platform = process.platform, recentChangeMs = RECENT_CHANGE_MS, stableReadMs = STABLE_READ_MS, now = () => Date.now(),
} = {}) {
  if (!path.isAbsolute(root)) throw new TypeError("The vault folder must be an absolute path.");
  const base = path.resolve(root);
  // What this app last left at each path it wrote, moved or removed (null: removed), and when.
  const ownChanges = new Map();
  function remember(relativePath, stat) {
    ownChanges.set(relativePath, { stat, at: now() });
    if (ownChanges.size > 10_000) for (const [key, value] of ownChanges) if (now() - value.at > OWN_CHANGE_MS) ownChanges.delete(key);
  }
  function isOwn(relativePath, stat) {
    const own = ownChanges.get(relativePath);
    if (!own || now() - own.at > OWN_CHANGE_MS) return false;
    return own.stat === null ? stat === null : !!stat && stat.size === own.stat.size && stat.modifiedMs === own.stat.modifiedMs;
  }

  function check(relativePath, allowRoot = false) {
    if (allowRoot && relativePath === "") return [];
    if (!isVaultFsPath(relativePath, platform)) throw new TypeError(`Not a path inside the vault folder: ${JSON.stringify(relativePath)}`);
    return relativePath.split("/");
  }

  /**
   * The absolute path for `segments`, refusing any symbolic link on the way (the last segment
   * included). Missing segments are fine: they are created or reported by the caller.
   */
  async function resolve(segments, relativePath) {
    let current = base;
    for (const segment of segments) {
      current = path.join(current, segment);
      let info;
      try {
        info = await lstat(current);
      } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return path.join(base, ...segments);
        throw named(error, relativePath);
      }
      if (info.isSymbolicLink()) throw vaultFsError("NotAllowedError", `${relativePath} goes through a link Margin Chat doesn't follow.`);
    }
    return current;
  }

  async function ensureParent(segments, relativePath) {
    const parent = segments.slice(0, -1);
    const absolute = await resolve(parent, relativePath);
    try {
      await mkdir(absolute, { recursive: true });
    } catch (error) {
      throw named(error, relativePath);
    }
    // A link created while the folders were being made is still refused.
    await resolve(parent, relativePath);
    return absolute;
  }

  async function fileStat(absolute, relativePath) {
    let info;
    try {
      info = await lstat(absolute);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
      throw named(error, relativePath);
    }
    if (!info.isFile()) return null;
    return { size: info.size, modifiedMs: Math.floor(info.mtimeMs) };
  }

  return {
    name,
    root: base,
    async *list(directory) {
      const absolute = await resolve(check(directory, true), directory);
      let entries;
      try {
        entries = await readdir(absolute, { withFileTypes: true });
      } catch (error) {
        throw named(error, directory);
      }
      for (const entry of entries) {
        // Links, sockets and devices aren't vault content.
        if (entry.isDirectory()) yield { name: entry.name, kind: "directory" };
        else if (entry.isFile() && !TEMPORARY_FILE.test(entry.name)) yield { name: entry.name, kind: "file" };
      }
    },
    async stat(relativePath) {
      const segments = check(relativePath);
      return fileStat(await resolve(segments, relativePath), relativePath);
    },
    async read(relativePath) {
      const absolute = await resolve(check(relativePath), relativePath);
      let handle;
      try {
        handle = await open(absolute, "r");
      } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "ENOTDIR" || error?.code === "EISDIR") return null;
        throw named(error, relativePath);
      }
      let read;
      try {
        const info = await handle.stat();
        if (!info.isFile()) return null;
        const bytes = new Uint8Array(await handle.readFile());
        // The size and time are from the open file, the same snapshot as its bytes.
        read = { bytes, stat: { size: bytes.length, modifiedMs: Math.floor(info.mtimeMs) } };
      } finally {
        await handle.close();
      }
      // A file another app changed a moment ago may still be arriving (a copy, a download, a chunked
      // save): it must hold still across a second look, or the read is refused as the folder changing,
      // which the caller already treats as "read it again shortly" without changing anything.
      if (now() - read.stat.modifiedMs < recentChangeMs && !isOwn(relativePath, read.stat)) {
        await new Promise((resolve) => setTimeout(resolve, stableReadMs));
        const again = await fileStat(absolute, relativePath);
        if (!again || again.size !== read.stat.size || again.modifiedMs !== read.stat.modifiedMs) {
          throw vaultFsError("InvalidStateError", `${relativePath} is still being written.`);
        }
      }
      return read;
    },
    async writeAtomic(relativePath, contents) {
      const segments = check(relativePath);
      const directory = await ensureParent(segments, relativePath);
      const target = path.join(directory, segments.at(-1));
      const existing = await lstat(target).catch((error) => { if (error?.code === "ENOENT") return null; throw named(error, relativePath); });
      if (existing && !existing.isFile()) throw vaultFsError(existing.isDirectory() ? "TypeMismatchError" : "NotAllowedError", `${relativePath} isn't a file.`);
      const temporary = path.join(directory, `.margin-write-${randomBytes(6).toString("hex")}.tmp`);
      let handle;
      try {
        handle = await open(temporary, "wx", existing ? existing.mode & 0o777 : 0o644);
        await handle.writeFile(typeof contents === "string" ? contents : Buffer.from(contents.buffer, contents.byteOffset, contents.byteLength));
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporary, target);
        remember(relativePath, await fileStat(target, relativePath));
      } catch (error) {
        await handle?.close().catch(() => undefined);
        await unlink(temporary).catch(() => undefined);
        throw named(error, relativePath);
      }
      // The rename itself is durable once the folder's entry is flushed (not possible on Windows).
      if (platform !== "win32") {
        const folder = await open(directory, "r").catch(() => null);
        await folder?.sync().catch(() => undefined);
        await folder?.close().catch(() => undefined);
      }
    },
    async move(from, to) {
      const source = await resolve(check(from), from);
      const toSegments = check(to);
      const info = await fileStat(source, from);
      if (!info) throw vaultFsError("NotFoundError", `${from} isn't in the vault folder.`);
      const target = await resolve(toSegments, to);
      if (await lstat(target).then(() => true, () => false)) throw vaultFsError("InvalidModificationError", `${to} already exists.`);
      await ensureParent(toSegments, to);
      try {
        await rename(source, target);
      } catch (error) {
        throw named(error, from);
      }
      remember(from, null);
      remember(to, info);
    },
    async delete(relativePath) {
      const absolute = await resolve(check(relativePath), relativePath);
      const info = await fileStat(absolute, relativePath);
      if (!info) throw vaultFsError("NotFoundError", `${relativePath} isn't in the vault folder.`);
      try {
        await unlink(absolute);
      } catch (error) {
        throw named(error, relativePath);
      }
      remember(relativePath, null);
    },
    async availability() {
      try {
        const info = await stat(base);
        if (!info.isDirectory()) return "missing";
        await readdir(base);
        return "available";
      } catch (error) {
        if (error?.code === "EACCES" || error?.code === "EPERM") return "refused";
        return "missing";
      }
    },
    /** Whether `stat` (null: no file) is what this app itself last left at `relativePath`. */
    isOwnChange: isOwn,
  };
}
