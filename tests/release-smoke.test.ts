import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkReadiness, waitForProductionReadiness, runPersistenceSmoke } from "../scripts/release/smoke.mjs";
import { createCaptureTestDatabase } from "./helpers/captureDatabase.mjs";
import { createApiHandler } from "../server/routes/api.mjs";
import { createAuthService } from "../server/auth/index.mjs";
import { createRuntimeConfig } from "../server/config/runtime.mjs";
import { createVaultService } from "../server/vault/index.mjs";
import { createFileVaultStorage } from "../server/vault/storage.mjs";
import { listVaultAttachments } from "../server/db/documentRepository.mjs";
import { writeState } from "../server/db/repository.mjs";
import { normalizeAppState } from "../server/db/validation.mjs";

describe("production persistence readiness", () => {
  const healthy = {
    release: "expected-release",
    storage: { postgres: { ready: true }, vault: { configured: true, kind: "blob" } },
  };
  test("checks the serving release and forwards deployment protection credentials", async () => {
    let called = false;
    const result = await checkReadiness({ baseUrl: "https://release.example.test", expectedSha: "expected-release", bypassSecret: "test-only",
      fetchImpl: async (url: URL, options: RequestInit) => {
        called = true;
        expect(url.pathname).toBe("/api/health");
        expect(options.headers).toEqual({ "x-vercel-protection-bypass": "test-only" });
        expect(options.redirect).toBe("error");
        return Response.json(healthy);
      },
    });
    expect(called).toBe(true);
    expect(result).toEqual({ database: "ready", vault: "configured", release: "expected-release" });
  });
  test("rejects degraded storage, filesystem storage and the wrong release", async () => {
    for (const [status, payload, message] of [
      [503, healthy, "Database readiness failed"],
      [200, { ...healthy, storage: { ...healthy.storage, postgres: { ready: false } } }, "Database is not ready"],
      [200, { ...healthy, storage: { ...healthy.storage, vault: { configured: false, kind: "blob" } } }, "Vault is not configured"],
      [200, { ...healthy, storage: { ...healthy.storage, vault: { configured: true, kind: "filesystem" } } }, "requires Blob"],
      [200, { ...healthy, release: "previous-release" }, "different release"],
    ] as const) {
      await expect(checkReadiness({ baseUrl: "https://release.example.test", expectedSha: "expected-release",
        fetchImpl: async () => Response.json(payload, { status }),
      })).rejects.toThrow(message);
    }
  });

  function propagationFixture(releases: Array<string | undefined>) {
    let clock = 0, reads = 0, locks = 0;
    return {
      counts: () => ({ clock, reads, locks }),
      options: {
        baseUrl: "https://release.example.test", expectedSha: "expected-release", previousSha: "previous-release",
        timeoutMs: 30, pollMs: 10, now: () => clock,
        sleep: async (ms: number) => { clock += ms; },
        assertLock: async () => { locks++; },
        fetchImpl: async () => Response.json({ ...healthy, release: releases[Math.min(reads++, releases.length - 1)] }),
      },
    };
  }

  test("waits for the known previous release to yield to the promoted release", async () => {
    const f = propagationFixture(["previous-release", "previous-release", "expected-release"]);
    expect((await waitForProductionReadiness(f.options)).release).toBe("expected-release");
    expect(f.counts()).toEqual({ clock: 20, reads: 3, locks: 3 });
    const immediate = propagationFixture(["expected-release"]);
    await waitForProductionReadiness(immediate.options);
    expect(immediate.counts()).toEqual({ clock: 0, reads: 1, locks: 1 });
  });

  test("bounds propagation waiting when the public origin keeps serving the previous release", async () => {
    const f = propagationFixture(["previous-release"]);
    await expect(waitForProductionReadiness(f.options)).rejects.toThrow("Timed out");
    expect(f.counts()).toEqual({ clock: 30, reads: 3, locks: 3 });
  });

  test("does not treat missing or unrelated release identity as propagation", async () => {
    for (const release of [undefined, "unrelated-release"]) {
      const f = propagationFixture([release]);
      await expect(waitForProductionReadiness(f.options)).rejects.toThrow("unexpected release");
      expect(f.counts().reads).toBe(1);
      expect(f.counts().clock).toBe(0);
    }
    const f = propagationFixture(["previous-release"]);
    await expect(waitForProductionReadiness({ ...f.options, previousSha: undefined })).rejects.toThrow("unexpected release");
  });

  test("waits out a previous deployment made outside the release runner", async () => {
    const f = propagationFixture([undefined, "expected-release"]);
    const options = { ...f.options, previousSha: undefined, previousUnidentified: true };
    expect((await waitForProductionReadiness(options)).release).toBe("expected-release");
    expect(f.counts().reads).toBe(2);
    const unrelated = propagationFixture(["unrelated-release"]);
    await expect(waitForProductionReadiness({ ...unrelated.options, previousSha: undefined, previousUnidentified: true })).rejects.toThrow("unexpected release");
  });

  test("propagation waiting still fails immediately for unhealthy storage or a lost lock", async () => {
    const f = propagationFixture(["previous-release"]);
    await expect(waitForProductionReadiness({ ...f.options, fetchImpl: async () => Response.json(healthy, { status: 503 }) })).rejects.toThrow("Database readiness failed");
    await expect(waitForProductionReadiness({ ...f.options, assertLock: async () => { throw new Error("lost lock"); } })).rejects.toThrow("lost lock");
    expect(f.counts().clock).toBe(0);
    expect(f.counts().reads).toBe(0);
  });
});

