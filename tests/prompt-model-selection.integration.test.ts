import { expect, test } from "bun:test";

test("prompt submissions use the explicit model even before the picker update commits", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/promptModelSelectionHarness.tsx"], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 20000);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timeout);
  if (code !== 0) throw new Error(`Prompt model selection regression failed:\n${stdout}\n${stderr}`);
  expect(stdout).toContain("Luna selection verified for inline, rerun, and side-document requests.");
}, 25000);
