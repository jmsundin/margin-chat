import { expect, test } from "bun:test";

test("document tabs pin, restore, minimize, and reorder documents with accessible keyboard navigation", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/documentTabsHarness.tsx"], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 20000);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timeout);
  if (code !== 0) throw new Error(`Document tabs integration failed:\n${stdout}\n${stderr}`);
  expect(JSON.parse(stdout.trim().split("\n").at(-1)!).checks).toHaveLength(15);
}, 25000);
