import { expect, test } from "bun:test";

test("React vault hook hydrates offline and preserves typing across network and local-write awaits", async () => {
  // Run browser globals in a child so React DOM cannot alter other test suites.
  const child = Bun.spawn([process.execPath, "tests/helpers/vaultHookHarness.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 10000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  clearTimeout(timeout);
  if (exitCode !== 0) throw new Error(`Vault hook integration failed:\n${stdout}\n${stderr}`);
  const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
  expect(result.checks).toHaveLength(17);
}, 15000);

test("empty workspace settings survive automatic sync and offline reopen without resurrecting deleted documents", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/vaultHookHarness.ts", "--empty-settings"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 10000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  clearTimeout(timeout);
  if (exitCode !== 0) throw new Error(`Empty vault settings integration failed:\n${stdout}\n${stderr}`);
  expect(JSON.parse(stdout.trim().split("\n").at(-1)!).checks).toHaveLength(5);
}, 15000);


test("ChatGPT history imports preserve writing, sync, undo safely, and reopen offline", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/vaultHookHarness.ts", "--chat-history"], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 10000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  clearTimeout(timeout);
  if (exitCode !== 0) throw new Error(`History integration failed:\n${stdout}\n${stderr}`);
  expect(JSON.parse(stdout.trim().split("\n").at(-1)!).checks).toHaveLength(6);
}, 15000);
