import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { createAuthService } from "../server/auth/index.mjs";
import { hashPassword, verifyPassword } from "../server/auth/passwords.mjs";
import { normalizePasswordChangePayload } from "../server/auth/validation.mjs";
import { createRuntimeConfig } from "../server/config/runtime.mjs";
import { createApiHandler } from "../server/routes/api.mjs";
import { createCaptureTestDatabase } from "./helpers/captureDatabase.mjs";

const originalPassword = "original-password-123";
const newPassword = "replacement-password-456";
const changePath = "/api/auth/password/change";

describe("password change validation", () => {
  test("requires current and new passwords and preserves password whitespace", () => {
    for (const input of [null, [], {}, { currentPassword: "", password: newPassword },
      { currentPassword: originalPassword, password: "short" },
      { currentPassword: originalPassword, password: "a".repeat(201) },
      { currentPassword: "a".repeat(201), password: newPassword }]) {
      expect(() => normalizePasswordChangePayload(input)).toThrow();
    }
    expect(normalizePasswordChangePayload({ currentPassword: " current ", password: " new password " }))
      .toEqual({ currentPassword: " current ", password: " new password " });
  });
});

describe("authenticated password changes", () => {
  let fixture: Awaited<ReturnType<typeof createCaptureTestDatabase>>;
  let handler: ReturnType<typeof createApiHandler>;

  beforeAll(async () => {
    fixture = await createCaptureTestDatabase();
    const runtimeConfig = createRuntimeConfig({});
    const authService = createAuthService({ database: fixture.database, runtimeConfig, env: {} });
    handler = createApiHandler({ database: fixture.database, authService, runtimeConfig });
  }, 30_000);
  afterAll(async () => { await fixture?.pg.close(); });

  async function request(path: string, body?: unknown, cookie?: string) {
    const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
      method: body === undefined ? "GET" : "POST",
      url: path,
      headers: { host: "localhost", "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    });
    const result = { status: 0, headers: {} as Record<string, string>, body: null as any };
    await handler(req, {
      writeHead(status: number, headers: Record<string, string>) { result.status = status; result.headers = headers; },
      end(body: string) { result.body = JSON.parse(body); },
    });
    return result;
  }

  async function account() {
    const id = crypto.randomUUID();
    const user = await fixture.database.createUser({
      id, displayName: "Password tester", email: `${id}@example.test`,
      passwordHash: await hashPassword(originalPassword), role: "member",
    });
    const login = await request("/api/auth/login", { email: user.email, password: originalPassword });
    const cookie = login.headers["Set-Cookie"].split(";")[0];
    return { user, cookie, sessionId: cookie.split("=")[1] };
  }

  async function createOtherCredentials(userId: string) {
    const expiresAt = new Date(Date.now() + 60_000);
    const tokenHash = crypto.randomUUID();
    await fixture.database.createPasswordResetToken({ userId, expiresAt, tokenHash });
    await fixture.database.createExtensionSession({ userId, expiresAt, tokenHash });
    await fixture.database.setCaptureToken({ userId, expiresAt, tokenHash });
    return tokenHash;
  }

  async function credentialCounts(userId: string) {
    const result = await fixture.client.query(`
      select
        (select count(*)::int from marginchat_user_sessions where user_id = $1) as sessions,
        (select count(*)::int from marginchat_extension_sessions where user_id = $1) as extensions,
        (select count(*)::int from marginchat_capture_tokens where user_id = $1) as captures,
        (select count(*)::int from marginchat_password_reset_tokens where user_id = $1) as resets
    `, [userId]);
    return result.rows[0];
  }

  test("requires a signed-in browser session", async () => {
    const result = await request(changePath, { currentPassword: originalPassword, password: newPassword });
    expect(result.status).toBe(401);
    expect(result.body.error).toBe("Sign in to continue.");
  });

  test("rejects an incorrect current password without changing credentials", async () => {
    const { user, cookie } = await account();
    const before = await fixture.database.getUserPasswordHash(user.id);
    await createOtherCredentials(user.id);
    const result = await request(changePath, { currentPassword: "wrong-password", password: newPassword }, cookie);
    expect(result.status).toBe(400);
    expect(result.body.error).toBe("Current password is incorrect.");
    expect(result.headers["Set-Cookie"]).toBeUndefined();
    expect(await fixture.database.getUserPasswordHash(user.id)).toBe(before);
    expect(await credentialCounts(user.id)).toEqual({ sessions: 1, extensions: 1, captures: 1, resets: 1 });
    expect((await request("/api/auth/session", undefined, cookie)).body.user.id).toBe(user.id);
  });

  test("enforces the same new-password policy through the API", async () => {
    const { user, cookie } = await account();
    const before = await fixture.database.getUserPasswordHash(user.id);
    for (const password of ["short", "a".repeat(201)]) {
      const result = await request(changePath, { currentPassword: originalPassword, password }, cookie);
      expect(result.status).toBe(400);
      expect(result.body.error).toBe("Password must be between 8 and 200 characters.");
    }
    expect(await fixture.database.getUserPasswordHash(user.id)).toBe(before);
  });

  test("requires a password different from the current one", async () => {
    const { user, cookie } = await account();
    const before = await fixture.database.getUserPasswordHash(user.id);
    const result = await request(changePath, { currentPassword: originalPassword, password: originalPassword }, cookie);
    expect(result.status).toBe(400);
    expect(result.body.error).toBe("Choose a different password from your current password.");
    expect(await fixture.database.getUserPasswordHash(user.id)).toBe(before);
  });

  test("changes the password, rotates the current session, and revokes only this account's prior credentials", async () => {
    const { user, cookie } = await account();
    const other = await account();
    const secondLogin = await request("/api/auth/login", { email: user.email, password: originalPassword });
    const secondCookie = secondLogin.headers["Set-Cookie"].split(";")[0];
    const tokenHash = await createOtherCredentials(user.id);
    await createOtherCredentials(other.user.id);

    const result = await request(changePath, {
      currentPassword: originalPassword, password: newPassword, userId: other.user.id,
    }, cookie);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true });
    expect(result.headers["Cache-Control"]).toBe("no-store");
    expect(result.headers["Set-Cookie"]).toContain("HttpOnly");
    const replacementCookie = result.headers["Set-Cookie"].split(";")[0];
    expect(replacementCookie).not.toBe(cookie);
    expect(await credentialCounts(user.id)).toEqual({ sessions: 1, extensions: 0, captures: 0, resets: 0 });
    expect(await credentialCounts(other.user.id)).toEqual({ sessions: 1, extensions: 1, captures: 1, resets: 1 });
    expect((await request("/api/auth/session", undefined, replacementCookie)).body.user.id).toBe(user.id);
    expect((await request("/api/auth/session", undefined, cookie)).body.user).toBeNull();
    expect((await request("/api/auth/session", undefined, secondCookie)).body.user).toBeNull();
    expect((await request("/api/auth/session", undefined, other.cookie)).body.user.id).toBe(other.user.id);
    expect(await fixture.database.authenticateExtensionSession(tokenHash)).toBeNull();
    expect(await fixture.database.authenticateCaptureToken(tokenHash)).toBeNull();
    await expect(fixture.database.resetPasswordWithToken({ tokenHash, passwordHash: "replayed-reset" }))
      .rejects.toThrow("Password reset link is invalid or expired.");
    const storedHash = await fixture.database.getUserPasswordHash(user.id);
    expect(storedHash).not.toBe(newPassword);
    expect(await verifyPassword(newPassword, storedHash)).toBe(true);
    expect((await request("/api/auth/login", { email: user.email, password: originalPassword })).status).toBe(401);
    expect((await request("/api/auth/login", { email: user.email, password: newPassword })).status).toBe(200);
  });

  test("a concurrent password update cannot be overwritten using the previously verified hash", async () => {
    const { user, sessionId } = await account();
    const staleHash = await fixture.database.getUserPasswordHash(user.id);
    const updatedHash = await hashPassword("concurrently-updated-password");
    await fixture.client.query("update marginchat_users set password_hash = $1 where id = $2", [updatedHash, user.id]);
    await expect(fixture.database.changeUserPassword({
      currentPasswordHash: staleHash, currentSessionId: sessionId, expiresAt: new Date(Date.now() + 60_000),
      passwordHash: await hashPassword(newPassword), replacementSessionId: crypto.randomUUID(), userId: user.id,
    })).rejects.toMatchObject({ statusCode: 401 });
    expect(await fixture.database.getUserPasswordHash(user.id)).toBe(updatedHash);
    expect((await fixture.database.getUserByAuthSession(sessionId)).user.id).toBe(user.id);
  });

  test("a session revoked after authentication cannot change the password", async () => {
    const { user, sessionId } = await account();
    const currentPasswordHash = await fixture.database.getUserPasswordHash(user.id);
    await fixture.database.deleteAuthSession(sessionId);
    await expect(fixture.database.changeUserPassword({
      currentPasswordHash, currentSessionId: sessionId, expiresAt: new Date(Date.now() + 60_000),
      passwordHash: await hashPassword(newPassword), replacementSessionId: crypto.randomUUID(), userId: user.id,
    })).rejects.toMatchObject({ statusCode: 401 });
    expect(await fixture.database.getUserPasswordHash(user.id)).toBe(currentPasswordHash);
    expect((await credentialCounts(user.id)).sessions).toBe(0);
  });

  test("rolls back the password and every revocation if replacement-session creation fails", async () => {
    const { user, sessionId } = await account();
    const other = await account();
    const currentPasswordHash = await fixture.database.getUserPasswordHash(user.id);
    await createOtherCredentials(user.id);

    await expect(fixture.database.changeUserPassword({
      currentPasswordHash, currentSessionId: sessionId, expiresAt: new Date(Date.now() + 60_000),
      passwordHash: await hashPassword(newPassword), replacementSessionId: other.sessionId, userId: user.id,
    })).rejects.toMatchObject({ code: "23505" });

    expect(await fixture.database.getUserPasswordHash(user.id)).toBe(currentPasswordHash);
    expect(await credentialCounts(user.id)).toEqual({ sessions: 1, extensions: 1, captures: 1, resets: 1 });
    expect((await fixture.database.getUserByAuthSession(sessionId)).user.id).toBe(user.id);
    expect((await fixture.database.getUserByAuthSession(other.sessionId)).user.id).toBe(other.user.id);
  });
});
