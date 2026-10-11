import { expect, test } from "bun:test";

test("joining, splitting, pasting and selecting lines keep each line's identity and provenance", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/continuousEditorHarness.ts"], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 20000);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timeout);
  if (code !== 0) throw new Error(`Continuous editor regression:\n${stdout}\n${stderr}`);
  expect(JSON.parse(stdout.trim().split("\n").at(-1)!).checks).toHaveLength(6);
}, 25000);
