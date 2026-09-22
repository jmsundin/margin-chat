import { expect, test } from "bun:test";

test("graph exploration connects concepts, evidence, atlas group fitting, and navigation history", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/graphExplorationInteractionHarness.tsx"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 15000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  clearTimeout(timeout);
  if (exitCode !== 0) throw new Error(`Graph exploration interaction check failed:\n${stdout}\n${stderr}`);
  expect(stdout).toContain("Graph concept, source, search, scope, focus, history, account-isolation, and atlas navigation checks passed.");
  expect(stdout).toContain("Personal connection subgraphs preserve strict neighborhoods, inbound links, anchor, pivot depth, arrangement, history, and remount camera.");
}, 20000);
