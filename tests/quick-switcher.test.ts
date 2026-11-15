import { expect, test } from "bun:test";

test("Cmd+O finds documents by title and creates one when none matches", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/quickSwitcherHarness.ts"], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 12000);
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timeout);
  if (exitCode !== 0) throw new Error(`Quick switcher regression failed:\n${stdout}\n${stderr}`);
  expect(JSON.parse(stdout.trim().split("\n").at(-1)!).checks).toHaveLength(7);
}, 15000);