describe("release smoke against the real authenticated HTTP API", () => {
  let fixture: Awaited<ReturnType<typeof createCaptureTestDatabase>>;
  beforeAll(async () => { fixture = await createCaptureTestDatabase(); }, 30000);
  afterAll(async () => { await fixture?.pg.close(); });
  beforeEach(async () => {
    await fixture.pg.exec("truncate marginchat_users, marginchat_user_sessions, marginchat_password_reset_tokens, marginchat_app_sessions cascade");
  });

  async function actualApi(options: { pending?: boolean; wrongLoginId?: boolean; unsafeCleanup?: boolean; repeatedCleanupCursor?: boolean } = {}) {
    const directory = await mkdtemp(join(tmpdir(), "margin-release-smoke-"));
    const client = fixture.client;
    const database = {
      ...fixture.database,
      listVaultAttachments: (userId: string) => listVaultAttachments(client, userId),
      getVaultProjectionRevision: async (userId: string) => {
        const rows = await client.query("select vault_revision from marginchat_vault_projections where user_id = $1", [userId]);
        return rows.rowCount ? Number(rows.rows[0].vault_revision) : null;
      },
      projectVaultState: (userId: string, state: any, revision: number, projection: any) => writeState(client, userId,
        state === null ? null : normalizeAppState(state), {
          vaultRevision: revision, forceVaultProjection: projection.force,
          vaultAttachments: projection.attachments, deletedVaultAttachmentIds: projection.deletedAttachmentIds,
        }),
    };
    await database.createUser({ id: "retained-user", email: "retained@example.test", displayName: "Retained", role: "admin", passwordHash: "unused" });
    const source = createVaultService({ database, storage: createFileVaultStorage(directory), env: {} });
    await source.commit("retained-user", [{ path: "Notes/retained.md", content: "# Retained\n\nExisting private content.", baseRevision: null }]);
    const config = createRuntimeConfig({});
    const auth = createAuthService({ database, runtimeConfig: config, env: {} });
    const authService = options.wrongLoginId ? { ...auth, login: async (payload: any) => {
      const result = await auth.login(payload);
      return { ...result, user: { ...result.user, id: "retained-user" } };
    } } : auth;
    const vaultService = options.pending ? { ...source, commit: async (...args: any[]) => {
      const result = await (source.commit as any)(...args);
      return { ...result, projection: { ...result.projection, status: "pending" } };
    } } : source;
    const server = createServer(createApiHandler({ database, authService, vaultService, runtimeConfig: config } as any));
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const requestedPrefixes: string[] = [];
    const deleted: string[] = [];
    const blobSdk = {
      async list({ prefix }: { prefix: string }) {
        requestedPrefixes.push(prefix);
        if (options.unsafeCleanup) return { blobs: [{ pathname: "vaults/v1/another-account/private.md", url: "https://fake.blob.test/outside" }], hasMore: false };
        if (options.repeatedCleanupCursor) return { blobs: [], hasMore: true, cursor: "repeated-cursor" };
        const names = await readdir(directory, { recursive: true });
        const blobs = [];
        for (const name of names.filter((name) => name.startsWith(prefix))) {
          if ((await stat(join(directory, name))).isFile()) blobs.push({ pathname: name, url: `https://fake.blob.test/${name}` });
        }
        return { blobs, hasMore: false };
      },
      async del(urls: string[]) {
        for (const url of urls) {
          const name = new URL(url).pathname.slice(1);
          expect(name.startsWith(requestedPrefixes.at(-1)!)).toBe(true);
          const path = resolve(directory, name);
          expect(path.startsWith(`${directory}/`)).toBe(true);
          deleted.push(name);
          await rm(path);
        }
      },
    };
    return {
      baseUrl, database, client, blobSdk, requestedPrefixes, deleted, source, directory,
      async close() {
        server.closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
        await rm(directory, { recursive: true, force: true });
      },
    };
  }

  async function retainedAccountOnly(api: Awaited<ReturnType<typeof actualApi>>) {
    const users = await api.client.query("select id from marginchat_users order by id");
    expect(users.rows).toEqual([{ id: "retained-user" }]);
    expect((await api.client.query("select count(*)::integer as count from marginchat_user_sessions")).rows[0].count).toBe(0);
    expect((await api.source.readFile({ userId: "retained-user", path: "Notes/retained.md" })).bytes.toString())
      .toBe("# Retained\n\nExisting private content.");
  }

  test("round-trips content, immutable history, conflict rejection, bytes and projection, then cleans only its account", async () => {
    const api = await actualApi();
    try {
      const result = await runPersistenceSmoke({ ...api, blobToken: "test-only" });
      expect(result.checks).toEqual(["login", "save/read", "stale-write rejection", "immutable history", "binary round trip", "tombstones", "SQL projection"]);
      expect(api.requestedPrefixes).toHaveLength(1);
      expect(api.requestedPrefixes[0]).toMatch(/^vaults\/v1\/[a-f0-9]{64}\/$/);
      expect(api.deleted.length).toBeGreaterThan(5);
      await retainedAccountOnly(api);
      const remaining = await readdir(api.directory, { recursive: true });
      for (const path of remaining.filter((name) => name.startsWith(api.requestedPrefixes[0]))) {
        expect((await stat(join(api.directory, path))).isFile()).toBe(false);
      }
    } finally { await api.close(); }
  });

  test("HTTP 200 with pending projection fails verification and still cleans the synthetic writes", async () => {
    const api = await actualApi({ pending: true });
    try {
      await expect(runPersistenceSmoke({ ...api, blobToken: "test-only" })).rejects.toThrow("Vault projection is pending");
      expect(api.deleted.length).toBeGreaterThan(0);
      await retainedAccountOnly(api);
    } finally { await api.close(); }
  });

  test("an unexpected authenticated account stops all vault writes and preserves existing data", async () => {
    const api = await actualApi({ wrongLoginId: true });
    try {
      await expect(runPersistenceSmoke({ ...api, blobToken: "test-only" })).rejects.toThrow("unexpected account");
      expect(api.deleted).toHaveLength(0);
      await retainedAccountOnly(api);
    } finally { await api.close(); }
  });

  test("cleanup refuses any object outside its exact synthetic prefix", async () => {
    const api = await actualApi({ unsafeCleanup: true });
    try {
      await expect(runPersistenceSmoke({ ...api, blobToken: "test-only" })).rejects.toThrow("synthetic account boundary");
      expect(api.deleted).toHaveLength(0);
      await retainedAccountOnly(api);
    } finally { await api.close(); }
  });

  test("cleanup rejects repeated pagination cursors instead of waiting forever", async () => {
    const api = await actualApi({ repeatedCleanupCursor: true });
    try {
      await expect(runPersistenceSmoke({ ...api, blobToken: "test-only" })).rejects.toThrow("pagination did not advance");
      expect(api.requestedPrefixes).toHaveLength(2);
      expect(api.deleted).toHaveLength(0);
      await retainedAccountOnly(api);
    } finally { await api.close(); }
  });
});
