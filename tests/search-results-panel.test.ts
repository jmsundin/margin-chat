import { expect, test } from "bun:test";

test("kept search results group by family, filter by year, and open beside", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/searchResultsPanelHarness.ts"], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 12000);
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timeout);
  if (exitCode !== 0) throw new Error(`Search results panel regression failed:\n${stdout}\n${stderr}`);
  expect(JSON.parse(stdout.trim().split("\n").at(-1)!).checks).toHaveLength(4);
}, 15000);
