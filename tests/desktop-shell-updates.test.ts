import { afterEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createShellUpdater, installCommand, macAppBundle, pickUpdateFile } from "../desktop/shellUpdater.mjs";
import { buildUpdateManifest } from "../scripts/desktop-update-manifest.mjs";

const temps: string[] = [];
afterEach(async () => { for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function tempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "margin-shell-"));
  temps.push(dir);
  return dir;
}
const sha512 = (bytes: string) => createHash("sha512").update(bytes).digest("hex");
const entry = (name: string, bytes: string) => ({ name, size: Buffer.byteLength(bytes), sha512: sha512(bytes) });

function feed(files: Record<string, string>, manifest: unknown) {
  const requests: string[] = [];
  const fetchImpl = async (url: URL) => {
    const name = url.pathname.split("/").at(-1)!;
    requests.push(name);
    if (name === "desktop-update.json") return manifest ? Response.json(manifest) : new Response("", { status: 404 });
    return name in files ? new Response(files[name]) : new Response("", { status: 404 });
  };
  return { requests, fetchImpl: fetchImpl as any };
}

test("each platform updates from its own file, and a .deb install does not", () => {
  const manifest = { version: "0.2.0", files: { mac: entry("a.zip", "m"), windows: entry("a.exe", "w"), linux: entry("a.AppImage", "l") } };
  expect(pickUpdateFile(manifest, { platform: "darwin", appImage: null })?.name).toBe("a.zip");
  expect(pickUpdateFile(manifest, { platform: "win32", appImage: null })?.name).toBe("a.exe");
  expect(pickUpdateFile(manifest, { platform: "linux", appImage: "/opt/a.AppImage" })?.name).toBe("a.AppImage");
  expect(pickUpdateFile(manifest, { platform: "linux", appImage: null })).toBeNull();
  expect(pickUpdateFile({ files: { windows: { ...entry("a.exe", "w"), name: "../evil.exe" } } }, { platform: "win32", appImage: null })).toBeNull();
  expect(macAppBundle("/Applications/Margin Chat.app/Contents/MacOS/Margin Chat")).toBe("/Applications/Margin Chat.app");
});

