import { expect, test } from "bun:test";
import { checkForUpdatesNow } from "../desktop/updateCheck.mjs";
import { publishReadyUpdate, readDesktopAnswer, readReadyUpdate } from "../client/src/lib/appUpdateCheck";

const A = "a".repeat(40);
const B = "b".repeat(40);

test("the desktop app checks both the client and itself, and says what is ready", async () => {
  const calls: string[] = [];
  const answer = await checkForUpdatesNow({
    appVersion: "0.1.2",
    checkClient: async () => { calls.push("client"); return null; },
    currentClient: async () => ({ commit: B }),
    checkShell: async () => { calls.push("shell"); return { version: "0.1.3", manual: false, path: "/secret" }; },
    downloadUrl: "https://example.test/download",
  });
  expect(calls.sort()).toEqual(["client", "shell"]);
  expect(answer).toEqual({ appVersion: "0.1.2", clientCommit: B, app: { version: "0.1.3", manual: false }, downloadUrl: null, errors: [] });
});

test("local mode skips the client, and failed checks are reported, not thrown", async () => {
  const answer = await checkForUpdatesNow({
    appVersion: "0.1.2", checkClient: null, currentClient: async () => ({ commit: B }),
    checkShell: async () => { throw new Error("Update check failed (503)."); }, downloadUrl: "x",
  });
  expect(answer.clientCommit).toBeNull();
  expect(answer.app).toBeNull();
  expect(answer.errors).toEqual(["Update check failed (503)."]);
});

test("a copy that can't replace itself offers the download page", async () => {
  const answer = await checkForUpdatesNow({
    appVersion: "0.1.2", checkClient: async () => null, currentClient: async () => ({ commit: A }),
    checkShell: async () => ({ version: "0.2.0", manual: true }), downloadUrl: "https://example.test/download",
  });
  expect(readDesktopAnswer(answer, A).result).toEqual({ status: "manual", version: "0.2.0", downloadUrl: "https://example.test/download" });
});

test("the page reads the desktop answer against the client it runs", () => {
  expect(readDesktopAnswer({ appVersion: "0.1.2", clientCommit: A, app: null, errors: [] }, A))
    .toEqual({ result: { status: "latest" }, kind: null, appVersion: "0.1.2" });
  // The app downloaded a newer client than this page loaded.
  expect(readDesktopAnswer({ clientCommit: B, app: null }, A)).toMatchObject({ result: { status: "ready" }, kind: "client" });
  // A new app wins over a new client.
  expect(readDesktopAnswer({ clientCommit: B, app: { version: "0.2.0", manual: false } }, A)).toMatchObject({ kind: "app" });
  expect(readDesktopAnswer({ clientCommit: A, app: null, errors: ["offline"] }, A).result).toEqual({ status: "failed", message: "offline" });
});

test("the ready update is shared between the toast and Settings", () => {
  const update = { restart: async () => {} };
  publishReadyUpdate(update);
  expect(readReadyUpdate()).toBe(update);
  publishReadyUpdate(null);
  expect(readReadyUpdate()).toBeNull();
});
