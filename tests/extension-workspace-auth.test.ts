import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { CAPTURE_API_PATH, CONNECTION_API_PATH, EXTENSION_SESSION_API_PATH, EXTENSION_WORKSPACE_SESSION_API_PATH } from "@margin-chat/capture-contracts";
import { createCaptureTestDatabase } from "./helpers/captureDatabase.mjs";
import { createCaptureService } from "../server/captures/index.mjs";
import { createAuthService } from "../server/auth/index.mjs";
import { hashPassword } from "../server/auth/passwords.mjs";
import { createRuntimeConfig } from "../server/config/runtime.mjs";
import { createApiHandler } from "../server/routes/api.mjs";
import { createVaultService } from "../server/vault/index.mjs";
import { digest } from "../server/vault/storage.mjs";

function memoryStorage() {
  const files = new Map<string, Buffer>();
  return {
    kind: "memory",
    async read(path: string) { const bytes = files.get(path); return bytes ? { bytes, etag: digest(bytes) } : null; },
    async putImmutable(path: string, bytes: Buffer) { files.set(path, Buffer.from(bytes)); },
    async compareAndSwap(path: string, bytes: Buffer, revision: string | null) {
      if ((files.has(path) ? digest(files.get(path)) : null) !== revision) return false;
      files.set(path, Buffer.from(bytes)); return true;
    },
  };
}