test("an AppImage downloads a newer version, checks it, and swaps it in after quitting", async () => {
  const dir = await tempDir();
  const appImage = path.join(dir, "Margin-Chat.AppImage");
  await writeFile(appImage, "old");
  const { fetchImpl, requests } = feed({ "new.AppImage": "new version" }, { version: "0.2.0", files: { linux: entry("new.AppImage", "new version") } });
  const sleeper = spawn("sleep", ["30"]);
  const updater = createShellUpdater({
    currentVersion: "0.1.0", platform: "linux", appImage, feedUrl: "https://example.test/download/",
    downloadsDir: path.join(dir, "updates"), fetchImpl, pid: sleeper.pid,
  });
  const staged = await updater.check();
  expect(staged).toMatchObject({ version: "0.2.0", manual: false });
  expect(await updater.check()).toBe(staged);
  expect(requests).toEqual(["desktop-update.json", "new.AppImage"]);
  expect(updater.install({ relaunch: false })).toBe(true);
  expect(updater.install({ relaunch: false })).toBe(false);
  // The swap waits for the app (here a sleep process) to exit.
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(await readFile(appImage, "utf8")).toBe("old");
  sleeper.kill();
  for (let tries = 0; tries < 50 && (await readFile(appImage, "utf8")) === "old"; tries += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  expect(await readFile(appImage, "utf8")).toBe("new version");
  expect((await stat(appImage)).mode & 0o111).toBeTruthy();
});

test("a download that fails its checksum is never installed", async () => {
  const dir = await tempDir();
  const appImage = path.join(dir, "Margin-Chat.AppImage");
  await writeFile(appImage, "old");
  const { fetchImpl } = feed({ "new.AppImage": "tampered" }, { version: "0.2.0", files: { linux: entry("new.AppImage", "new version") } });
  const updater = createShellUpdater({ currentVersion: "0.1.0", platform: "linux", appImage, downloadsDir: path.join(dir, "updates"), fetchImpl });
  await expect(updater.check()).rejects.toThrow("checksum");
  expect(updater.install({ relaunch: false })).toBe(false);
});

test("no newer release, or an install that can't replace itself, downloads nothing", async () => {
  const dir = await tempDir();
  const same = feed({}, { version: "0.2.0", files: { windows: entry("a.exe", "w") } });
  expect(await createShellUpdater({ currentVersion: "0.2.0", platform: "win32", downloadsDir: dir, fetchImpl: same.fetchImpl }).check()).toBeNull();
  expect(await createShellUpdater({ currentVersion: "0.2.0", platform: "win32", downloadsDir: dir, fetchImpl: feed({}, null).fetchImpl }).check()).toBeNull();
  const deb = feed({}, { version: "0.3.0", files: { linux: entry("a.AppImage", "l") } });
  expect(await createShellUpdater({ currentVersion: "0.2.0", platform: "linux", appImage: null, downloadsDir: dir, fetchImpl: deb.fetchImpl }).check()).toEqual({ version: "0.3.0", manual: true });
  expect(deb.requests).toEqual(["desktop-update.json"]);
  const fromDiskImage = feed({}, { version: "0.3.0", files: { mac: entry("a.zip", "m") } });
  expect(await createShellUpdater({ currentVersion: "0.2.0", platform: "darwin", execPath: "/Volumes/Margin Chat/Margin Chat.app/Contents/MacOS/Margin Chat", downloadsDir: dir, fetchImpl: fromDiskImage.fetchImpl }).check()).toMatchObject({ manual: true });
});

test("the Mac swap replaces the app bundle and restores it if the move fails", async () => {
  const dir = await tempDir();
  const bundle = path.join(dir, "Margin Chat.app");
  const next = path.join(dir, "next", "Margin Chat.app");
  await mkdir(bundle, { recursive: true });
  await writeFile(path.join(bundle, "marker"), "old");
  await mkdir(next, { recursive: true });
  await writeFile(path.join(next, "marker"), "new");
  const run = (staged: string) => {
    const { command, args } = installCommand({ platform: "darwin", staged, execPath: `${bundle}/Contents/MacOS/Margin Chat`, appImage: null, pid: 999999, relaunch: false });
    return spawnSync(command, args).status;
  };
  expect(run(path.join(dir, "missing.app"))).toBe(0);
  expect(await readFile(path.join(bundle, "marker"), "utf8")).toBe("old");
  expect(run(next)).toBe(0);
  expect(await readFile(path.join(bundle, "marker"), "utf8")).toBe("new");
  expect(installCommand({ platform: "win32", staged: "C:\\u\\setup.exe", execPath: "", appImage: null, pid: 1, relaunch: true }).args).toEqual(["--updated", "/S", "--force-run"]);
});

test("the release manifest lists one checked file per platform", async () => {
  const dir = await tempDir();
  for (const [name, text] of Object.entries({ "M-0.2.0-mac-universal.zip": "m", "M-0.2.0-mac-universal.dmg": "d", "M-0.2.0-win-x64-setup.exe": "w", "M-0.2.0-linux-x86_64.AppImage": "l", "M-0.2.0-linux-amd64.deb": "deb" })) {
    await writeFile(path.join(dir, name), text);
  }
  expect(buildUpdateManifest(dir, { version: "0.2.0", commit: "c" })).toEqual({
    version: "0.2.0", commit: "c",
    files: { mac: entry("M-0.2.0-mac-universal.zip", "m"), windows: entry("M-0.2.0-win-x64-setup.exe", "w"), linux: entry("M-0.2.0-linux-x86_64.AppImage", "l") },
  });
  await rm(path.join(dir, "M-0.2.0-win-x64-setup.exe"));
  expect(() => buildUpdateManifest(dir, { version: "0.2.0", commit: "c" })).toThrow("windows");
});
