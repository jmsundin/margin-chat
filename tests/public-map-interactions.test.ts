import { expect, test } from "bun:test";

test("public and personal maps preserve saved identity and navigation across their complete interaction flow", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/publicMapInteractionHarness.tsx"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 15000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  clearTimeout(timeout);
  if (exitCode !== 0) throw new Error(`Public map interaction check failed:\n${stdout}\n${stderr}`);
  expect(stdout).toContain("Public search, expansion, save, existing identity, return navigation, and account isolation passed.");
  expect(stdout).toContain("Public nearby selection, keyboard camera controls, history, and reversible relationship filters passed.");
  expect(stdout).toContain("Public touch midpoint zoom, continued panning, tap suppression, and pointer cleanup passed.");
  expect(stdout).toContain("Public details collapse and keyboard/pointer resizing passed.");
  expect(stdout).toContain("Public atlas regions, group zoom-to-fit, stable topic selection, all-groups return, and navigation history passed.");
  expect(stdout).toContain("Public document layouts, focused connections, hop depth, pivots, resize, history, and persistence passed.");
  expect(stdout).toContain("Public continuous grouped zoom reveals every neighborhood, preserves selection and resize cameras, and restores its presentation.");
}, 20000);
