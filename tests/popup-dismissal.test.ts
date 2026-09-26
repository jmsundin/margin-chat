import { expect, test } from "bun:test";

test("popups dismiss outside while preserving inner controls and nested modal interactions", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/popupDismissalHarness.tsx"], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 10000);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timeout);
  if (code) throw new Error(`Popup dismissal checks failed:\n${stdout}\n${stderr}`);
  expect(stdout).toContain("Popup dismissal checks passed.");
}, 15000);
