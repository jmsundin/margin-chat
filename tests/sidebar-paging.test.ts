import { expect, test } from "bun:test";

test("a sidebar with thousands of documents renders a page at a time", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/sidebarPagingHarness.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 10000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  clearTimeout(timeout);
  if (exitCode !== 0) throw new Error(`Sidebar paging check failed:\n${stdout}\n${stderr}`);
  expect(stdout).toContain("Sidebar paging checks passed.");
}, 15000);
