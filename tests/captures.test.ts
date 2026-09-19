import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import {
  CAPTURE_API_PATH,
  CONNECTION_API_PATH,
  EXTENSION_SESSION_API_PATH,
  normalizeCapture,
  normalizeServerUrl,
  captureToMarkdown,
} from "@margin-chat/capture-contracts";
import { createCaptureTestDatabase } from "./helpers/captureDatabase.mjs";
import { loadMigrations, migrateDatabase } from "../server/db/migrations.mjs";
import { createCaptureService } from "../server/captures/index.mjs";
import { createApiHandler } from "../server/routes/api.mjs";
import { createAuthService } from "../server/auth/index.mjs";
import { hashPassword } from "../server/auth/passwords.mjs";
import { createRuntimeConfig } from "../server/config/runtime.mjs";
import { createEmptyState } from "../client/src/initialState";
import { openCaptureAsNote } from "../client/src/lib/captures";

const fixture = () => ({
  schemaVersion: 1 as const,
  clientCaptureId: crypto.randomUUID(),
  kind: "article" as const,
  title: "Useful reference",
  sourceUrl: "https://example.com/article",
  content: "## An idea\n\nKeep the original source.",
  comment: "Discuss this later.",
  capturedAt: "2026-09-12T12:30:00.000Z",
});

describe("capture contracts", () => {
  test("rejects invalid schemes, credentials, oversized captures, unsupported versions and empty articles", () => {
    for (const sourceUrl of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "https://user:secret@example.com/",
    ]) {
      expect(() => normalizeCapture({ ...fixture(), sourceUrl })).toThrow();
    }
    expect(() =>
      normalizeCapture({ ...fixture(), content: "a".repeat(200001) }),
    ).toThrow();
    expect(() =>
      normalizeCapture({ ...fixture(), schemaVersion: 2 }),
    ).toThrow();
    expect(() => normalizeCapture({ ...fixture(), content: " " })).toThrow();
    expect(
      normalizeCapture({ ...fixture(), kind: "bookmark", content: "" }).content,
    ).toBe("");
    expect(
      normalizeCapture({ ...fixture(), futureOptionalField: "ignored" })
        .schemaVersion,
    ).toBe(1);
  });
  test("accepts HTTPS and loopback development servers without allowing credentials or insecure remote servers", () => {
    expect(normalizeServerUrl(" https://margin.example/ ")).toBe(
      "https://margin.example",
    );
    expect(normalizeServerUrl("http://localhost:5173")).toBe(
      "http://localhost:5173",
    );
    for (const url of [
      "http://example.com",
      "https://user:pass@example.com",
      "https://example.com/path",
      "https://example.com?token=x",
    ]) {
      expect(() => normalizeServerUrl(url)).toThrow();
    }
  });
  test("keeps source metadata and personal comments, and never replaces an edited imported note", () => {
    const capture = {
      ...fixture(),
      id: crypto.randomUUID(),
      createdAt: "2026-09-12T12:30:01.000Z",
    };
    const markdown = captureToMarkdown(capture);
    expect(markdown).toContain("https://example.com/article");
    expect(markdown).toContain("Discuss this later");
    const original = createEmptyState();
    const imported = openCaptureAsNote(original, capture);
    const id = imported.activeConversationId;
    imported.conversations[id].notes![0].content = "My edited note";
    const reopened = openCaptureAsNote(imported, capture);
    expect(reopened.conversations[id].notes![0].content).toBe("My edited note");
    expect(Object.keys(reopened.conversations)).toHaveLength(2);
    expect(Object.keys(original.conversations)).toHaveLength(1);
  });
});

