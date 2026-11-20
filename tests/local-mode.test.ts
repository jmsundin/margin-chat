import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LOCAL_TOKEN_HEADER, localModeEnv, startLocalServer } from "../server/local/server.mjs";
import { createPglitePool } from "../server/db/pglitePool.mjs";

// The desktop app runs the whole server on the computer with no account (docs/desktop-local-mode.md)..
const dataDir = mkdtempSync(path.join(tmpdir(), "margin-local-"));
const token = randomBytes(32).toString("hex");
const encryptionKey = randomBytes(32).toString("base64");
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

async function call(url: string, route: string, init: RequestInit = {}) {
  const response = await fetch(url + route, { ...init, headers: { [LOCAL_TOKEN_HEADER]: token, ...(init.headers ?? {}) } });
  const text = await response.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body };
}

describe("desktop local mode", () => {
  test("keeps hosted keys from the shell out and needs its own folder and lock key", () => {
    const env = localModeEnv({ dataDir: "/data", encryptionKey: "k" });
    expect(env).toEqual({
      MARGIN_LOCAL_MODE: "1", MARGIN_LOCAL_DATA_DIR: "/data", VAULT_STORAGE_DIR: path.join("/data", "vault"),
      API_KEY_ENCRYPTION_KEY: "k", HOST: "127.0.0.1",
    });
    expect(() => localModeEnv({ dataDir: "", encryptionKey: "k" })).toThrow();
    expect(() => localModeEnv({ dataDir: "/data", encryptionKey: "" })).toThrow();
  });

  test("works with no account, keeps files and keys, and remembers them after a restart", async () => {
    let server = await startLocalServer({ dataDir, encryptionKey, token });
    try {
      const session = await call(server.url, "/api/auth/session");
      expect(session.status).toBe(200);
      expect(session.body.user.billing.accessKind).toBe("local");
      expect(session.body.user.billing.hasAccess).toBe(false);
      const userId = session.body.user.id;

      // Without the app's token nothing answers, even from this computer.
      expect((await fetch(server.url + "/api/auth/session")).status).toBe(403);

      // There is no account to sign in to, sign up for or pay for.
      for (const [method, route] of [["POST", "/api/auth/login"], ["POST", "/api/auth/signup"], ["POST", "/api/billing/checkout"]]) {
        const result = await call(server.url, route, { method, headers: { "Content-Type": "application/json" }, body: "{}" });
        expect(result.status).toBe(404);
        expect(result.body.error).toContain("without an account");
      }

      const saved = await call(server.url, "/api/settings/api-keys", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keys: { openai: "sk-test-local-1234567890" } }),
      });
      expect(saved.status).toBe(200);

      const write = await call(server.url, "/api/vault/file?path=Notes%2Fhello.md", {
        method: "PUT", headers: { "Content-Type": "text/markdown", "x-margin-vault-write": "1" }, body: "# Hello\n",
      });
      expect(write.status).toBe(200);
      expect((await call(server.url, "/api/vault")).status).toBe(200);

      await server.close();
      server = await startLocalServer({ dataDir, encryptionKey, token });
      const again = await call(server.url, "/api/auth/session");
      expect(again.body.user.id).toBe(userId);
      expect(again.body.user.apiKeys.byProvider.openai.configured).toBe(true);
      const vault = await call(server.url, "/api/vault");
      expect(JSON.stringify(vault.body)).toContain("Notes/hello.md");
    } finally {
      await server.close();
    }
  }, 60_000);
});

describe("in-process database pool", () => {
  test("one lease at a time, so transactions never interleave", async () => {
    const pool = createPglitePool();
    try {
      await pool.query("create table t (n int)");
      const first = await pool.connect();
      await first.query("begin");
      await first.query("insert into t values (1)");
      let secondRan = false;
      const second = pool.connect().then(async (client) => {
        secondRan = true;
        const result = await client.query("select count(*)::int as n from t");
        await client.release();
        return result.rows[0].n;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(secondRan).toBe(false);
      await first.query("rollback");
      await first.release();
      expect(await second).toBe(0);
    } finally {
      await pool.end();
    }
  });

  test("a client released after an error rolls back what it left open", async () => {
    const pool = createPglitePool();
    try {
      await pool.query("create table t (n int)");
      const client = await pool.connect();
      await client.query("begin");
      await client.query("insert into t values (1)");
      await client.release(new Error("failed"));
      expect((await pool.query("select count(*)::int as n from t")).rows[0].n).toBe(0);
    } finally {
      await pool.end();
    }
  });
});

describe("desktop local secret", () => {
  const fakeKeychain = {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(`locked:${text}`),
    decryptString: (bytes: Buffer) => String(bytes).replace(/^locked:/u, ""),
  };

  test("the app and its server agree on the token header", async () => {
    const desktop = await import("../desktop/localMode.mjs");
    expect(desktop.LOCAL_TOKEN_HEADER).toBe(LOCAL_TOKEN_HEADER);
  });

  test("is made once and kept locked by the keychain", async () => {
    const { loadLocalSecret } = await import("../desktop/localMode.mjs");
    const dir = mkdtempSync(path.join(tmpdir(), "margin-secret-"));
    try {
      const first = await loadLocalSecret({ dir, safeStorage: fakeKeychain });
      expect(Buffer.from(first, "base64")).toHaveLength(32);
      expect(await loadLocalSecret({ dir, safeStorage: fakeKeychain })).toBe(first);
      expect(String(await Bun.file(path.join(dir, "secret.locked")).text())).toBe(`locked:${first}`);
      expect(await Bun.file(path.join(dir, "secret.key")).exists()).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("without a keychain it is kept for this user only, and locked once a keychain appears", async () => {
    const { loadLocalSecret } = await import("../desktop/localMode.mjs");
    const dir = mkdtempSync(path.join(tmpdir(), "margin-secret-"));
    try {
      const first = await loadLocalSecret({ dir, safeStorage: { isEncryptionAvailable: () => false } });
      const { statSync } = await import("node:fs");
      expect(statSync(path.join(dir, "secret.key")).mode & 0o777).toBe(0o600);
      expect(await loadLocalSecret({ dir, safeStorage: fakeKeychain })).toBe(first);
      expect(await loadLocalSecret({ dir, safeStorage: fakeKeychain })).toBe(first);
      expect(await Bun.file(path.join(dir, "secret.key")).exists()).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
