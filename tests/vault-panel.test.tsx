import { expect, test } from "bun:test";

test("saved vault alternatives are optional and restore actions identify complete versions", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/vaultPanelHarness.tsx"], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 10_000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  clearTimeout(timeout);
  if (code !== 0) throw new Error(`Vault panel integration failed:\n${stdout}\n${stderr}`);
  expect(JSON.parse(stdout.trim().split("\n").at(-1)!).checks).toEqual([
    "alternatives do not block cloud status or sync",
    "whole-version restore and keep-current actions remain distinct",
    "legacy records and deletions remain optional and explicit",
  ]);
}, 15_000);
