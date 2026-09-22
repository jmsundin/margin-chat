import { expect, test } from "bun:test";

test("formatted document editors preserve source, cursor, streaming isolation, and inline AI shortcuts", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/richDocumentEditorHarness.ts"], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 20000);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timeout);
  if (code !== 0) throw new Error(`Rich document editor regression:\n${stdout}\n${stderr}`);
  expect(JSON.parse(stdout.trim().split("\n").at(-1)!).checks).toHaveLength(13);
}, 25000);
