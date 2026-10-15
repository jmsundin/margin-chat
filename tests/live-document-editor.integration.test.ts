import { expect, test } from "bun:test";

test("the Live Preview document editor saves blocks, reports passages and opens Ask AI", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/liveDocumentEditorHarness.tsx"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 20000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  clearTimeout(timeout);
  if (exitCode !== 0) throw new Error(`Live document editor regression failed:\n${stdout}\n${stderr}`);
  expect(stdout).toContain("live document editor ok");
}, 25000);
