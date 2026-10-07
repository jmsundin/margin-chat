import { expect, test } from "bun:test";

test("breadcrumb levels expand documents here, open them beside, and go back", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/documentBreadcrumbsHarness.tsx"], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 50000);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timeout);
  if (code !== 0) throw new Error(`Breadcrumb integration failed:\n${stdout}\n${stderr}`);
  expect(JSON.parse(stdout.trim().split("\n").at(-1)!).passed).toBe(true);
}, 60000);
