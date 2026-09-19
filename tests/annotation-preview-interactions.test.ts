import { expect, test } from "bun:test";

test("saved highlights preview current content without disrupting navigation or selection", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/annotationPreviewHarness.ts"], { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 12000);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  if (code) throw new Error(`Annotation preview checks failed:\n${stdout}\n${stderr}`);
  expect(JSON.parse(stdout.trim().split("\n").at(-1)!).checks).toHaveLength(10);
}, 15000);
