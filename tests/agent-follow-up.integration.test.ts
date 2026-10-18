import { expect, test } from "bun:test";

test("a document shows an agent's question with answers to pick, and its proposed changes with Approve and Dismiss", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/agentFollowUpHarness.tsx"], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 20000);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timeout);
  if (code !== 0) throw new Error(`Agent follow-up integration failed:\n${stdout}\n${stderr}`);
  expect(JSON.parse(stdout.trim().split("\n").at(-1)!).checks).toHaveLength(4);
}, 25000);
