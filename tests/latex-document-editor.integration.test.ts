import { expect, test } from "bun:test";

test("LaTeX documents render, roundtrip, and support equation editing without losing source or history", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/latexDocumentEditorHarness.tsx"], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 20000);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timeout);
  if (code !== 0) throw new Error(`LaTeX document editor regression:\n${stdout}\n${stderr}`);
  expect(JSON.parse(stdout.trim().split("\n").at(-1)!).checks).toHaveLength(12);
}, 25000);
