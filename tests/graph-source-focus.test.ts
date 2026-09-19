import { expect, test } from "bun:test";

test("graph sources reveal their reader context without losing later navigation", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/graphSourceFocusHarness.tsx"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 10000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  clearTimeout(timeout);
  if (exitCode !== 0) throw new Error(`Graph source reader check failed:\n${stdout}\n${stderr}`);
  expect(stdout).toContain("Graph source reader focus checks passed.");
}, 15000);
