import { expect, test } from "bun:test";
import { resolveAppCommit } from "../client/build/app-version.mjs";

test("release builds use the reviewed SHA before provider metadata or local Git", () => {
  const release = "a".repeat(40);
  const provider = "b".repeat(40);
  expect(resolveAppCommit({ MARGIN_RELEASE_SHA: release, VERCEL_GIT_COMMIT_SHA: provider }, ".", () => "c".repeat(40))).toBe(release);
  expect(resolveAppCommit({ VERCEL_GIT_COMMIT_SHA: provider }, ".")).toBe(provider);
  expect(resolveAppCommit({}, ".", () => `${release}\n`)).toBe(release);
  expect(resolveAppCommit({}, ".", () => { throw new Error("no git"); })).toBe("unknown");
  expect(() => resolveAppCommit({ MARGIN_RELEASE_SHA: "not-a-commit" }, ".")).toThrow("full Git commit");
});

test("update checks and mounted notifications handle waiting, loaded, dismissed, and offline states", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/appUpdatesHarness.ts"], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 10_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  clearTimeout(timeout);
  if (exitCode !== 0) throw new Error(`Update regression failed:\n${stdout}\n${stderr}`);
  expect(stdout).toContain("pass");
}, 15000);
