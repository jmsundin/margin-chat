import { expect, test } from "bun:test";

test("document views menu preserves views, counts, dismissal, and keyboard navigation", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/documentViewsMenuHarness.tsx"], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 20000);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timeout);
  if (code !== 0) throw new Error(`Document views menu integration failed:\n${stdout}\n${stderr}`);
  expect(JSON.parse(stdout.trim().split("\n").at(-1)!).checks).toHaveLength(8);
}, 25000);
