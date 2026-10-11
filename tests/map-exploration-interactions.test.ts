import { expect, test } from "bun:test";

test("the map search previews Wikipedia, pages and AI answers, keeps them as notes, and remembers the rest", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/mapExplorationInteractionHarness.tsx"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 15000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  clearTimeout(timeout);
  if (exitCode !== 0) throw new Error(`Map exploration interaction check failed:\n${stdout}\n${stderr}`);
  expect(stdout).toContain("Map search previews, keep, history, paste, page mapping, AI answers, and account saving passed.");
}, 20000);
