import { expect, test } from "bun:test";

test("document relationship controls reveal exact destinations and keep labels out of SVG masks", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/documentConnectorsHarness.tsx"], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 15000);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timeout);
  if (code !== 0) throw new Error(`Document connectors failed:\n${stdout}\n${stderr}`);
  expect(stdout).toContain("document connector interactions passed");
}, 20000);
