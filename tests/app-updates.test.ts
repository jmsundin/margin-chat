import { expect, test } from "bun:test";
import { resolveAppCommit, resolveAppCommitTime } from "../client/build/app-version.mjs";

test("release builds use the reviewed SHA before provider metadata or local Git", () => {
  const release = "a".repeat(40);
  const provider = "b".repeat(40);
  expect(resolveAppCommit({ MARGIN_RELEASE_SHA: release, VERCEL_GIT_COMMIT_SHA: provider }, ".", () => "c".repeat(40))).toBe(release);
  expect(resolveAppCommit({ VERCEL_GIT_COMMIT_SHA: provider }, ".")).toBe(provider);
  expect(resolveAppCommit({}, ".", () => `${release}\n`)).toBe(release);
  expect(resolveAppCommit({}, ".", () => { throw new Error("no git"); })).toBe("unknown");
  expect(() => resolveAppCommit({ MARGIN_RELEASE_SHA: "not-a-commit" }, ".")).toThrow("full Git commit");
});

test("release builds carry the reviewed commit time, local builds read it from Git", () => {
  const sha = "a".repeat(40);
  expect(resolveAppCommitTime({ MARGIN_RELEASE_COMMITTED_AT: "2026-10-09T12:00:00+02:00" }, ".", sha)).toBe("2026-10-09T10:00:00.000Z");
  expect(() => resolveAppCommitTime({ MARGIN_RELEASE_COMMITTED_AT: "soon" }, ".", sha)).toThrow("ISO date");
  expect(resolveAppCommitTime({}, ".", sha, (args) => { expect(args).toEqual(["show", "-s", "--format=%cI", sha]); return "2026-10-01T00:00:00Z\n"; })).toBe("2026-10-01T00:00:00.000Z");
  expect(resolveAppCommitTime({}, ".", sha, () => { throw new Error("no git"); })).toBeNull();
  expect(resolveAppCommitTime({}, ".", "unknown")).toBeNull();
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
