// The desktop shell's own settings, in the app's data folder. Small, plain JSON,
// read once at launch. Separate from the client's settings (workspace.json), which
// travel with the vault.
import { readFileSync } from "node:fs";
import path from "node:path";

export const SETTINGS_FILE = "desktop-settings.json";

/** Defaults: the native vault (vault I/O in the main process) is off until its acceptance tests pass. */
export const DEFAULT_SETTINGS = Object.freeze({ nativeVault: false });

/**
 * Reads the shell settings. The environment can turn the native vault on or off
 * for one run (`MARGIN_DESKTOP_NATIVE_VAULT=1` / `0`), which is how it is tried
 * before it becomes the default.
 */
export function readDesktopSettings(dataDir, env = process.env, read = (file) => readFileSync(file, "utf8")) {
  let stored = {};
  try {
    const parsed = JSON.parse(read(path.join(dataDir, SETTINGS_FILE)));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) stored = parsed;
  } catch {
    // Missing or unreadable settings are the defaults.
  }
  const settings = { ...DEFAULT_SETTINGS, nativeVault: stored.nativeVault === true };
  const override = env.MARGIN_DESKTOP_NATIVE_VAULT?.trim();
  if (override === "1" || override === "true") settings.nativeVault = true;
  if (override === "0" || override === "false") settings.nativeVault = false;
  return settings;
}