describe("cloud capture API and Postgres storage", () => {
  let fixtureDb: Awaited<ReturnType<typeof createCaptureTestDatabase>>;
  let service: ReturnType<typeof createCaptureService>;
  let server: ReturnType<typeof createServer>;
  let origin: string;
  let passwordHash: string;
  const password = "test-password-for-clipper";
  const cookie = "margin_chat_session=test-session";
  beforeAll(async () => {
    passwordHash = await hashPassword(password);
    fixtureDb = await createCaptureTestDatabase();
    const config = createRuntimeConfig({});
    service = createCaptureService({ database: fixtureDb.database });
    const handler = createApiHandler({
      captureService: service,
      database: fixtureDb.database,
      authService: createAuthService({
        database: fixtureDb.database,
        runtimeConfig: config,
      }),
      runtimeConfig: config,
    });
    server = createServer(handler);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }, 30000);
  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await fixtureDb?.pg.close();
  });
  beforeEach(async () => {
    await fixtureDb.pg.exec(
      "truncate marginchat_users, marginchat_user_sessions, marginchat_app_sessions cascade",
    );
    for (const [id, role] of [
      ["owner", "admin"],
      ["other", "member"],
    ]) {
      await fixtureDb.database.createUser({
        id,
        role,
        email: `${id}@example.test`,
        displayName: id,
        passwordHash,
      });
    }
    await fixtureDb.database.createAuthSession({
      id: "test-session",
      userId: "owner",
      expiresAt: new Date(Date.now() + 60000),
    });
  });
  const api = (path: string, options?: RequestInit) =>
    fetch(`${origin}${path}`, options);
  async function issue() {
    return service.issueToken("owner");
  }

  const login = (email = "owner@example.test", pass = password) => api(EXTENSION_SESSION_API_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: pass }),
  });
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  test("password sign-in creates an expiring, hashed, capture-only session without a web cookie", async () => {
    const response = await login(" OWNER@example.test ");
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    const session = await response.json();
    expect(session.user).toEqual({ id: "owner", displayName: "owner", email: "owner@example.test" });
    expect(session.token).toMatch(/^mc_extension_[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(session.expiresAt)).toBeGreaterThan(Date.now());
    expect(JSON.stringify(session)).not.toContain("password");
    const rows = await fixtureDb.pg.query("select * from marginchat_extension_sessions");
    expect(rows.rows[0].token_hash).toBe(createHash("sha256").update(session.token).digest("hex"));
    expect(JSON.stringify(rows.rows)).not.toContain(session.token);
    const connection = await (await api(CONNECTION_API_PATH, { headers: bearer(session.token) })).json();
    expect(connection).toMatchObject({ userId: "owner", displayName: "owner", expiresAt: session.expiresAt });
    const saved = await api(CAPTURE_API_PATH, {
      method: "POST", headers: bearer(session.token), body: JSON.stringify(fixture()),
    });
    expect(saved.status).toBe(201);
    const capture = (await saved.json()).capture;
    for (const path of [CAPTURE_API_PATH, `${CAPTURE_API_PATH}/${capture.id}`, "/api/state", "/api/settings/capture-token"]) {
      expect((await api(path, { headers: bearer(session.token) })).status).toBe(401);
    }
    expect((await api("/api/chat", { method: "POST", headers: bearer(session.token), body: "{}" })).status).toBe(401);
    expect((await (await api("/api/auth/session", { headers: bearer(session.token) })).json()).user).toBeNull();
    expect((await api("/api/state", { headers: { Cookie: `margin_chat_session=${session.token}` } })).status).toBe(401);
  });

  test("rejects incorrect credentials, missing fields, oversized bodies and accounts without cloud access", async () => {
    for (const [email, pass] of [["owner@example.test", "wrong"], ["missing@example.test", password]]) {
      const response = await login(email, pass);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "Email or password is incorrect." });
    }
    expect((await login("owner@example.test", "")).status).toBe(400);
    expect((await login("other@example.test")).status).toBe(403);
    expect((await api(EXTENSION_SESSION_API_PATH, { method: "POST", body: "x".repeat(17000) })).status).toBe(413);
    expect((await fixtureDb.pg.query("select * from marginchat_extension_sessions")).rows).toHaveLength(0);
  });

  test("browser sessions coexist and signing out revokes only that browser", async () => {
    const first = await (await login()).json();
    const second = await (await login()).json();
    expect(first.token).not.toBe(second.token);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await api(EXTENSION_SESSION_API_PATH, { method: "DELETE", headers: bearer(first.token) })).status).toBe(200);
    }
    expect((await api(CONNECTION_API_PATH, { headers: bearer(first.token) })).status).toBe(401);
    expect((await api(CONNECTION_API_PATH, { headers: bearer(second.token) })).status).toBe(200);
    // Website credentials cannot be confused with an extension session.
    expect((await api(EXTENSION_SESSION_API_PATH, { method: "DELETE", headers: { Cookie: cookie } })).status).toBe(401);
    await fixtureDb.pg.exec("update marginchat_extension_sessions set expires_at = now() - interval '1 second'");
    expect((await api(CONNECTION_API_PATH, { headers: bearer(second.token) })).status).toBe(401);
  });

  test("password resets revoke every browser session and legacy key, and allow the new password", async () => {
    const first = await (await login()).json();
    const second = await (await login()).json();
    const legacy = await issue();
    const resetToken = "r".repeat(43);
    await fixtureDb.database.createPasswordResetToken({
      userId: "owner", tokenHash: createHash("sha256").update(resetToken).digest("hex"),
      expiresAt: new Date(Date.now() + 60000),
    });
    const response = await api("/api/auth/password-reset/confirm", {
      method: "POST", body: JSON.stringify({ token: resetToken, password: "new-clipper-password" }),
    });
    expect(response.status).toBe(200);
    for (const { token } of [first, second, legacy]) {
      expect((await api(CONNECTION_API_PATH, { headers: bearer(token) })).status).toBe(401);
    }
    expect((await login()).status).toBe(401);
    expect((await login("owner@example.test", "new-clipper-password")).status).toBe(201);
    const webLogin = await api("/api/auth/login", {
      method: "POST", body: JSON.stringify({ email: "owner@example.test", password: "new-clipper-password" }),
    });
    expect(webLogin.status).toBe(200);
    expect(webLogin.headers.get("set-cookie")).toContain("margin_chat_session=");
  });

  test("existing sessions lose capture access after a downgrade and can still sign out", async () => {
    await fixtureDb.pg.exec("update marginchat_users set billing_status = 'active' where id = 'other'");
    const session = await (await login("other@example.test")).json();
    expect((await api(CONNECTION_API_PATH, { headers: bearer(session.token) })).status).toBe(200);
    await fixtureDb.pg.exec("update marginchat_users set billing_status = 'canceled' where id = 'other'");
    expect((await api(CAPTURE_API_PATH, { method: "POST", headers: bearer(session.token), body: JSON.stringify(fixture()) })).status).toBe(403);
    expect((await api(EXTENSION_SESSION_API_PATH, { method: "DELETE", headers: bearer(session.token) })).status).toBe(200);
  });

  test("the migration runner can run twice against the existing schema", async () => {
    const result = await migrateDatabase(fixtureDb.client, { migrations: await loadMigrations() });
    expect(result.executed).toEqual([]);
    expect(
      (await fixtureDb.pg.query("select count(*) from marginchat_users"))
        .rows[0],
    ).toMatchObject({ count: 2 });
  });
  test("requires sign-in for keys and Inbox, and a scoped key for uploads", async () => {
    for (const path of [CAPTURE_API_PATH, "/api/settings/capture-token"])
      expect((await api(path)).status).toBe(401);
    expect(
      (
        await api(CAPTURE_API_PATH, {
          method: "POST",
          headers: { Cookie: cookie },
          body: JSON.stringify(fixture()),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await api(CONNECTION_API_PATH, {
          headers: { Authorization: "Bearer bogus" },
        })
      ).status,
    ).toBe(401);
  });
  test("issues only hashed tokens, rejects cross-site key changes, and returns no-store responses", async () => {
    const path = "/api/settings/capture-token";
    expect(
      (await api(path, { method: "POST", headers: { Cookie: cookie } })).status,
    ).toBe(403);
    expect(
      (
        await api(path, {
          method: "POST",
          headers: {
            Cookie: cookie,
            "X-Margin-Capture-Settings": "1",
            "Sec-Fetch-Site": "cross-site",
          },
        })
      ).status,
    ).toBe(403);
    const response = await api(path, {
      method: "POST",
      headers: { Cookie: cookie, "X-Margin-Capture-Settings": "1" },
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const result = await response.json();
    expect(result.token).toMatch(/^mc_capture_/u);
    const row = (
      await fixtureDb.pg.query(
        "select token_hash from marginchat_capture_tokens",
      )
    ).rows[0];
    expect(row.token_hash).not.toBe(result.token);
    expect(row.token_hash).toHaveLength(64);
    expect(
      JSON.stringify(
        await (await api(path, { headers: { Cookie: cookie } })).json(),
      ),
    ).not.toContain(result.token);
  });
  test("a capture key can save but cannot read Inbox, workspace, chat, or account settings", async () => {
    const { token } = await issue();
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    const response = await api(CAPTURE_API_PATH, {
      method: "POST",
      headers,
      body: JSON.stringify(fixture()),
    });
    expect(response.status).toBe(201);
    const saved = await response.json();
    for (const path of [
      CAPTURE_API_PATH,
      `${CAPTURE_API_PATH}/${saved.capture.id}`,
      "/api/state",
      "/api/settings/api-keys",
      "/api/settings/capture-token",
    ]) {
      expect((await api(path, { headers })).status).toBe(401);
    }
    expect(
      (await api("/api/chat", { method: "POST", headers, body: "{}" })).status,
    ).toBe(401);
    const connection = await (
      await api(CONNECTION_API_PATH, { headers })
    ).json();
    expect(connection.displayName).toBe("owner");
    expect(connection.email).toBeUndefined();
  });
  test("retries create one capture and reject a reused ID with altered content", async () => {
    const { token } = await issue();
    const payload = fixture();
    const options = {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    };
    const responses = await Promise.all([
      api(CAPTURE_API_PATH, options),
      api(CAPTURE_API_PATH, options),
    ]);
    const bodies = await Promise.all(
      responses.map((response) => response.json()),
    );
    expect(bodies[0]).toEqual(bodies[1]);
    expect(
      (await fixtureDb.database.listCaptures({ userId: "owner" })).captures,
    ).toHaveLength(1);
    expect(
      (
        await api(CAPTURE_API_PATH, {
          ...options,
          body: JSON.stringify({ ...payload, content: "Changed" }),
        })
      ).status,
    ).toBe(409);
  });
  test("validates content, limits request bytes, and includes CORS support for Authorization", async () => {
    const { token } = await issue();
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    expect(
      (await api(CAPTURE_API_PATH, { method: "POST", headers, body: "{" }))
        .status,
    ).toBe(400);
    expect(
      (
        await api(CAPTURE_API_PATH, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...fixture(), content: "a".repeat(200001) }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api(CAPTURE_API_PATH, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...fixture(), extra: "a".repeat(1_500_001) }),
        })
      ).status,
    ).toBe(413);
    const preflight = await api(CAPTURE_API_PATH, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toContain(
      "Authorization",
    );
  });
  test("revocation, expiry, replacement and plan changes invalidate uploads", async () => {
    const first = await issue();
    const second = await issue();
    const connect = (token: string) =>
      api(CONNECTION_API_PATH, {
        headers: { Authorization: `Bearer ${token}` },
      });
    expect((await connect(first.token)).status).toBe(401);
    expect((await connect(second.token)).status).toBe(200);
    await fixtureDb.pg.exec(
      "update marginchat_users set role='member' where id='owner'",
    );
    expect((await connect(second.token)).status).toBe(403);
    await fixtureDb.pg.exec(
      "update marginchat_users set billing_status='active' where id='owner'",
    );
    expect((await connect(second.token)).status).toBe(200);
    await fixtureDb.pg.exec(
      "update marginchat_capture_tokens set expires_at=now()-interval '1 second'",
    );
    expect((await connect(second.token)).status).toBe(401);
    const third = await issue();
    expect(
      (
        await api("/api/settings/capture-token", {
          method: "DELETE",
          headers: { Cookie: cookie, "X-Margin-Capture-Settings": "1" },
        })
      ).status,
    ).toBe(200);
    expect((await connect(third.token)).status).toBe(401);
  });
  test("scopes reads to the owner and pages through timestamp ties without loss", async () => {
    for (let i = 0; i < 33; i++) await service.save("owner", fixture());
    await service.save("other", fixture());
    await fixtureDb.pg.exec(
      "update marginchat_captures set created_at='2026-09-12T12:00:00.123Z'",
    );
    const first = await service.list("owner", null);
    expect(first.captures).toHaveLength(30);
    expect(first.captures[0].content).toBeUndefined();
    const second = await service.list("owner", first.nextCursor);
    expect(second.captures).toHaveLength(3);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.captures, ...second.captures].map((item) => item.id))
        .size,
    ).toBe(33);
    expect(
      await fixtureDb.database.getCapture({
        userId: "other",
        id: first.captures[0].id,
      }),
    ).toBeNull();
    expect(
      (
        await api(`${CAPTURE_API_PATH}?cursor=invalid`, {
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(400);
  });
  test("whole-workspace saves cannot remove an incoming capture", async () => {
    const state = createEmptyState();
    await fixtureDb.database.saveState("owner", state, { expectedRevision: 0 });
    const capture = await service.save("owner", fixture());
    state.conversations[state.rootId].title =
      "An unrelated edit in the open web app";
    await fixtureDb.database.saveState("owner", state, { expectedRevision: 1 });
    expect(
      await fixtureDb.database.getCapture({ userId: "owner", id: capture.id }),
    ).toMatchObject({ title: "Useful reference" });
    expect((await fixtureDb.database.loadWorkspace("owner")).revision).toBe(2);
  });
});
