import { expect, test } from "bun:test";

test("document link picker searches content and selects stable document or block targets", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/documentLinkPickerHarness.tsx"], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 20000);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timeout);
  if (code !== 0) throw new Error(`Document link picker integration failed:\n${stdout}\n${stderr}`);
  expect(stdout).toContain("Document link picker checks passed.");
}, 25000);
