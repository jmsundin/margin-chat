import { expect, test } from "bun:test";

test("rich document blocks save wiki links, brackets, dollars and table pipes without changing their meaning", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/documentMarkdownRoundTripHarness.ts"], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`Document Markdown round-trip regression:\n${stdout}\n${stderr}`);
  expect(JSON.parse(stdout.trim().split("\n").at(-1)!).checks).toHaveLength(8);
}, 25000);
