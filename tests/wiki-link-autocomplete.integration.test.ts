import { expect, test } from "bun:test";

test("typing [[ in the Live Preview editor offers vault documents to link to", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/wikiLinkAutocompleteHarness.tsx"], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 20000);
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timeout);
  if (exitCode !== 0) throw new Error(`Wiki link autocomplete regression failed:\n${stdout}\n${stderr}`);
  expect(stdout).toContain("wiki link autocomplete ok");
}, 25000);
