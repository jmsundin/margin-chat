import { expect, test } from "bun:test";

test("map loads document bodies only in the viewport and defers incoming content during camera movement", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/mapViewportContentHarness.tsx"], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 20000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  clearTimeout(timeout);
  if (code !== 0) throw new Error(`Map viewport content integration failed:\n${stdout}\n${stderr}`);
  expect(JSON.parse(stdout.trim().split("\n").at(-1)!).checks).toHaveLength(7);
}, 25000);