describe("extension workspace capability", () => {
  let db: Awaited<ReturnType<typeof createCaptureTestDatabase>>;
  let server: ReturnType<typeof createServer>;
  let origin: string;
  let passwordHash: string;
  let chatUsers: string[];
  const password = "extension-workspace-password";
  const cookie = "margin_chat_session=website-session";
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const api = (path: string, options?: RequestInit) => fetch(`${origin}${path}`, options);
  const login = (path = EXTENSION_WORKSPACE_SESSION_API_PATH, email = "owner@example.test") => api(path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }),
  });
  const capture = () => ({ schemaVersion: 1, clientCaptureId: crypto.randomUUID(), kind: "article", title: "Source",
    sourceUrl: "https://example.test/article", content: "A passage", comment: "My note", capturedAt: new Date().toISOString() });

  beforeAll(async () => {
    db = await createCaptureTestDatabase();
    passwordHash = await hashPassword(password);
  }, 30_000);
  beforeEach(async () => {
    if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
    await db.pg.exec("truncate marginchat_users, marginchat_user_sessions, marginchat_app_sessions cascade");
    for (const id of ["owner", "other"]) await db.database.createUser({ id, email: `${id}@example.test`, displayName: id, role: "admin", passwordHash });
    await db.database.createAuthSession({ id: "website-session", userId: "other", expiresAt: new Date(Date.now() + 60_000) });
    chatUsers = [];
    const config = createRuntimeConfig({});
    const handler = createApiHandler({
      database: db.database, runtimeConfig: config,
      captureService: createCaptureService({ database: db.database }),
      authService: createAuthService({ database: db.database, runtimeConfig: config }),
      vaultService: createVaultService({ storage: memoryStorage() }),
      apiKeyService: {
        async decorateUser(user: any) { return { ...user, apiKeys: { hasAny: false, byProvider: {} } }; },
        async getDecryptedKeys() { return {}; },
        async getSummaries() { return { hasAny: false, byProvider: {} }; },
      },
      billingService: {
        async getBillingDashboard(userId: string) {
          await db.pg.query("update marginchat_users set hosted_credit_balance_micros = 5000000 where id = $1", [userId]);
          return { userId };
        },
      },
      chatService: {
        getPlannedCredentialSource() { return "personal"; },
        async requestReplyStream(_payload: unknown, context: any, handlers: any) {
          chatUsers.push(context.userId);
          await handlers.onReady({ provider: "test" }); await handlers.onDelta("Grounded reply");
          return { metadata: { provider: "test" } };
        },
      },
      urlMapService: async ({ user }: any) => ({ owner: user.id }),
      topicExpansionService: async ({ user }: any) => ({ owner: user.id }),
    });
    server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    await db?.pg.close();
  });

  test("requires fresh credentials and stores a hashed, expiring workspace token without a website cookie", async () => {
    const response = await login();
    expect(response.status).toBe(201);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    const session = await response.json();
    expect(session.scope).toBe("workspace");
    expect(session.token).toMatch(/^mc_workspace_[A-Za-z0-9_-]{43}$/);
    const rows = (await db.pg.query("select token_hash from marginchat_extension_sessions")).rows;
    expect(rows).toEqual([{ token_hash: createHash("sha256").update(session.token).digest("hex") }]);
    const identity = await api("/api/auth/session", { headers: { ...bearer(session.token), Cookie: cookie } });
    expect(identity.headers.get("cache-control")).toContain("no-store");
    expect((await identity.json()).user).toMatchObject({ id: "owner", email: "owner@example.test", role: "admin", apiKeys: { hasAny: false } });
    expect((await api(CONNECTION_API_PATH, { headers: bearer(session.token) })).status).toBe(200);
    expect((await api(EXTENSION_WORKSPACE_SESSION_API_PATH, { method: "POST", headers: { Cookie: cookie }, body: "{}" })).status).toBe(400);
  });

  test("old credentials stay capture-only and changing their prefix cannot gain workspace access or fall back to a cookie", async () => {
    const legacy = await (await login(EXTENSION_SESSION_API_PATH)).json();
    expect((await api("/api/vault", { headers: bearer(legacy.token) })).status).toBe(401);
    const forged = legacy.token.replace("mc_extension_", "mc_workspace_");
    for (const token of [forged, "mc_workspace_invalid"]) {
      for (const path of ["/api/vault", "/api/auth/session", CAPTURE_API_PATH]) {
        expect((await api(path, { headers: { ...bearer(token), Cookie: cookie } })).status).toBe(401);
      }
    }
    const { token } = await (await login()).json();
    expect((await api("/api/vault", { headers: bearer(token.replace("mc_workspace_", "mc_extension_")) })).status).toBe(401);
  });

  test("reads and saves only the account's captures while excluding account and billing administration", async () => {
    const { token } = await (await login()).json();
    const headers = bearer(token);
    const saved = await api(CAPTURE_API_PATH, { method: "POST", headers, body: JSON.stringify(capture()) });
    const id = (await saved.json()).capture.id;
    expect((await (await api(CAPTURE_API_PATH, { headers })).json()).captures).toHaveLength(1);
    expect((await api(`${CAPTURE_API_PATH}/${id}`, { headers })).status).toBe(200);
    const other = await (await login(EXTENSION_WORKSPACE_SESSION_API_PATH, "other@example.test")).json();
    expect((await api(`${CAPTURE_API_PATH}/${id}`, { headers: bearer(other.token) })).status).toBe(404);
    for (const [method, path] of [
      ["PUT", "/api/auth/profile"], ["POST", "/api/auth/password/change"], ["PUT", "/api/settings/api-keys"],
      ["POST", "/api/billing/checkout"], ["POST", "/api/billing/topup"], ["POST", "/api/billing/portal"],
      ["POST", "/api/billing/checkout/confirm"], ["POST", "/api/settings/capture-token"],
      ["DELETE", "/api/settings/capture-token"], ["PUT", "/api/state"], ["POST", "/api/auth/logout"],
    ]) {
      expect((await api(path, { method, headers: { ...headers, Cookie: cookie }, body: "{}" })).status).toBe(403);
    }
  });

  test("cross-origin bearer vault sync preserves account checks, content revisions, binary CORS and cookie CSRF defenses", async () => {
    const { token } = await (await login()).json();
    const headers = { ...bearer(token), "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site", "X-Margin-Vault-User": "owner" };
    const body = JSON.stringify({ changes: [{ path: "Notes/source.md", content: "Source annotation", baseRevision: null }] });
    const saved = await api("/api/vault/commit", { method: "POST", headers, body });
    expect(saved.status).toBe(200);
    const revision = (await saved.json()).manifest.files["Notes/source.md"].revision;
    const file = await api("/api/vault/file?path=Notes%2Fsource.md", { headers });
    expect(await file.text()).toBe("Source annotation");
    expect(file.headers.get("access-control-allow-origin")).toBe("*");
    expect(file.headers.get("access-control-expose-headers")).toContain("ETag");
    expect(file.headers.get("etag")).toBe(`"${revision}"`);
    expect((await api("/api/vault", { headers: { ...headers, "X-Margin-Vault-User": "other" } })).status).toBe(409);
    expect((await api("/api/state", { headers: { ...headers, "X-Margin-Vault-User": "other" } })).status).toBe(409);
    expect((await api("/api/vault/commit", { method: "POST", headers: { ...headers, "Content-Type": "text/plain" }, body })).status).toBe(403);
    expect((await api("/api/vault/commit", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" }, body })).status).toBe(403);
    const changed = JSON.stringify({ changes: [{ path: "Notes/source.md", content: "Conflict", baseRevision: null }] });
    expect((await api("/api/vault/commit", { method: "POST", headers, body: changed })).status).toBe(409);
    const upload = await api("/api/vault/file?path=Attachments%2Fsource.bin", {
      method: "PUT", headers: { ...headers, "Content-Type": "application/octet-stream", "X-Margin-Vault-Write": "1" }, body: new Uint8Array([0, 255, 1]),
    });
    expect(upload.status).toBe(200);
    const preflight = await api("/api/billing/dashboard", { method: "OPTIONS" });
    expect(preflight.headers.get("access-control-allow-headers")).toContain("X-Margin-Billing-User");
    expect(preflight.headers.get("access-control-allow-credentials")).toBeNull();
  });

  test("AI and billing use bearer identity and current billing details instead of ambient website cookies", async () => {
    const { token } = await (await login()).json();
    const headers = { ...bearer(token), Cookie: cookie, "Content-Type": "application/json", "X-Margin-Vault-User": "owner" };
    const chat = await api("/api/chat", { method: "POST", headers, body: "{}" });
    expect(chat.status).toBe(200);
    expect(await chat.text()).toContain("Grounded reply");
    expect(chat.headers.get("cache-control")).toContain("no-store");
    expect(chatUsers).toEqual(["owner"]);
    expect((await api("/api/chat", { method: "POST", headers: { ...headers, "X-Margin-Vault-User": "other" }, body: "{}" })).status).toBe(409);
    expect((await api("/api/jev/workspace", { method: "POST", headers: { ...headers, "Sec-Fetch-Site": "cross-site" }, body: "{}" })).status).toBe(200);
    for (const path of ["/api/graph/url", "/api/graph/topic"]) {
      const graph = await api(path, { method: "POST", headers: { ...headers, "Sec-Fetch-Site": "cross-site" }, body: "{}" });
      expect(graph.status).toBe(200);
      expect(graph.headers.get("access-control-allow-origin")).toBe("*");
      expect(graph.headers.get("content-type")).toContain("application/x-ndjson");
      expect(await graph.text()).toContain('"owner":"owner"');
      expect((await api(path, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" }, body: "{}" })).status).toBe(403);
    }
    const dashboard = await api("/api/billing/dashboard", { headers: { ...headers, "X-Margin-Billing-User": "owner" } });
    expect((await dashboard.json()).user).toMatchObject({ id: "owner", billing: { creditBalanceMicros: 5000000 } });
    expect((await api("/api/billing/dashboard", { headers: { ...headers, "X-Margin-Billing-User": "other" } })).status).toBe(409);
  });

  test("expiry, downgrade and sign-out revoke workspace access without disturbing other browser sessions", async () => {
    const first = await (await login()).json();
    const second = await (await login()).json();
    expect((await api(EXTENSION_SESSION_API_PATH, { method: "DELETE", headers: bearer(first.token) })).status).toBe(200);
    expect((await api("/api/auth/session", { headers: bearer(first.token) })).status).toBe(401);
    expect((await api("/api/auth/session", { headers: bearer(second.token) })).status).toBe(200);
    await db.pg.exec("update marginchat_users set role = 'member', billing_status = 'canceled' where id = 'owner'");
    expect((await api("/api/vault", { headers: bearer(second.token) })).status).toBe(403);
    await db.pg.exec("update marginchat_users set role = 'admin' where id = 'owner'; update marginchat_extension_sessions set expires_at = now() - interval '1 second'");
    expect((await api("/api/vault", { headers: bearer(second.token) })).status).toBe(401);
    expect((await api(EXTENSION_SESSION_API_PATH, { method: "DELETE", headers: bearer(second.token) })).status).toBe(200);
  });

  test("password resets revoke workspace sessions together with existing capture sessions", async () => {
    const workspace = await (await login()).json();
    const legacy = await (await login(EXTENSION_SESSION_API_PATH)).json();
    const resetToken = "r".repeat(43);
    await db.database.createPasswordResetToken({ userId: "owner", tokenHash: createHash("sha256").update(resetToken).digest("hex"), expiresAt: new Date(Date.now() + 60_000) });
    expect((await api("/api/auth/password-reset/confirm", { method: "POST", body: JSON.stringify({ token: resetToken, password: "replacement-workspace-password" }) })).status).toBe(200);
    expect((await api("/api/vault", { headers: bearer(workspace.token) })).status).toBe(401);
    expect((await api(CONNECTION_API_PATH, { headers: bearer(legacy.token) })).status).toBe(401);
  });
});
