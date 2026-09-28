import { expect, test } from "bun:test";

test("mobile keyboard is opt-in, preserves selections, and keeps the AI composer in the visual viewport", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/mobileKeyboardHarness.tsx"], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 20000);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timeout);
  if (code !== 0) throw new Error(`Mobile keyboard regression:\n${stdout}\n${stderr}`);
  expect(stdout).toContain("Mobile keyboard and viewport integration passed");
}, 25000);
