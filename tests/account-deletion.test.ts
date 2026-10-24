import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createAuthService } from "../server/auth/index.mjs";
import { hashPassword } from "../server/auth/passwords.mjs";
import { normalizeAccountDeletionPayload } from "../server/auth/validation.mjs";
import { createBillingService } from "../server/billing/index.mjs";
import { createRuntimeConfig } from "../server/config/runtime.mjs";
import { createApiHandler } from "../server/routes/api.mjs";
import { createVaultService } from "../server/vault/index.mjs";
import { createFileVaultStorage, digest } from "../server/vault/storage.mjs";
import { createEmptyState } from "../client/src/initialState";
import { createCaptureTestDatabase } from "./helpers/captureDatabase.mjs";

const password = "account-password-123";
const deletePath = "/api/auth/account/delete";

describe("account deletion payload", () => {
  test("needs the typed confirmation and a password", () => {
    for (const input of [null, [], {}, { password }, { password, confirmation: "delete" }, { password: "", confirmation: "DELETE" }]) {
      expect(() => normalizeAccountDeletionPayload(input)).toThrow();
    }
    expect(normalizeAccountDeletionPayload({ password: " spaced ", confirmation: "DELETE" })).toEqual({ password: " spaced " });
  });
});

describe("deleting an account", () => {
  let fixture: Awaited<ReturnType<typeof createCaptureTestDatabase>>;
  let handler: ReturnType<typeof createApiHandler>;
  let directory: string;
  const deletedCustomers: string[] = [];

  beforeAll(async () => {
    fixture = await createCaptureTestDatabase();
    directory = await mkdtemp(join(tmpdir(), "margin-account-deletion-"));
    const runtimeConfig = createRuntimeConfig({});
    const authService = createAuthService({ database: fixture.database, runtimeConfig, env: {} });
    const vaultService = createVaultService({ database: fixture.database, env: {}, storage: createFileVaultStorage(directory) });
    const billingService = { async deleteCustomer(userId: string) { deletedCustomers.push(userId); } };
    handler = createApiHandler({ database: fixture.database, authService, billingService, vaultService, runtimeConfig } as any);
  }, 30_000);
  afterAll(async () => {
    await fixture?.pg.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

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
    } as any);
    return result;
  }

  async function account(role = "member") {
    const id = crypto.randomUUID();
    const user = await fixture.database.createUser({
      id, displayName: "Leaving soon", email: `${id}@example.test`, passwordHash: await hashPassword(password), role,
    });
    const login = await request("/api/auth/login", { email: user.email, password });
    return { user, cookie: login.headers["Set-Cookie"].split(";")[0] };
  }

  /** A workspace, credentials, tokens and cloud vault files, like a real account has. */
  async function fill(userId: string) {
    await fixture.database.saveState(userId, createEmptyState(), { expectedRevision: 0 });
    const expiresAt = new Date(Date.now() + 60_000);
    await fixture.database.createPasswordResetToken({ userId, expiresAt, tokenHash: crypto.randomUUID() });
    await fixture.database.createExtensionSession({ userId, expiresAt, tokenHash: crypto.randomUUID() });
    await fixture.database.createMcpToken({ userId, name: "Claude Code", tokenHash: crypto.randomUUID(), expiresAt });
    const storage = createFileVaultStorage(directory);
    await storage.putImmutable(`vaults/v1/${digest(userId)}/files/a/1`, Buffer.from("# Note"));
    await storage.compareAndSwap(`vaults/v1/${digest(userId)}/manifest.json`, Buffer.from("{}"), null);
  }

  async function rows(userId: string) {
    const result = await fixture.client.query(`
      select
        (select count(*)::int from marginchat_users where id = $1) as users,
        (select count(*)::int from marginchat_app_sessions where user_id = $1) as workspaces,
        (select count(*)::int from marginchat_user_sessions where user_id = $1) as sessions,
        (select count(*)::int from marginchat_password_reset_tokens where user_id = $1) as resets,
        (select count(*)::int from marginchat_extension_sessions where user_id = $1) as extensions,
        (select count(*)::int from marginchat_mcp_tokens where user_id = $1) as tokens
    `, [userId]);
    return result.rows[0];
  }

  const vaultFolders = async () => readdir(join(directory, "vaults", "v1")).catch(() => [] as string[]);

  test("needs a signed-in browser session", async () => {
    const result = await request(deletePath, { password, confirmation: "DELETE" });
    expect(result.status).toBe(401);
  });

  test("a wrong password or missing confirmation deletes nothing", async () => {
    const { user, cookie } = await account();
    await fill(user.id);
    for (const body of [{ password: "wrong-password", confirmation: "DELETE" }, { password, confirmation: "delete" }]) {
      const result = await request(deletePath, body, cookie);
      expect(result.status).toBe(400);
    }
    expect(await rows(user.id)).toEqual({ users: 1, workspaces: 1, sessions: 1, resets: 1, extensions: 1, tokens: 1 });
    expect(await vaultFolders()).toContain(digest(user.id));
    expect(deletedCustomers).not.toContain(user.id);
  });

  test("removes the account, its workspace, credentials and cloud files, and signs out", async () => {
    const { user, cookie } = await account();
    const { user: neighbour } = await account();
    await fill(user.id);
    await fill(neighbour.id);
    const conversations = async (userId: string) => (await fixture.client.query(
      "select count(*)::int as count from marginchat_conversations c join marginchat_app_sessions s on s.id = c.session_id where s.user_id = $1",
      [userId],
    )).rows[0].count;
    expect(await conversations(user.id)).toBeGreaterThan(0);

    const result = await request(deletePath, { password, confirmation: "DELETE" }, cookie);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true });
    expect(result.headers["Set-Cookie"]).toContain("Max-Age=0");
    expect(deletedCustomers).toContain(user.id);
    expect(await rows(user.id)).toEqual({ users: 0, workspaces: 0, sessions: 0, resets: 0, extensions: 0, tokens: 0 });
    expect(await conversations(user.id)).toBe(0);
    expect(await vaultFolders()).not.toContain(digest(user.id));
    expect((await request("/api/auth/session", undefined, cookie)).body.user).toBeNull();
    expect((await request("/api/auth/login", { email: user.email, password })).status).toBe(401);

    // Another account is untouched.
    expect(await rows(neighbour.id)).toEqual({ users: 1, workspaces: 1, sessions: 1, resets: 1, extensions: 1, tokens: 1 });
    expect(await conversations(neighbour.id)).toBeGreaterThan(0);
    expect(await vaultFolders()).toContain(digest(neighbour.id));
  });

  test("a Stripe failure stops before any data is removed, so the account can try again", async () => {
    const { user, cookie } = await account();
    await fill(user.id);
    const runtimeConfig = createRuntimeConfig({});
    const failing = createApiHandler({
      database: fixture.database, runtimeConfig,
      authService: createAuthService({ database: fixture.database, runtimeConfig, env: {} }),
      billingService: { async deleteCustomer() { throw new Error("Stripe is down"); } },
      vaultService: createVaultService({ database: fixture.database, env: {}, storage: createFileVaultStorage(directory) }),
    } as any);
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ password, confirmation: "DELETE" }))]), {
      method: "POST", url: deletePath, headers: { host: "localhost", "content-type": "application/json", cookie },
    });
    let status = 0;
    await failing(req, { writeHead(code: number) { status = code; }, end() {} } as any);
    expect(status).toBe(500);
    expect(await rows(user.id)).toEqual({ users: 1, workspaces: 1, sessions: 1, resets: 1, extensions: 1, tokens: 1 });
    expect(await vaultFolders()).toContain(digest(user.id));
  });

  test("admin accounts can't be deleted from Settings", async () => {
    const { user, cookie } = await account("admin");
    const result = await request(deletePath, { password, confirmation: "DELETE" }, cookie);
    expect(result.status).toBe(409);
    expect((await rows(user.id)).users).toBe(1);
  });
});

