import { afterEach, describe, expect, test } from "bun:test";
import { requestChangePassword } from "../client/src/lib/api";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("password change API", () => {
  test("posts the current and new passwords with the signed-in session", async () => {
    let request: [unknown, RequestInit | undefined] | undefined;
    globalThis.fetch = (async (url, init) => {
      request = [url, init];
      return Response.json({ ok: true });
    }) as typeof fetch;

    const passwords = { currentPassword: " current password ", password: " new password " };
    await requestChangePassword(passwords);
    expect(request?.[0]).toBe("/api/auth/password/change");
    expect(request?.[1]).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(new Headers(request?.[1]?.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(request?.[1]?.body))).toEqual(passwords);
  });

  test("requires an explicit success response and surfaces server failures", async () => {
    for (const payload of [null, {}, { ok: false }, { ok: "true" }]) {
      globalThis.fetch = (async () => Response.json(payload)) as typeof fetch;
      await expect(requestChangePassword({ currentPassword: "old-password", password: "new-password" }))
        .rejects.toThrow("invalid password change response");
    }
    globalThis.fetch = (async () => Response.json({ error: "Current password is incorrect." }, { status: 400 })) as typeof fetch;
    await expect(requestChangePassword({ currentPassword: "wrong-password", password: "new-password" }))
      .rejects.toThrow("Current password is incorrect.");
    globalThis.fetch = (async () => Response.json({ error: "Not found." }, { status: 404 })) as typeof fetch;
    await expect(requestChangePassword({ currentPassword: "old-password", password: "new-password" }))
      .rejects.toMatchObject({ statusCode: 404, message: "Password changes are not available on this version of the app. Please try again after it is updated." });
  });
});

test.each(["profile", "reset-request", "reset-confirm", "change-session"])("mounted password settings: %s", async (scenario) => {
  const child = Bun.spawn([process.execPath, "tests/helpers/passwordSettingsHarness.ts", scenario], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 10_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  clearTimeout(timeout);
  if (exitCode !== 0) throw new Error(`Password ${scenario} regression failed:\n${stdout}\n${stderr}`);
  expect(JSON.parse(stdout.trim().split("\n").at(-1)!).result).toBe("pass");
}, 15000);
