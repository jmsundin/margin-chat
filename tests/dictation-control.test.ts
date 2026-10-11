import { expect, test } from "bun:test";

test("voice typing records, transcribes and types into every kind of text field", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/dictationHarness.tsx"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 15000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  clearTimeout(timeout);
  if (exitCode !== 0) throw new Error(`Voice typing regression failed:\n${stdout}\n${stderr}`);
  const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
  expect(result.checks).toHaveLength(7);
}, 20000);
