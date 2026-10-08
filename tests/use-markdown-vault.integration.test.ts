import { expect, test } from "bun:test";

test("pending feature projections stay visible without retrying successful cloud uploads", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/vaultHookHarness.ts", "--projection-pending"], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 10000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  clearTimeout(timeout);
  if (exitCode !== 0) throw new Error(`Projection status integration failed:\n${stdout}\n${stderr}`);
  expect(JSON.parse(stdout.trim().split("\n").at(-1)!).checks).toHaveLength(4);
}, 15000);

test("a new device opens recent documents first and downloads the rest when opened", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/vaultHookHarness.ts", "--partial-load"], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 10000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  clearTimeout(timeout);
  if (exitCode !== 0) throw new Error(`Partial vault load integration failed:\n${stdout}\n${stderr}`);
  expect(JSON.parse(stdout.trim().split("\n").at(-1)!).checks).toHaveLength(8);
}, 15000);

test("last focused document survives reopening without editing or syncing", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/vaultHookHarness.ts", "--document-focus"], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 10000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  clearTimeout(timeout);
  if (exitCode !== 0) throw new Error(`Document focus integration failed:\n${stdout}\n${stderr}`);
  expect(JSON.parse(stdout.trim().split("\n").at(-1)!).checks).toHaveLength(8);
}, 15000);

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
  expect(result.checks).toHaveLength(18);
}, 15000);

test("starter document text is saved, and empty workspace settings survive automatic sync and offline reopen without resurrecting deleted documents", async () => {
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
  expect(JSON.parse(stdout.trim().split("\n").at(-1)!).checks).toHaveLength(6);
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
