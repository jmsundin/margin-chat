import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { createAuthService } from "../server/auth/index.mjs";
import { hashPassword } from "../server/auth/passwords.mjs";
import { createRuntimeConfig } from "../server/config/runtime.mjs";
import { createApiHandler } from "../server/routes/api.mjs";
import { createCaptureTestDatabase } from "./helpers/captureDatabase.mjs";

describe("public signup privileges", () => {
  let fixture: Awaited<ReturnType<typeof createCaptureTestDatabase>>;
  let auth: ReturnType<typeof createAuthService>;
  let handler: ReturnType<typeof createApiHandler>;
  const password = "signup-regression-password";

  beforeAll(async () => {
    fixture = await createCaptureTestDatabase();
    const runtimeConfig = createRuntimeConfig({});
    auth = createAuthService({ database: fixture.database, runtimeConfig, env: {} });
    handler = createApiHandler({ database: fixture.database, authService: auth, runtimeConfig });
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

  test("claiming the former administrator email cannot grant admin or cloud privileges", async () => {
    const result = await request("/api/auth/signup", {
      displayName: "Unverified signup",
      email: "  SUNDINJON@gmail.com  ",
      password,
      role: "admin",
    });
    expect(result.status).toBe(201);
    expect(result.body.user.email).toBe("sundinjon@gmail.com");
    expect(result.body.user.role).toBe("member");
    expect(result.body.user.billing.accessKind).toBe("none");
    expect(result.body.user.billing.hasAccess).toBe(false);
    const stored = await fixture.client.query("select role from marginchat_users where id = $1", [result.body.user.id]);
    expect(stored.rows[0].role).toBe("member");

    const cookie = result.headers["Set-Cookie"].split(";")[0];
    const session = await request("/api/auth/session", undefined, cookie);
    expect(session.body.user.role).toBe("member");
    expect((await request("/api/vault", undefined, cookie)).status).toBe(403);
  });

  test("a role supplied with an ordinary signup is ignored", async () => {
    const result = await request("/api/auth/signup", {
      displayName: "Ordinary signup", email: "reader@example.test", password, role: "admin",
    });
    expect(result.status).toBe(201);
    expect(result.body.user.role).toBe("member");
    expect(result.body.user.billing.hasAccess).toBe(false);
  });

  test("an explicitly provisioned administrator retains their stored role on login and session reads", async () => {
    const user = await fixture.database.createUser({
      id: crypto.randomUUID(), displayName: "Provisioned admin", email: "verified-admin@example.test",
      passwordHash: await hashPassword(password), role: "admin",
    });
    const login = await request("/api/auth/login", { email: user.email, password });
    expect(login.status).toBe(200);
    expect(login.body.user.id).toBe(user.id);
    expect(login.body.user.role).toBe("admin");
    expect(login.body.user.billing.accessKind).toBe("admin");
    const session = await request("/api/auth/session", undefined, login.headers["Set-Cookie"].split(";")[0]);
    expect(session.body.user.role).toBe("admin");
    expect(session.body.user.billing.hasAccess).toBe(true);
  });
});
