import { expect, test } from "bun:test";

test("semantic map groups cache permitted evidence and preserve stable ordering across async lifecycle changes", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/jevGroupCategoriesHarness.tsx"], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 15000);
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timeout);
  if (exitCode !== 0) throw new Error(`Jev map group lifecycle failed:\n${stdout}\n${stderr}`);
  expect(stdout).toContain("Jev map groups preserve consent, cached evidence, stable layout, uncertainty, account isolation, cancellation, and bounded batches.");
}, 20000);
