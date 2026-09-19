import { expect, test } from "bun:test";

test("real note editors preserve sync, keyboard focus, and margin-note actions", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/noteEditorSyncHarness.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 10000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  clearTimeout(timeout);
  if (exitCode !== 0) throw new Error(`Note editor sync regression failed:\n${stdout}\n${stderr}`);
  const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
  expect(result.checks).toHaveLength(10);
}, 15000);
