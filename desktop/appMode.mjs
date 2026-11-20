// Which way the app runs: "local" (everything on this computer, no account; docs/desktop-local-mode.md)
// or "account" (signed in to marginchat.com). New installs start local. Signing in from Settings, or
// "Use without an account" on the sign-in page, switches it and restarts the app.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const APP_MODES = ["local", "account"];
/** Pages ask for a switch by opening one of these; only the app's own pages can reach them. */
export const MODE_PATHS = { "/__margin/use-account": "account", "/__margin/use-local": "local" };
/** Lets a page check that this app can switch modes (an older app answers with the page instead). */
export const CAPABILITIES_PATH = "/__margin/capabilities";

/**
 * The saved mode, else the mode for this install: an app that was already used signed in (it has a cookie
 * jar from before local mode existed) stays signed in, and a new install runs on its own.
 * `override` is MARGIN_DESKTOP_LOCAL ("1" local, "0" account) for development.
 */
export function readAppMode({ userDataDir, override = null }) {
  if (override === "1") return "local";
  if (override === "0") return "account";
  const file = path.join(userDataDir, "app-mode.json");
  let saved = null;
  try { saved = JSON.parse(readFileSync(file, "utf8"))?.mode; } catch { saved = null; }
  if (APP_MODES.includes(saved)) return saved;
  const usedBefore = existsSync(path.join(userDataDir, "Cookies")) || existsSync(path.join(userDataDir, "Network", "Cookies"));
  const mode = usedBefore ? "account" : "local";
  saveAppMode({ userDataDir, mode });
  return mode;
}

export function saveAppMode({ userDataDir, mode }) {
  if (!APP_MODES.includes(mode)) throw new Error(`Unknown app mode: ${mode}`);
  mkdirSync(userDataDir, { recursive: true });
  const file = path.join(userDataDir, "app-mode.json");
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ mode })}\n`);
  renameSync(temporary, file);
}
