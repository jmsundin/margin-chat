import { expect, test } from "bun:test";

test("mounted workspace links selected passages to existing documents and blocks without changing ancestry", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/documentLinkWorkspaceHarness.tsx"], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 20000);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timeout);
  if (code !== 0) throw new Error(`Document link workspace integration failed:\n${stdout}\n${stderr}`);
  expect(JSON.parse(stdout.trim().split("\n").at(-1)!).checks).toHaveLength(5);
}, 25000);

test("mobile selection keeps native handles, replaces the system menu, generates quick actions immediately, and waits for custom prompts", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/documentLinkWorkspaceHarness.tsx"], {
    cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, TEST_MOBILE_SELECTION: "1" }, stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 20000);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timeout);
  if (code !== 0) throw new Error(`Mobile selection regression:\n${stdout}\n${stderr}`);
  expect(JSON.parse(stdout.trim().split("\n").at(-1)!).checks).toHaveLength(5);
}, 25000);
