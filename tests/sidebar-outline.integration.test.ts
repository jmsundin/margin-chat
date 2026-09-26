import { expect, test } from "bun:test";

test("the expanded sidebar outline keeps navigation and workspace actions reachable", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/sidebarOutlineHarness.tsx"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 10000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  clearTimeout(timeout);
  if (exitCode !== 0) throw new Error(`Sidebar outline regression failed:\n${stdout}\n${stderr}`);
  expect(JSON.parse(stdout.trim().split("\n").at(-1)!).checks).toHaveLength(8);
}, 15000);