describe("billing when an account is deleted", () => {
  test("deletes the Stripe customer, which cancels its subscriptions", async () => {
    const deleted: string[] = [];
    const accounts: Record<string, unknown> = { paid: { id: "paid", stripeCustomerId: "cus_paid" }, free: { id: "free", stripeCustomerId: null }, gone: { id: "gone", stripeCustomerId: "cus_gone" } };
    const billing = createBillingService({
      database: { getUserBillingAccount: async (id: string) => accounts[id] ?? null } as any,
      env: {},
      stripeClient: { customers: { async del(id: string) {
        if (id === "cus_gone") throw Object.assign(new Error("No such customer"), { code: "resource_missing" });
        deleted.push(id);
      } } } as any,
    });
    await billing.deleteCustomer("paid");
    await billing.deleteCustomer("free");
    await billing.deleteCustomer("gone");
    expect(deleted).toEqual(["cus_paid"]);
  });
});

describe("cloud vault storage", () => {
  test("Blob storage deletes every page of keys under a prefix and nothing else", async () => {
    const keys = [...Array.from({ length: 2500 }, (_, index) => `vaults/v1/abc/files/${index}`), "vaults/v1/abcd/manifest.json"];
    const listed: Array<string | undefined> = [];
    const deleted: string[] = [];
    const sdk = {
      async list({ prefix, limit, cursor }: { prefix: string; limit: number; cursor?: string }) {
        listed.push(cursor);
        const matching = keys.filter((key) => key.startsWith(prefix) && !deleted.includes(`https://blob/${key}`));
        const page = matching.slice(0, limit);
        return { blobs: page.map((key) => ({ url: `https://blob/${key}` })), hasMore: matching.length > limit, cursor: matching.length > limit ? "next" : undefined };
      },
      async del(urls: string[]) { deleted.push(...urls); },
    };
    const { createBlobVaultStorage } = await import("../server/vault/storage.mjs");
    await createBlobVaultStorage({ BLOB_READ_WRITE_TOKEN: "token" }, sdk).removePrefix("vaults/v1/abc/");
    expect(deleted).toHaveLength(2500);
    expect(deleted).not.toContain("https://blob/vaults/v1/abcd/manifest.json");
    expect(listed).toEqual([undefined, "next", "next"]);
    await expect(createBlobVaultStorage({ BLOB_READ_WRITE_TOKEN: "token" }, sdk).removePrefix("vaults/v1/abc")).rejects.toThrow();
  });
});
