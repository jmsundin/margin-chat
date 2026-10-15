import { expect, test } from "bun:test";

test("the desktop vault folder screen asks for a folder, confirms a large one, and never acts on its own", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/vaultFolderGateHarness.tsx"], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 10_000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  clearTimeout(timeout);
  if (code !== 0) throw new Error(`Vault folder screen integration failed:\n${stdout}\n${stderr}`);
  expect(JSON.parse(stdout.trim().split("\n").at(-1)!).checks).toEqual([
    "first run offers open, create and Not now",
    "a picked folder is counted, then connected with progress shown",
    "a very large folder is confirmed before it is opened",
    "a new vault is named, placed, and offers to open a folder that is already there",
    "a remembered folder needs one click to allow",
    "a missing folder offers to choose it again, try again or use another, and writes nothing",
  ]);
}, 15_000);
