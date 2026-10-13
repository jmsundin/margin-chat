import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export const DESKTOP_BUNDLE_FILE = "desktop-bundle.json";

/** Every file in the built client with its size and SHA-256, so the desktop app
 * can download this exact build from the website and check each file. */
export function listBundleFiles(outDir) {
  const files = [];
  const walk = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) { walk(path); continue; }
      const file = relative(outDir, path).split(sep).join("/");
      if (file === DESKTOP_BUNDLE_FILE || file.endsWith(".map")) continue;
      const bytes = readFileSync(path);
      files.push({ path: file, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
  };
  walk(outDir);
  return files;
}

export function desktopBundlePlugin(version) {
  let outDir = "dist";
  return {
    name: "marginchat-desktop-bundle",
    apply: "build",
    enforce: "post",
    configResolved(config) { outDir = resolve(config.root, config.build.outDir); },
    // Runs after the public folder and every emitted asset are on disk.
    closeBundle: {
      order: "post",
      handler() {
        writeFileSync(join(outDir, DESKTOP_BUNDLE_FILE), `${JSON.stringify({ ...version, files: listBundleFiles(outDir) })}\n`);
      },
    },
  };
}
