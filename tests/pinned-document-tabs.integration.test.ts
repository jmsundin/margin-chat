import { expect, test } from "bun:test";

test("pinned tab icons preview current documents and retain keyboard and context actions", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/pinnedDocumentTabsHarness.tsx"], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 15000);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timeout);
  if (code !== 0) throw new Error(`Pinned tab integration failed:\n${stdout}\n${stderr}`);
  expect(stdout).toContain("Pinned preview and context actions verified.");
}, 20000);
