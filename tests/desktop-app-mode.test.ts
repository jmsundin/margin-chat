import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CAPABILITIES_PATH, MODE_PATHS, readAppMode, saveAppMode } from "../desktop/appMode.mjs";
import { DESKTOP_CAPABILITIES_PATH, DESKTOP_MODE_PATHS } from "../client/src/lib/desktopMode";

// New installs run with no account; signing in switches the app (docs/desktop-local-mode.md).
function withDir(run: (dir: string) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), "margin-mode-"));
  try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("desktop app mode", () => {
  test("a new install starts without an account, and remembers it", () => withDir((dir) => {
    expect(readAppMode({ userDataDir: dir })).toBe("local");
    expect(JSON.parse(readFileSync(path.join(dir, "app-mode.json"), "utf8"))).toEqual({ mode: "local" });
  }));

  test("an app already used signed in stays signed in", () => withDir((dir) => {
    mkdirSync(path.join(dir, "Network"));
    writeFileSync(path.join(dir, "Network", "Cookies"), "");
    expect(readAppMode({ userDataDir: dir })).toBe("account");
    // Once saved, the choice holds even after the cookie jar appears or goes.
    rmSync(path.join(dir, "Network"), { recursive: true });
    expect(readAppMode({ userDataDir: dir })).toBe("account");
  }));

  test("switching is saved, and development can pick either", () => withDir((dir) => {
    saveAppMode({ userDataDir: dir, mode: "account" });
    expect(readAppMode({ userDataDir: dir })).toBe("account");
    saveAppMode({ userDataDir: dir, mode: "local" });
    expect(readAppMode({ userDataDir: dir })).toBe("local");
    expect(readAppMode({ userDataDir: dir, override: "0" })).toBe("account");
    expect(readAppMode({ userDataDir: dir, override: "1" })).toBe("local");
    expect(() => saveAppMode({ userDataDir: dir, mode: "cloud" })).toThrow();
  }));

  test("a damaged mode file falls back instead of stopping the app", () => withDir((dir) => {
    writeFileSync(path.join(dir, "app-mode.json"), "{not json");
    expect(readAppMode({ userDataDir: dir })).toBe("local");
  }));

  test("the page and the app agree on the switch paths", () => {
    expect(DESKTOP_CAPABILITIES_PATH).toBe(CAPABILITIES_PATH);
    expect(MODE_PATHS[DESKTOP_MODE_PATHS.account]).toBe("account");
    expect(MODE_PATHS[DESKTOP_MODE_PATHS.local]).toBe("local");
  });
});
