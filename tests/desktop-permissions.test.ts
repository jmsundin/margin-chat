import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { allowsPermissionCheck, allowsPermissionRequest, createPermissionHandlers } from "../desktop/permissions.mjs";

const desktop = new URL("../desktop/", import.meta.url).pathname;
// The same rule as isAppUrl in desktop/main.mjs, with the dev server at localhost:5173.
const isAppUrl = (raw: string) => {
  try {
    const url = new URL(raw);
    if (url.protocol === "margin:") return url.host === "app";
    return url.origin === "http://localhost:5173";
  } catch {
    return false;
  }
};

test("pages ask for only what the vault, editor and voice typing use, and only the app's own pages get it", () => {
  for (const permission of ["fileSystem", "clipboard-read", "clipboard-sanitized-write"]) {
    expect(allowsPermissionRequest(permission, {}, "margin://app/", isAppUrl)).toBe(true);
    expect(allowsPermissionRequest(permission, {}, "http://localhost:5173/notes", isAppUrl)).toBe(true);
    expect(allowsPermissionRequest(permission, {}, "https://example.com/", isAppUrl)).toBe(false);
  }
  expect(allowsPermissionRequest("media", { mediaTypes: ["audio"] }, "margin://app/", isAppUrl)).toBe(true);
  expect(allowsPermissionRequest("media", { mediaTypes: ["audio", "video"] }, "margin://app/", isAppUrl)).toBe(false);
  expect(allowsPermissionRequest("media", { mediaTypes: [] }, "margin://app/", isAppUrl)).toBe(false);
  expect(allowsPermissionRequest("media", {}, "margin://app/", isAppUrl)).toBe(false);
  for (const permission of ["geolocation", "notifications", "midi", "openExternal", "display-capture"]) {
    expect(allowsPermissionRequest(permission, {}, "margin://app/", isAppUrl)).toBe(false);
  }
});

test("a folder chosen before stays readable for the app itself, and other checks keep Electron's answer", () => {
  expect(allowsPermissionCheck("fileSystem", "margin://app", isAppUrl)).toBe(true);
  expect(allowsPermissionCheck("fileSystem", "http://localhost:5173", isAppUrl)).toBe(true);
  for (const origin of ["https://example.com", "margin://other", "file://", "", "null"]) {
    expect(allowsPermissionCheck("fileSystem", origin, isAppUrl)).toBe(false);
  }
  expect(allowsPermissionCheck("fileSystem", undefined, isAppUrl)).toBe(false);
  // Electron's default when no check handler is set.
  for (const permission of ["clipboard-read", "clipboard-sanitized-write", "media", "notifications", "geolocation", "serial", "hid"]) {
    expect(allowsPermissionCheck(permission, "https://example.com", isAppUrl)).toBe(true);
  }
  expect(allowsPermissionCheck("deprecated-sync-clipboard-read", "margin://app", isAppUrl)).toBe(false);
});

test("the session handlers apply the policies, including checks with no page attached", () => {
  const handlers = createPermissionHandlers(isAppUrl);
  const answers: boolean[] = [];
  const page = (url: string) => ({ getURL: () => url });
  handlers.request(page("margin://app/"), "fileSystem", (allowed: boolean) => answers.push(allowed), {});
  handlers.request(page("https://example.com/"), "fileSystem", (allowed: boolean) => answers.push(allowed), {});
  handlers.request(page("margin://app/"), "media", (allowed: boolean) => answers.push(allowed), { mediaTypes: ["audio"] });
  expect(answers).toEqual([true, false, true]);
  expect(handlers.check(null, "fileSystem", "margin://app", {})).toBe(true);
  expect(handlers.check(null, "fileSystem", "https://example.com", {})).toBe(false);
  expect(handlers.check(page("margin://app/"), "deprecated-sync-clipboard-read", "margin://app", {})).toBe(false);
});

test("every file main.mjs loads is packaged into the app", async () => {
  const { build } = JSON.parse(await readFile(path.join(desktop, "package.json"), "utf8"));
  const packaged = new Set(build.files);
  const seen = new Set<string>();
  const queue = ["main.mjs"];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = await readFile(path.join(desktop, file), "utf8");
    for (const [, specifier] of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
      queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)));
    }
  }
  expect([...seen]).toContain("permissions.mjs");
  for (const file of seen) expect(packaged.has(file), `${file} is loaded by main.mjs but missing from build.files`).toBe(true);
});
