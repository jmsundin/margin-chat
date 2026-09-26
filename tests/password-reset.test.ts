import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { createAuthService } from "../server/auth/index.mjs";
import { hashPassword, verifyPassword } from "../server/auth/passwords.mjs";
import { getPasswordResetEmailConfiguration, sendPasswordResetEmail } from "../server/auth/passwordResetEmail.mjs";
import { createRuntimeConfig } from "../server/config/runtime.mjs";
import { createCaptureTestDatabase } from "./helpers/captureDatabase.mjs";
import {
  normalizePasswordResetConfirmPayload,
  normalizePasswordResetRequestPayload,
} from "../server/auth/validation.mjs";

const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;
const emailEnv = {
  APP_URL: "https://margin-chat.example.com",
  NODE_ENV: "production",
  PASSWORD_RESET_FROM_EMAIL: "Margin Chat <passwords@example.com>",
  RESEND_API_KEY: "test-key",
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
});

describe("password reset service", () => {
  test("creates a hashed, expiring, single-use token for a known account", async () => {
    let storedToken: {
      expiresAt: Date;
      tokenHash: string;
      userId: string;
    } | null = null;
    const service = createAuthService({
      database: {
        createPasswordResetToken: async (input: typeof storedToken) => {
          storedToken = input;
        },
        findUserForLogin: async () => ({ id: "user-1" }),
      },
      env: {},
      runtimeConfig: {
        passwordResetTtlMs: 60 * 60 * 1000,
      },
    });

    const beforeRequest = Date.now();
    const result = await service.requestPasswordReset({ email: "USER@example.com" });

    expect(result.ok).toBe(true);
    expect(result.resetToken).toHaveLength(43);
    expect(storedToken?.userId).toBe("user-1");
    expect(storedToken?.tokenHash).toHaveLength(64);
    expect(storedToken?.tokenHash).not.toBe(result.resetToken);
    expect(storedToken?.expiresAt.getTime()).toBeGreaterThanOrEqual(
      beforeRequest + 60 * 60 * 1000,
    );
  });

  test("does not reveal whether an account exists", async () => {
    let tokenWasCreated = false;
    const service = createAuthService({
      database: {
        createPasswordResetToken: async () => {
          tokenWasCreated = true;
        },
        findUserForLogin: async () => null,
      },
      env: {},
      runtimeConfig: {
        passwordResetTtlMs: 60 * 60 * 1000,
      },
    });

    await expect(
      service.requestPasswordReset({ email: "missing@example.com" }),
    ).resolves.toEqual({ ok: true });
    expect(tokenWasCreated).toBe(false);
  });

  test("emails the reset link without exposing the production token", async () => {
    let emailRequest: { body: string; headers: Headers } | null = null;
    globalThis.fetch = (async (_input, init) => {
      emailRequest = {
        body: String(init?.body ?? ""),
        headers: new Headers(init?.headers),
      };
      return new Response(JSON.stringify({ id: "email-1" }), { status: 200 });
    }) as typeof fetch;
    const service = createAuthService({
      database: {
        createPasswordResetToken: async () => {},
        findUserForLogin: async () => ({
          email: "user@example.com",
          id: "user-1",
        }),
      },
      env: emailEnv,
      runtimeConfig: {
        passwordResetTtlMs: 15 * 60 * 1000,
      },
    });

    const result = await service.requestPasswordReset({ email: "user@example.com" });
    const emailBody = JSON.parse(emailRequest?.body ?? "{}");

    expect(result).toEqual({ ok: true });
    expect(emailBody.to).toEqual(["user@example.com"]);
    expect(emailBody.text).toContain("https://margin-chat.example.com/?reset_token=");
    expect(emailRequest?.headers.get("authorization")).toBe("Bearer test-key");
    expect(emailBody.text).toContain("expires in 15 minutes");
  });

  test.each([
    { NODE_ENV: "production" },
    { NODE_ENV: "staging" },
    { NODE_ENV: "development", VERCEL: "1" },
    { NODE_ENV: "development", VERCEL_ENV: "preview" },
    { VERCEL_URL: "margin-chat-preview.vercel.app" },
    { ...emailEnv, APP_URL: "not-a-url" },
  ])("rejects unavailable hosted reset email before looking up any account (%j)", async (env) => {
    let lookups = 0;
    const logs: unknown[] = [];
    console.error = (...args) => { logs.push(args); };
    const service = createAuthService({
      database: { findUserForLogin: async () => { lookups++; return { id: "user-1" }; } },
      env,
      runtimeConfig: { passwordResetTtlMs: 60 * 60 * 1000 },
    });

    for (const email of ["user@example.com", "missing@example.com"]) {
      await expect(service.requestPasswordReset({ email })).rejects.toMatchObject({
        statusCode: 503,
        message: "Password reset is temporarily unavailable. Please try again later.",
      });
    }
    expect(lookups).toBe(0);
    expect(logs).toHaveLength(2);
  });

  test("sends email in configured development without exposing the token", async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      return Response.json({ id: "email-1" });
    }) as typeof fetch;
    const service = createAuthService({
      database: {
        createPasswordResetToken: async () => {},
        findUserForLogin: async () => ({ email: "user@example.com", id: "user-1" }),
      },
      env: { ...emailEnv, NODE_ENV: "development" },
      runtimeConfig: { passwordResetTtlMs: 60 * 60 * 1000 },
    });

    expect(await service.requestPasswordReset({ email: "user@example.com" })).toEqual({ ok: true });
    expect(requests).toBe(1);
  });

  test.each(["rejection", "network"])("keeps account-specific %s failures private and logs a safe diagnostic", async (failure) => {
    const logs: string[] = [];
    console.error = (...args) => { logs.push(args.map(String).join(" ")); };
    globalThis.fetch = (async () => {
      if (failure === "network") throw new Error("private-token user@example.com");
      return Response.json({ name: "validation_error", message: "private-token user@example.com" }, { status: 403 });
    }) as typeof fetch;
    const service = createAuthService({
      database: {
        createPasswordResetToken: async () => {},
        findUserForLogin: async (email: string) => email === "user@example.com" ? { email, id: "user-1" } : null,
      },
      env: emailEnv,
      runtimeConfig: { passwordResetTtlMs: 60 * 60 * 1000 },
    });

    const known = await service.requestPasswordReset({ email: "user@example.com" });
    const missing = await service.requestPasswordReset({ email: "missing@example.com" });
    expect(known).toEqual(missing);
    expect(known).toEqual({ ok: true });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("Unable to send password reset email.");
    expect(logs[0]).not.toContain("private-token");
    expect(logs[0]).not.toContain("user@example.com");
  });

  test("hashes the new password before consuming the reset token", async () => {
    let resetInput: { passwordHash: string; tokenHash: string } | null = null;
    const service = createAuthService({
      database: {
        resetPasswordWithToken: async (input: typeof resetInput) => {
          resetInput = input;
        },
      },
      runtimeConfig: {},
    });
    const token = "a".repeat(43);

    await expect(
      service.resetPassword({ password: "new-password-123", token }),
    ).resolves.toEqual({ ok: true });

    expect(resetInput?.tokenHash).toHaveLength(64);
    expect(resetInput?.tokenHash).not.toBe(token);
    expect(resetInput?.passwordHash.startsWith("scrypt:")).toBe(true);
    await expect(
      verifyPassword("new-password-123", resetInput?.passwordHash ?? ""),
    ).resolves.toBe(true);
  });
});

