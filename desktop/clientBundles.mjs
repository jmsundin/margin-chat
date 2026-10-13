import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

// The desktop app is a shell around the web client. Instead of asking people
// to download a new installer for every release, it downloads the client that
// production serves (listed with checksums in desktop-bundle.json) into its
// own storage and serves that from then on. Only changes to the shell itself
// (main.mjs, Electron) need a new installer.
export const BUNDLE_MANIFEST = "desktop-bundle.json";
const STATE_FILE = "state.json";
const SAFE_PATH = /^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/u;
const COMMIT = /^[a-f0-9]{40}$/u;

function commitTime(version) {
  if (!version || typeof version.commit !== "string" || !COMMIT.test(version.commit)) return null;
  const time = Date.parse(version.committedAt ?? "");
  return Number.isNaN(time) ? null : time;
}

/** True when `candidate` is a strictly newer build than `current`. */
export function isNewerBuild(current, candidate) {
  const next = commitTime(candidate);
  if (next === null || candidate.commit === current?.commit) return false;
  const own = commitTime(current);
  return own === null || next > own;
}

export function validateManifest(manifest, version) {
  if (!manifest || manifest.commit !== version.commit || !Array.isArray(manifest.files) || !manifest.files.length) {
    throw new Error("The update's file list does not match its version.");
  }
  const seen = new Set();
  for (const file of manifest.files) {
    if (typeof file?.path !== "string" || !SAFE_PATH.test(file.path) || file.path.split("/").some((part) => part === "." || part === "..")
      || seen.has(file.path) || !/^[a-f0-9]{64}$/u.test(file.sha256 ?? "") || !Number.isSafeInteger(file.size) || file.size < 0) {
      throw new Error("The update's file list is not valid.");
    }
    seen.add(file.path);
  }
  if (!seen.has("index.html")) throw new Error("The update has no index.html.");
  return manifest.files;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; }
}

export function createClientBundles({ root, bundledDir, origin, fetchImpl = globalThis.fetch }) {
  const stateFile = path.join(root, STATE_FILE);
  // Directories to serve from, newest first. Old builds stay behind the new
  // one so a page that is still open can load the chunks it was built with.
  let dirs = [bundledDir];

  const versionOf = (dir) => readJson(path.join(dir, "version.json"));

  /** Picks the newest of the installed client and any downloaded one. */
  async function load() {
    const state = await readJson(stateFile);
    const bundled = await versionOf(bundledDir);
    const downloaded = [];
    for (const commit of Array.isArray(state?.bundles) ? state.bundles : []) {
      if (typeof commit !== "string" || !COMMIT.test(commit)) continue;
      const dir = path.join(root, commit);
      const version = await versionOf(dir);
      if (version?.commit === commit) downloaded.push(dir);
    }
    // A newer installer brings a newer client than anything downloaded before.
    const newest = downloaded[0];
    dirs = newest && isNewerBuild(bundled, await versionOf(newest)) ? [...downloaded, bundledDir] : [bundledDir];
    return current();
  }

  const current = () => versionOf(dirs[0]);

  async function fetchOk(url) {
    const response = await fetchImpl(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`Downloading ${new URL(url).pathname} failed (${response.status}).`);
    return response;
  }

  async function existingCopy(file) {
    for (const dir of dirs) {
      try {
        const bytes = await readFile(path.join(dir, file.path));
        if (bytes.length === file.size && sha256(bytes) === file.sha256) return bytes;
      } catch { /* Not in that build. */ }
    }
    return null;
  }

  /** Downloads the production client when it is newer than the one in use.
   * Returns its version once it is ready to serve, otherwise null. */
  async function update() {
    const own = await current();
    const latest = await (await fetchOk(new URL("/version.json", origin))).json();
    if (!isNewerBuild(own, latest)) return null;
    const files = validateManifest(await (await fetchOk(new URL(`/${BUNDLE_MANIFEST}`, origin))).json(), latest);

    await mkdir(root, { recursive: true });
    const target = path.join(root, latest.commit);
    const partial = `${target}.partial`;
    await rm(partial, { recursive: true, force: true });
    for (const file of files) {
      // Unchanged files (most hashed chunks) are copied, not downloaded again.
      let bytes = await existingCopy(file);
      if (!bytes) {
        bytes = Buffer.from(await (await fetchOk(new URL(`/${file.path}`, origin))).arrayBuffer());
        if (bytes.length !== file.size || sha256(bytes) !== file.sha256) {
          throw new Error(`${file.path} did not match the update's checksum.`);
        }
      }
      const destination = path.join(partial, ...file.path.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
    }
    await rm(target, { recursive: true, force: true });
    await rename(partial, target);

    // Keep the previous download as a fallback for open pages, drop the rest.
    const previous = dirs[0] === bundledDir ? [] : [path.basename(dirs[0])];
    const keep = [latest.commit, ...previous];
    await writeFile(stateFile, `${JSON.stringify({ bundles: keep })}\n`);
    for (const name of await readdir(root)) {
      if (name !== STATE_FILE && !keep.includes(name)) await rm(path.join(root, name), { recursive: true, force: true });
    }
    dirs = [...keep.map((commit) => path.join(root, commit)), bundledDir];
    return latest;
  }

  return { load, update, current, dirs: () => [...dirs] };
}
