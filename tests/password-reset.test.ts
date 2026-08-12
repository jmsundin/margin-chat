import { afterEach, describe, expect, test } from "bun:test";
import { createAuthService } from "../server/auth/index.mjs";
import { verifyPassword } from "../server/auth/passwords.mjs";
import {
  normalizePasswordResetConfirmPayload,
  normalizePasswordResetRequestPayload,
} from "../server/auth/validation.mjs";

const originalNodeEnv = process.env.NODE_ENV;
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }
});

describe("password reset service", () => {
  test("creates a hashed, expiring, single-use token for a known account", async () => {
    delete process.env.NODE_ENV;
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
      env: {
        APP_URL: "https://margin-chat.example.com",
        NODE_ENV: "production",
        PASSWORD_RESET_FROM_EMAIL: "Margin Chat <passwords@example.com>",
        RESEND_API_KEY: "test-key",
      },
      runtimeConfig: {
        passwordResetTtlMs: 60 * 60 * 1000,
      },
    });

    const result = await service.requestPasswordReset({ email: "user@example.com" });
    const emailBody = JSON.parse(emailRequest?.body ?? "{}");

    expect(result).toEqual({ ok: true });
    expect(emailBody.to).toEqual(["user@example.com"]);
    expect(emailBody.text).toContain("https://margin-chat.example.com/?reset_token=");
    expect(emailRequest?.headers.get("authorization")).toBe("Bearer test-key");
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
