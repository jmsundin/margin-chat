import { describe, expect, test } from "bun:test";
import { createApiHandler } from "../server/routes/api.mjs";
import { createVaultStorage } from "../server/vault/storage.mjs";

describe("release readiness", () => {
  test("a fresh database failure overrides successful cached initialization and returns 503", async () => {
    let checked = 0;
    const handler = createApiHandler({
      database: { ready: async () => {}, getHealth: () => ({ ready: true }), checkHealth: async () => {
        checked += 1;
        return { ready: false, error: "connection unavailable" };
      } },
      chatService: { buildHealthPayload: (postgres: unknown) => ({ storage: { postgres } }) },
      vaultService: { configured: true, storageKind: "blob" },
      runtimeConfig: { host: "localhost", port: 8787 },
    });
    const result: any = {};
    await handler({ method: "GET", url: "/api/health", headers: { host: "localhost" } }, {
      writeHead(status: number, headers: unknown) { Object.assign(result, { status, headers }); },
      end(body: string) { result.body = JSON.parse(body); },
    });
    expect(checked).toBe(1);
    expect(result.status).toBe(503);
    expect(result.body.storage.postgres.ready).toBe(false);
    expect(result.body.storage.vault).toEqual({ configured: true, kind: "blob" });
    expect(result.headers["Cache-Control"]).toBe("no-store");
  });

  test("rejects rehearsal prefixes that could escape their assigned namespace before accessing storage", () => {
    for (const prefix of ["/absolute/", "rehearsal/../production/", "rehearsal//test/", "rehearsal\\test/", "rehearsal"]) {
      expect(() => createVaultStorage({ BLOB_READ_WRITE_TOKEN: "test-only", VAULT_STORAGE_PREFIX: prefix })).toThrow("relative directory prefix");
    }
    expect(createVaultStorage({ BLOB_READ_WRITE_TOKEN: "test-only", VAULT_STORAGE_PREFIX: "release-rehearsal/release-123/" }).kind).toBe("blob");
  });
});
