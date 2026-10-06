import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { createAuthService } from "../server/auth/index.mjs";
import { hashPassword, verifyPasswordAgainstDecoy } from "../server/auth/passwords.mjs";
import { createRuntimeConfig } from "../server/config/runtime.mjs";
import { parseCookieHeader } from "../server/http/cookies.mjs";
import { createRateLimiter, getClientAddress } from "../server/http/rateLimit.mjs";
import { EXTENSION_SESSION_API_PATH, EXTENSION_WORKSPACE_SESSION_API_PATH } from "@margin-chat/capture-contracts";
import { createApiHandler } from "../server/routes/api.mjs";
import { createCaptureTestDatabase } from "./helpers/captureDatabase.mjs";

describe("rate limiter", () => {
  test("blocks after the allowance, reports Retry-After, and recovers when the window ends", () => {
    let now = 1_000;
    const limiter = createRateLimiter({ max: 2, windowMs: 10_000, now: () => now });
    limiter.check("a");
    limiter.record("a");
    limiter.record("a");
    expect(() => limiter.check("a")).toThrow(expect.objectContaining({ statusCode: 429, headers: { "Retry-After": "10" } }));
    expect(() => limiter.check("b")).not.toThrow();
    now += 4_000;
    expect(() => limiter.check("a")).toThrow(expect.objectContaining({ headers: { "Retry-After": "6" } }));
    now += 6_000;
    expect(() => limiter.check("a")).not.toThrow();
  });

  test("reset clears a key and memory stays bounded", () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 60_000, maxKeys: 3 });
    limiter.record("a");
    limiter.reset("a");
    expect(() => limiter.check("a")).not.toThrow();
    for (const key of ["a", "b", "c", "d", "e"]) limiter.record(key);
    // The oldest windows were evicted to stay within maxKeys.
    expect(() => limiter.check("a")).not.toThrow();
    expect(() => limiter.check("e")).toThrow();
  });

  test("forwarding headers are only trusted behind a trusted proxy", () => {
    const request = { headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" }, socket: { remoteAddress: "10.0.0.1" } };
    expect(getClientAddress(request)).toBe("10.0.0.1");
    expect(getClientAddress(request, { trustProxyHeaders: true })).toBe("203.0.113.9");
    expect(getClientAddress({ headers: {} })).toBe("unknown");
  });
});

describe("cookie parsing", () => {
  test("a malformed percent-encoding does not throw", () => {
    expect(parseCookieHeader("margin_chat_session=%E0%A4%A; other=a%20b")).toEqual({
      margin_chat_session: "%E0%A4%A",
      other: "a b",
    });
  });
});

describe("password decoy", () => {
  test("never accepts a password", async () => {
    expect(await verifyPasswordAgainstDecoy("anything")).toBe(false);
  });
});

