import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, chmod, constants, mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { newerShell } from "./updates.mjs";

// Installs new versions of the desktop app itself (Electron and main.mjs)
// from the Desktop release on GitHub. The client inside it updates more often
// and separately (clientBundles.mjs). Each release carries desktop-update.json,
// written by .github/workflows/desktop-release.yml, with each installer's size
// and SHA-512, so nothing runs unless it matches the release byte for byte.
export const UPDATE_MANIFEST = "desktop-update.json";
export const DEFAULT_FEED = "https://github.com/jmsundin/margin-chat/releases/latest/download/";
const SAFE_NAME = /^[A-Za-z0-9._-]+$/u;

/** The file this installation can update itself from, or null when it can't
 * (a .deb install, which needs the system package manager). */
export function pickUpdateFile(manifest, { platform, appImage }) {
  const key = platform === "darwin" ? "mac" : platform === "win32" ? "windows" : platform === "linux" && appImage ? "linux" : null;
  const file = key ? manifest?.files?.[key] : null;
  if (!file || typeof file.name !== "string" || !SAFE_NAME.test(file.name)
    || !/^[a-f0-9]{128}$/u.test(file.sha512 ?? "") || !Number.isSafeInteger(file.size) || file.size <= 0) return null;
  return { key, name: file.name, sha512: file.sha512, size: file.size };
}

/** The .app bundle that contains this executable on macOS. */
export function macAppBundle(execPath) {
  const index = execPath.indexOf(".app/Contents/MacOS/");
  return index === -1 ? null : execPath.slice(0, index + 4);
}

// Each script waits for the app to exit, swaps in the new version, and only
// reopens it when the person asked for the update now rather than quitting.
export function installCommand({ platform, staged, execPath, appImage, pid, relaunch }) {
  if (platform === "win32") {
    // electron-builder's NSIS installer: silent, and it closes the old app first.
    return { command: staged, args: ["--updated", "/S", ...(relaunch ? ["--force-run"] : [])] };
  }
  const wait = `while kill -0 "$1" 2>/dev/null; do sleep 0.2; done`;
  if (platform === "darwin") {
    const script = `${wait}
target="$2"; next="$3"; old="$target.updating-old"
rm -rf "$old"
mv "$target" "$old" || exit 1
if mv "$next" "$target"; then rm -rf "$old"; else mv "$old" "$target"; fi
[ "$4" = relaunch ] && open "$target"
exit 0`;
    return { command: "/bin/sh", args: ["-c", script, "margin-update", String(pid), macAppBundle(execPath), staged, relaunch ? "relaunch" : "quit"] };
  }
  const script = `${wait}
chmod +x "$3" && mv -f "$3" "$2" || exit 1
[ "$4" = relaunch ] && "$2" >/dev/null 2>&1 &
exit 0`;
  return { command: "/bin/sh", args: ["-c", script, "margin-update", String(pid), appImage, staged, relaunch ? "relaunch" : "quit"] };
}

async function writable(directory) {
  try { await access(directory, constants.W_OK); return true; } catch { return false; }
}

export function createShellUpdater({
  currentVersion, platform = process.platform, execPath = process.execPath, appImage = process.env.APPIMAGE ?? null,
  feedUrl = DEFAULT_FEED, downloadsDir, fetchImpl = globalThis.fetch, spawnImpl = nodeSpawn, pid = process.pid,
}) {
  let staged = null;
  let installing = false;

  /** Where the new version replaces the old one, when this install can do that itself. */
  async function canSelfUpdate() {
    if (platform === "win32") return true;
    if (platform === "linux") return Boolean(appImage) && writable(path.dirname(appImage));
    if (platform !== "darwin") return false;
    const bundle = macAppBundle(execPath);
    // Running from the disk image or a quarantined copy macOS moved aside: not installable in place.
    return Boolean(bundle) && !bundle.includes("/AppTranslocation/") && !bundle.startsWith("/Volumes/") && writable(path.dirname(bundle));
  }

  async function download(file, directory) {
    const response = await fetchImpl(new URL(file.name, feedUrl), { cache: "no-store" });
    if (!response.ok || !response.body) throw new Error(`Downloading ${file.name} failed (${response.status}).`);
    const hash = createHash("sha512");
    let size = 0;
    const partial = path.join(directory, `${file.name}.partial`);
    await pipeline(
      Readable.fromWeb(response.body),
      new Transform({ transform(chunk, _encoding, done) { hash.update(chunk); size += chunk.length; done(null, chunk); } }),
      createWriteStream(partial),
    );
    if (size !== file.size || hash.digest("hex") !== file.sha512) {
      await rm(partial, { force: true });
      throw new Error(`${file.name} did not match the release's checksum.`);
    }
    const target = path.join(directory, file.name);
    await rename(partial, target);
    return target;
  }

  async function unpackMacApp(zip, directory) {
    const out = path.join(directory, "app");
    await rm(out, { recursive: true, force: true });
    await new Promise((resolve, reject) => {
      const child = spawnImpl("/usr/bin/ditto", ["-x", "-k", zip, out], { stdio: "ignore" });
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`Unpacking the update failed (${code}).`))));
    });
    const app = (await readdir(out)).find((name) => name.endsWith(".app"));
    if (!app) throw new Error("The update has no app inside.");
    return path.join(out, app);
  }

  /** Downloads and verifies a newer version. Returns it once it is ready to
   * install, the release when this install can't update itself, or null. */
  async function check() {
    if (staged) return staged;
    const response = await fetchImpl(new URL(UPDATE_MANIFEST, feedUrl), { cache: "no-store" });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Update check failed (${response.status}).`);
    const manifest = await response.json();
    const latest = newerShell({ version: currentVersion }, manifest);
    if (!latest) return null;
    const file = pickUpdateFile(manifest, { platform, appImage });
    if (!file || !(await canSelfUpdate())) return { version: manifest.version, manual: true };

    const directory = path.join(downloadsDir, manifest.version);
    await rm(downloadsDir, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    let ready = await download(file, directory);
    if (platform === "darwin") ready = await unpackMacApp(ready, directory);
    if (platform === "linux") await chmod(ready, 0o755);
    staged = { version: manifest.version, path: ready, manual: false };
    return staged;
  }

  /** Starts the installer, which takes over once this app exits. The caller quits. */
  function install({ relaunch }) {
    if (!staged || staged.manual || installing) return false;
    installing = true;
    const { command, args } = installCommand({ platform, staged: staged.path, execPath, appImage, pid, relaunch });
    const child = spawnImpl(command, args, { detached: true, stdio: "ignore" });
    child.unref?.();
    return true;
  }

  return { check, install, staged: () => staged, canSelfUpdate };
}
