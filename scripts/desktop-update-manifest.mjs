// Writes desktop-update.json for a Desktop release: the installer each
// platform updates itself from, with its size and SHA-512. The desktop app
// (desktop/shellUpdater.mjs) installs nothing that doesn't match it.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const UPDATE_FILES = { mac: /\.zip$/u, windows: /\.exe$/u, linux: /\.AppImage$/u };

export function buildUpdateManifest(directory, { version, commit }) {
  const names = readdirSync(directory);
  const files = {};
  for (const [key, pattern] of Object.entries(UPDATE_FILES)) {
    const matches = names.filter((name) => pattern.test(name));
    if (matches.length !== 1) throw new Error(`Expected one ${key} update file, found ${matches.length}.`);
    const bytes = readFileSync(join(directory, matches[0]));
    files[key] = { name: matches[0], size: bytes.length, sha512: createHash("sha512").update(bytes).digest("hex") };
  }
  return { version, commit, files };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [directory, version, commit] = process.argv.slice(2);
  const manifest = buildUpdateManifest(directory, { version, commit });
  writeFileSync(join(directory, "desktop-update.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify(manifest, null, 2));
}
