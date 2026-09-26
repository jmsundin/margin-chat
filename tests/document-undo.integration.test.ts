import { expect, test } from "bun:test";

test("document keyboard undo and redo cover text, formatting, structure, and Markdown source without crossing document boundaries", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/documentUndoHarness.tsx"], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 25000);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timeout);
  if (code !== 0) throw new Error(`Document undo integration failed:\n${stdout}\n${stderr}`);
  expect(JSON.parse(stdout.trim().split("\n").at(-1)!).checks).toHaveLength(11);
}, 30000);
