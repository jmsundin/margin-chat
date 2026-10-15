import { expect, test } from "bun:test";

test("vault shows save and sync status while keeping recovery history in the background", async () => {
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
    "background history does not change saved status or request a choice",
    "sync and independent backup actions remain available",
    "real storage and sync errors remain visible",
    "recently deleted documents can be restored",
    "free accounts see whether a copy exists outside the browser",
    "desktop shows the vault folder and says when it can't be found",
  ]);
}, 15_000);
