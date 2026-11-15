import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { createAuthService } from "../server/auth/index.mjs";
import { canonicalEmail, isDisposableEmail, verifyTurnstile } from "../server/auth/botProtection.mjs";
import { createRuntimeConfig } from "../server/config/runtime.mjs";
import { createApiHandler } from "../server/routes/api.mjs";
import { createCaptureTestDatabase } from "./helpers/captureDatabase.mjs";

const password = "bot-protection-password";

describe("email rules", () => {
  test("one inbox, however it is spelled", () => {
    expect(canonicalEmail("J.o.N+launch@GMail.com")).toBe("jon@gmail.com");
    expect(canonicalEmail("jon@googlemail.com")).toBe("jon@gmail.com");
    expect(canonicalEmail("first.last+news@example.com")).toBe("first.last@example.com");
  });

  test("throwaway inboxes, subdomains included, but not ordinary ones", () => {
    expect(isDisposableEmail("x@mailinator.com")).toBe(true);
    expect(isDisposableEmail("x@inbox.mailinator.com")).toBe(true);
    expect(isDisposableEmail("x@gmail.com")).toBe(false);
    expect(isDisposableEmail("x@notmailinator.com")).toBe(false);
  });
});

describe("Turnstile", () => {
  const env = { TURNSTILE_SECRET_KEY: "secret" };
  const answer = (body: unknown) => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;

  test("is skipped until a secret is set", async () => {
    expect(await verifyTurnstile({ token: undefined, env: {} })).toEqual({ checked: false });
  });

  test("needs a token that Cloudflare accepts", async () => {
    await expect(verifyTurnstile({ token: undefined, env, fetchImpl: answer({ success: true }) })).rejects.toMatchObject({ statusCode: 400 });
    await expect(verifyTurnstile({ token: "t", env, fetchImpl: answer({ success: false, "error-codes": ["invalid-input-response"] }) })).rejects.toMatchObject({ statusCode: 400 });
    expect(await verifyTurnstile({ token: "t", env, fetchImpl: answer({ success: true }) })).toEqual({ checked: true });
  });

  test("sends the secret, token and address, and lets people through when Cloudflare is down", async () => {
    let sent: URLSearchParams | null = null;
    const capture = (async (_url: string, init: RequestInit) => { sent = init.body as URLSearchParams; return new Response(JSON.stringify({ success: true })); }) as unknown as typeof fetch;
    await verifyTurnstile({ token: "tok", remoteIp: "203.0.113.9", env, fetchImpl: capture });
    expect(Object.fromEntries(sent!)).toEqual({ secret: "secret", response: "tok", remoteip: "203.0.113.9" });
    const down = (async () => { throw new Error("network"); }) as unknown as typeof fetch;
    expect(await verifyTurnstile({ token: "tok", env, fetchImpl: down })).toEqual({ checked: false, unreachable: true });
  });
});

describe("sign-up endpoint", () => {
  let fixture: Awaited<ReturnType<typeof createCaptureTestDatabase>>;
  let handler: ReturnType<typeof createApiHandler>;
  let address = 0;

  beforeAll(async () => {
    fixture = await createCaptureTestDatabase();
    const runtimeConfig = createRuntimeConfig({});
    handler = createApiHandler({ database: fixture.database, authService: createAuthService({ database: fixture.database, runtimeConfig, env: {} }), runtimeConfig });
  }, 30_000);
  afterAll(async () => { await fixture?.pg.close(); });

  async function signup(body: Record<string, unknown>) {
    address += 1;
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
      method: "POST", url: "/api/auth/signup", socket: { remoteAddress: `198.18.0.${address}` },
      headers: { host: "localhost", "content-type": "application/json" },
    });
    const result = { status: 0, body: null as any };
    await handler(req, { setHeader() {}, writeHead(status: number) { result.status = status; }, end(text: string) { result.body = text ? JSON.parse(text) : null; } } as any);
    return result;
  }

  test("a filled-in hidden field is refused and creates nothing", async () => {
    const email = `${crypto.randomUUID()}@example.test`;
    expect((await signup({ displayName: "Bot", email, password, website: "http://spam.example" })).status).toBe(400);
    expect((await fixture.pg.query("select 1 from marginchat_users where email = $1", [email])).rows).toHaveLength(0);
    expect((await signup({ displayName: "Person", email, password, website: "" })).status).toBe(201);
  });

  test("throwaway addresses are refused", async () => {
    const result = await signup({ displayName: "Bot", email: `${crypto.randomUUID()}@mailinator.com`, password });
    expect(result.status).toBe(400);
    expect(result.body.error).toContain("permanent email");
  });

  test("a Gmail alias of an existing account can't open a second one", async () => {
    const name = `p${crypto.randomUUID().slice(0, 8)}`;
    expect((await signup({ displayName: "Person", email: `${name}@gmail.com`, password })).status).toBe(201);
    for (const alias of [`${name.slice(0, 3)}.${name.slice(3)}@gmail.com`, `${name}+2@gmail.com`, `${name}@googlemail.com`]) {
      expect((await signup({ displayName: "Again", email: alias, password })).status).toBe(409);
    }
    expect((await signup({ displayName: "Other", email: `${name}x@gmail.com`, password })).status).toBe(201);
  });

  test("with a Turnstile secret, sign-up needs the check to pass", async () => {
    const runtimeConfig = createRuntimeConfig({});
    const auth = createAuthService({ database: fixture.database, runtimeConfig, env: { TURNSTILE_SECRET_KEY: "secret" } });
    const pass = (async () => new Response(JSON.stringify({ success: true }))) as unknown as typeof fetch;
    const fail = (async () => new Response(JSON.stringify({ success: false }))) as unknown as typeof fetch;
    const email = `${crypto.randomUUID()}@example.test`;
    await expect(auth.signup({ displayName: "Bot", email, password }, { fetchImpl: pass })).rejects.toMatchObject({ statusCode: 400 });
    await expect(auth.signup({ displayName: "Bot", email, password, turnstileToken: "bad" }, { fetchImpl: fail })).rejects.toMatchObject({ statusCode: 400 });
    const created = await auth.signup({ displayName: "Person", email, password, turnstileToken: "good" }, { fetchImpl: pass });
    expect(created.user.email).toBe(email);
  });
});
