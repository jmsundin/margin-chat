import { expect, test } from "bun:test";

test("sidebar secondary actions and the Add to space and Add to group pickers stay operable", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/sidebarActionsHarness.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 10000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  clearTimeout(timeout);
  if (exitCode !== 0) throw new Error(`Sidebar interaction check failed:\n${stdout}\n${stderr}`);
  expect(stdout).toContain("Sidebar action, keyboard dismissal, group creation, and Add to space/group picker checks passed.");
}, 15000);