describe("password reset email delivery", () => {
  const send = (input = {}) => sendPasswordResetEmail({
    email: "user@example.com", env: emailEnv, token: "private-token", tokenHash: "a".repeat(64), ...input,
  });

  test("reports missing configuration without making a request", async () => {
    let requested = false;
    globalThis.fetch = (async () => { requested = true; throw new Error("Unexpected request"); }) as typeof fetch;
    const result = await send({ env: {} });
    expect(result.delivered).toBe(false);
    expect(result.reason).toContain("RESEND_API_KEY");
    expect(result.reason).toContain("PASSWORD_RESET_FROM_EMAIL");
    expect(requested).toBe(false);
  });

  test("uses nonempty aliases and the Vercel production host", () => {
    const config = getPasswordResetEmailConfiguration({
      RESEND_API_KEY: "test-key", PASSWORD_RESET_FROM_EMAIL: " ", EMAIL_FROM: "passwords@example.com",
      APP_URL: "", VERCEL_PROJECT_PRODUCTION_URL: "margin.example.com", VERCEL_URL: "preview.example.com",
    });
    expect(config.configured).toBe(true);
    expect(config.appUrl).toBe("https://margin.example.com");
    expect(config.from).toBe("passwords@example.com");
  });

  test.each([
    "javascript:alert(1)", "http://example.com", "https://user:password@example.com",
    "https://example.com/?campaign=test", "https://example.com/#fragment", "https://example.com/app",
  ])("rejects an invalid production app origin %s", (APP_URL) => {
    expect(getPasswordResetEmailConfiguration({ ...emailEnv, APP_URL }).configured).toBe(false);
  });

  test("permits a local HTTP development origin and rejects malformed senders", () => {
    expect(getPasswordResetEmailConfiguration({ ...emailEnv, NODE_ENV: "development", APP_URL: "http://localhost:5173/" }).configured).toBe(true);
    expect(getPasswordResetEmailConfiguration({ ...emailEnv, PASSWORD_RESET_FROM_EMAIL: "not an email" }).configured).toBe(false);
  });

  test("uses idempotency, a request deadline, and the configured expiration", async () => {
    let request: RequestInit | undefined;
    globalThis.fetch = (async (_input, init) => {
      request = init;
      return Response.json({ id: "email-1" });
    }) as typeof fetch;
    expect(await send({ ttlMs: 60_000 })).toEqual({ delivered: true, messageId: "email-1" });
    const body = JSON.parse(String(request?.body));
    expect(body.text).toContain("expires in 1 minute");
    expect(new Headers(request?.headers).get("Idempotency-Key")).toBe(`password-reset-${"a".repeat(64)}`);
    expect(request?.signal).toBeInstanceOf(AbortSignal);
  });

  test("times out a stalled provider request", async () => {
    globalThis.fetch = ((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch;
    await expect(send({ timeoutMs: 10 })).rejects.toThrow("failed or timed out");
  });

  test("does not claim acceptance when the provider omits the email ID", async () => {
    globalThis.fetch = (async () => Response.json({})) as typeof fetch;
    await expect(send()).rejects.toThrow("did not confirm accepting the email");
  });
});

describe("password reset validation", () => {
  test("normalizes request emails", () => {
    expect(
      normalizePasswordResetRequestPayload({ email: "  USER@example.com " }),
    ).toEqual({ email: "user@example.com" });
  });

  test("rejects short passwords and malformed tokens", () => {
    expect(() =>
      normalizePasswordResetConfirmPayload({ password: "short", token: "bad" }),
    ).toThrow();
  });
});

describe("password reset persistence", () => {
  let fixture: Awaited<ReturnType<typeof createCaptureTestDatabase>>;
  let service: ReturnType<typeof createAuthService>;
  const originalPassword = "original-password-123";
  const newPassword = "replacement-password-456";

  beforeAll(async () => {
    fixture = await createCaptureTestDatabase();
    service = createAuthService({ database: fixture.database, env: {}, runtimeConfig: createRuntimeConfig({}) });
  }, 30_000);
  afterAll(async () => { await fixture?.pg.close(); });

  async function account() {
    const id = randomUUID();
    const user = await fixture.database.createUser({
      id, email: `${id}@example.test`, displayName: "Reset tester", role: "member",
      passwordHash: await hashPassword(originalPassword),
    });
    const sessionId = randomUUID();
    const tokenHash = randomUUID();
    const expiresAt = new Date(Date.now() + 60_000);
    await fixture.database.createAuthSession({ id: sessionId, userId: id, expiresAt });
    await fixture.database.createExtensionSession({ userId: id, expiresAt, tokenHash });
    await fixture.database.setCaptureToken({ userId: id, expiresAt, tokenHash });
    return { user, sessionId, tokenHash };
  }

  test("consumes a reset link once and revokes only that account's previous credentials", async () => {
    const current = await account();
    const other = await account();
    const { resetToken } = await service.requestPasswordReset({ email: current.user.email });

    expect(await service.resetPassword({ token: resetToken, password: newPassword })).toEqual({ ok: true });
    await expect(service.resetPassword({ token: resetToken, password: "another-new-password" }))
      .rejects.toMatchObject({ statusCode: 400, message: "Password reset link is invalid or expired." });
    await expect(service.authenticateCredentials({ email: current.user.email, password: originalPassword }))
      .rejects.toMatchObject({ statusCode: 401 });
    expect((await service.authenticateCredentials({ email: current.user.email, password: newPassword })).id).toBe(current.user.id);
    expect(await fixture.database.getUserByAuthSession(current.sessionId)).toBeNull();
    expect(await fixture.database.authenticateExtensionSession(current.tokenHash)).toBeNull();
    expect(await fixture.database.authenticateCaptureToken(current.tokenHash)).toBeNull();
    expect((await fixture.database.getUserByAuthSession(other.sessionId)).user.id).toBe(other.user.id);
    expect(await fixture.database.authenticateExtensionSession(other.tokenHash)).not.toBeNull();
    expect(await fixture.database.authenticateCaptureToken(other.tokenHash)).not.toBeNull();
  });

  test("expired reset links do not change the password or revoke sessions", async () => {
    const current = await account();
    const token = "a".repeat(43);
    await fixture.database.createPasswordResetToken({
      userId: current.user.id, tokenHash: createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(Date.now() - 60_000),
    });

    await expect(service.resetPassword({ token, password: newPassword }))
      .rejects.toMatchObject({ statusCode: 400, message: "Password reset link is invalid or expired." });
    expect((await service.authenticateCredentials({ email: current.user.email, password: originalPassword })).id).toBe(current.user.id);
    expect((await fixture.database.getUserByAuthSession(current.sessionId)).user.id).toBe(current.user.id);
    expect(await fixture.database.authenticateExtensionSession(current.tokenHash)).not.toBeNull();
    expect(await fixture.database.authenticateCaptureToken(current.tokenHash)).not.toBeNull();
  });

  test("requesting another reset replaces the earlier link", async () => {
    const current = await account();
    const first = await service.requestPasswordReset({ email: current.user.email });
    const second = await service.requestPasswordReset({ email: current.user.email });

    await expect(service.resetPassword({ token: first.resetToken, password: newPassword }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(await service.resetPassword({ token: second.resetToken, password: newPassword })).toEqual({ ok: true });
  });
});
