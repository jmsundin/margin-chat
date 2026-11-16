import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { createAuthService } from "../server/auth/index.mjs";
import { createRuntimeConfig } from "../server/config/runtime.mjs";
import { createApiHandler } from "../server/routes/api.mjs";
import { createCaptureTestDatabase } from "./helpers/captureDatabase.mjs";

const password = "verification-password-123";
const emailEnv = { RESEND_API_KEY: "re_test", PASSWORD_RESET_FROM_EMAIL: "Margin Chat <hello@example.test>", APP_URL: "http://localhost:5173" };

describe("confirming the email address", () => {
  let fixture: Awaited<ReturnType<typeof createCaptureTestDatabase>>;
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  const realFetch = globalThis.fetch;
  let failSending = false;

  function handlerWith(env: Record<string, string>) {
    const runtimeConfig = createRuntimeConfig({});
    return createApiHandler({ database: fixture.database, authService: createAuthService({ database: fixture.database, runtimeConfig, env }), runtimeConfig });
  }
  let handler: ReturnType<typeof createApiHandler>;

  beforeAll(async () => {
    fixture = await createCaptureTestDatabase();
    handler = handlerWith(emailEnv);
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      if (!String(url).startsWith("https://api.resend.com/")) return realFetch(url, init);
      if (failSending) return new Response(JSON.stringify({ name: "validation_error" }), { status: 422 });
      const body = JSON.parse(String(init.body));
      sent.push({ to: body.to[0], subject: body.subject, text: body.text });
      return new Response(JSON.stringify({ id: crypto.randomUUID() }), { status: 200 });
    }) as typeof fetch;
  }, 30_000);
  afterEach(() => { sent.length = 0; failSending = false; });
  afterAll(async () => { globalThis.fetch = realFetch; await fixture?.pg.close(); });

  async function request(path: string, options: { method?: string; body?: unknown; cookie?: string; use?: ReturnType<typeof createApiHandler> } = {}) {
    const req = Object.assign(Readable.from(options.body === undefined ? [] : [Buffer.from(JSON.stringify(options.body))]), {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"), url: path, socket: { remoteAddress: `203.0.113.${Math.floor(Math.random() * 200)}` },
      headers: { host: "localhost", "content-type": "application/json", ...(options.cookie ? { cookie: options.cookie } : {}) },
    });
    const result = { status: 0, headers: {} as Record<string, string>, body: null as any };
    await (options.use ?? handler)(req, {
      setHeader() {},
      writeHead(status: number, headers: Record<string, string>) { result.status = status; result.headers = headers; },
      end(body: string) { result.body = body ? JSON.parse(body) : null; },
    } as any);
    return result;
  }

  const tokenFrom = (text: string) => new URL(text.match(/https?:\/\/\S+/u)![0]).searchParams.get("verify_email")!;
  async function signup(use?: ReturnType<typeof createApiHandler>) {
    const email = `${crypto.randomUUID()}@example.test`;
    const result = await request("/api/auth/signup", { body: { displayName: "New person", email, password }, use });
    return { email, result, cookie: result.headers["Set-Cookie"]?.split(";")[0] };
  }

  test("sign-up lets people in at once and emails a link that confirms the address once", async () => {
    const { email, result, cookie } = await signup();
    expect(result.status).toBe(201);
    expect(result.body.user.emailVerified).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: email, subject: "Confirm your email for Margin Chat" });

    const token = tokenFrom(sent[0].text);
    // The link works without being signed in, as when it opens in another browser.
    expect((await request("/api/auth/email/verify", { body: { token } })).status).toBe(200);
    expect((await request("/api/auth/session", { cookie })).body.user.emailVerified).toBe(true);
    expect((await request("/api/auth/email/verify", { body: { token } })).status).toBe(400);
    expect((await request("/api/auth/email/verify", { body: { token: "not a token" } })).status).toBe(400);
  });

  test("Send again gives a fresh link and the old one stops working", async () => {
    const { cookie } = await signup();
    const first = tokenFrom(sent[0].text);
    const again = await request("/api/auth/email/verification", { body: {}, cookie });
    expect(again.status).toBe(200);
    expect(sent).toHaveLength(2);
    expect((await request("/api/auth/email/verify", { body: { token: first } })).status).toBe(400);
    expect((await request("/api/auth/email/verify", { body: { token: tokenFrom(sent[1].text) } })).status).toBe(200);
    expect((await request("/api/auth/email/verification", { body: {}, cookie })).body).toEqual({ ok: true, alreadyVerified: true });
    expect((await request("/api/auth/email/verification", { body: {} })).status).toBe(401);
  });

  test("changing the email clears confirmation, and a link for the old address confirms nothing", async () => {
    const { cookie } = await signup();
    const oldLink = tokenFrom(sent[0].text);
    sent.length = 0;
    const moved = `${crypto.randomUUID()}@example.test`;
    const changed = await request("/api/auth/profile", { method: "PUT", body: { displayName: "New person", email: moved, currentPassword: password }, cookie });
    expect(changed.status).toBe(200);
    expect(changed.body.user.emailVerified).toBe(false);
    // The notice to the old address and a confirmation link to the new one.
    expect(sent.map((mail) => mail.to)).toContain(moved);
    expect((await request("/api/auth/email/verify", { body: { token: oldLink } })).status).toBe(400);
    const newLink = tokenFrom(sent.find((mail) => mail.to === moved)!.text);
    expect((await request("/api/auth/email/verify", { body: { token: newLink } })).status).toBe(200);
    expect((await request("/api/auth/session", { cookie })).body.user.emailVerified).toBe(true);
    // Changing only the name keeps it confirmed.
    const renamed = await request("/api/auth/profile", { method: "PUT", body: { displayName: "Renamed", email: moved }, cookie });
    expect(renamed.body.user.emailVerified).toBe(true);
  });

  test("sign-up still works when email can't be sent, or isn't set up at all", async () => {
    failSending = true;
    expect((await signup()).result.status).toBe(201);
    failSending = false;
    const unconfigured = handlerWith({});
    const { result, cookie } = await signup(unconfigured);
    expect(result.status).toBe(201);
    expect(sent).toHaveLength(0);
    expect((await request("/api/auth/email/verification", { body: {}, cookie, use: unconfigured })).status).toBe(503);
  });
});
