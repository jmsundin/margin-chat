import { expect, test } from "bun:test";

test("URL map preserves evidence and history while supporting focal zoom, touch, keyboard, and details", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/urlMapInteractionHarness.tsx"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 15000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  clearTimeout(timeout);
  if (exitCode !== 0) throw new Error(`URL map interaction check failed:\n${stdout}\n${stderr}`);
  expect(stdout).toContain("URL map linked-page reveal, saved topics, keyboard relationships, and history passed.");
}, 20000);
