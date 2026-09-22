import { expect, test } from "bun:test";

test("topic expansion controls create editable child notes and apply AI results only after successful completion", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/topicExpansionInteractionHarness.tsx"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 15000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  clearTimeout(timeout);
  if (exitCode !== 0) throw new Error(`Topic expansion interaction check failed:\n${stdout}\n${stderr}`);
  expect(stdout).toContain("Child-note editing, AI single-flight, cancel, success, retry, and account-switch checks passed.");
}, 20000);