describe("authentication endpoints", () => {
  let fixture: Awaited<ReturnType<typeof createCaptureTestDatabase>>;
  let handler: ReturnType<typeof createApiHandler>;
  const password = "hardening-password-123";

  beforeAll(async () => {
    fixture = await createCaptureTestDatabase();
    const runtimeConfig = createRuntimeConfig({});
    const authService = createAuthService({ database: fixture.database, runtimeConfig, env: {} });
    handler = createApiHandler({
      database: fixture.database,
      authService,
      runtimeConfig,
      rateLimits: {
        loginFailuresByAddress: { max: 4, windowMs: 60_000 },
        loginFailuresByEmail: { max: 2, windowMs: 60_000 },
        signupsByAddress: { max: 2, windowMs: 60_000 },
        passwordResetsByAddress: { max: 1, windowMs: 60_000 },
      },
    });
  }, 30_000);
  afterAll(async () => { await fixture?.pg.close(); });

  async function request(path: string, options: { method?: string; body?: unknown; raw?: Buffer; headers?: Record<string, string>; address?: string } = {}) {
    const chunks = options.raw ? [options.raw] : options.body === undefined ? [] : [Buffer.from(JSON.stringify(options.body))];
    const req = Object.assign(Readable.from(chunks), {
      method: options.method ?? (options.body === undefined && !options.raw ? "GET" : "POST"),
      url: path,
      socket: { remoteAddress: options.address ?? "198.51.100.1" },
      headers: { host: "localhost", "content-type": "application/json", ...options.headers },
    });
    const result = { status: 0, headers: {} as Record<string, string>, body: null as any };
    await handler(req, {
      setHeader() {},
      writeHead(status: number, headers: Record<string, string>) { result.status = status; result.headers = headers; },
      end(body: string) { result.body = body ? JSON.parse(body) : null; },
    });
    return result;
  }

  async function account() {
    const id = crypto.randomUUID();
    return fixture.database.createUser({
      id, displayName: "Hardening tester", email: `${id}@example.test`,
      passwordHash: await hashPassword(password), role: "member",
    });
  }

  test("repeated failed logins for one email are throttled, then a different account is unaffected", async () => {
    const victim = await account();
    const other = await account();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect((await request("/api/auth/login", { body: { email: victim.email, password: "wrong-password" }, address: "198.51.100.10" })).status).toBe(401);
    }
    const blocked = await request("/api/auth/login", { body: { email: victim.email, password }, address: "198.51.100.11" });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers["Retry-After"])).toBeGreaterThan(0);
    expect((await request("/api/auth/login", { body: { email: other.email, password }, address: "198.51.100.12" })).status).toBe(200);
  });

  test("a successful login clears the failure count for that email", async () => {
    const user = await account();
    expect((await request("/api/auth/login", { body: { email: user.email, password: "wrong" }, address: "198.51.100.20" })).status).toBe(401);
    expect((await request("/api/auth/login", { body: { email: user.email, password }, address: "198.51.100.20" })).status).toBe(200);
    expect((await request("/api/auth/login", { body: { email: user.email, password: "wrong" }, address: "198.51.100.20" })).status).toBe(401);
    expect((await request("/api/auth/login", { body: { email: user.email, password }, address: "198.51.100.20" })).status).toBe(200);
  });

  test("failed credentials against the extension session route share the login budget", async () => {
    const user = await account();
    for (const path of [EXTENSION_SESSION_API_PATH, EXTENSION_WORKSPACE_SESSION_API_PATH]) {
      expect((await request(path, { body: { email: user.email, password: "wrong" }, address: "198.51.100.30" })).status).toBe(401);
    }
    expect((await request("/api/auth/login", { body: { email: user.email, password }, address: "198.51.100.31" })).status).toBe(429);
  });

  test("signup and password reset requests are limited per address", async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const id = crypto.randomUUID();
      expect((await request("/api/auth/signup", { body: { displayName: "Signup tester", email: `${id}@example.test`, password }, address: "198.51.100.40" })).status).toBe(201);
    }
    const third = await request("/api/auth/signup", { body: { displayName: "Signup tester", email: "third@example.test", password }, address: "198.51.100.40" });
    expect(third.status).toBe(429);
    expect((await request("/api/auth/signup", { body: { displayName: "Signup tester", email: "elsewhere@example.test", password }, address: "198.51.100.41" })).status).toBe(201);

    await request("/api/auth/password-reset/request", { body: { email: "nobody@example.test" }, address: "198.51.100.50" });
    expect((await request("/api/auth/password-reset/request", { body: { email: "nobody@example.test" }, address: "198.51.100.50" })).status).toBe(429);
  });

  test("oversized authentication bodies are rejected before parsing", async () => {
    const raw = Buffer.from(JSON.stringify({ email: "a@example.test", password: "x".repeat(40_000) }));
    expect((await request("/api/auth/login", { raw, address: "198.51.100.60" })).status).toBe(413);
    expect((await request("/api/auth/signup", { raw, address: "198.51.100.61" })).status).toBe(413);
  });

  test("cross-site fetches cannot drive cookie-authenticated or credential routes", async () => {
    const user = await account();
    const crossSite = { "sec-fetch-site": "cross-site" };
    for (const [path, method, body] of [
      ["/api/auth/login", "POST", { email: user.email, password }],
      ["/api/auth/profile", "PUT", { displayName: "Changed", email: user.email }],
      ["/api/settings/api-keys", "PUT", {}],
      ["/api/billing/checkout", "POST", {}],
      ["/api/documents/abc", "DELETE", undefined],
      ["/api/chat", "POST", {}],
    ] as const) {
      const result = await request(path, { method, body, headers: crossSite, address: "198.51.100.70" });
      expect([path, result.status]).toEqual([path, 403]);
    }
    const sameOrigin = await request("/api/auth/login", { body: { email: user.email, password }, headers: { "sec-fetch-site": "same-origin" }, address: "198.51.100.70" });
    expect(sameOrigin.status).toBe(200);
    // Reads stay available cross-site; they are protected by CORS and cookies' SameSite.
    expect((await request("/api/auth/session", { headers: crossSite, address: "198.51.100.70" })).status).toBe(200);
  });

  test("a malformed session cookie behaves like no session instead of failing every request", async () => {
    const cookie = { cookie: "margin_chat_session=%E0%A4%A" };
    const session = await request("/api/auth/session", { headers: cookie, address: "198.51.100.80" });
    expect(session.status).toBe(200);
    expect(session.body.user).toBeNull();
    const user = await account();
    expect((await request("/api/auth/login", { body: { email: user.email, password }, headers: cookie, address: "198.51.100.80" })).status).toBe(200);
  });

  test("a malformed document id is a client error", async () => {
    const user = await account();
    const login = await request("/api/auth/login", { body: { email: user.email, password }, address: "198.51.100.90" });
    const cookie = login.headers["Set-Cookie"].split(";")[0];
    for (const [method, path] of [["DELETE", "/api/documents/%E0%A4%A"], ["GET", "/api/documents/%E0%A4%A/original"]] as const) {
      const result = await request(path, { method, headers: { cookie }, address: "198.51.100.90" });
      expect([path, result.status]).toEqual([path, 400]);
    }
  });
});
