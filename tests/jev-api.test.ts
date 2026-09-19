import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { createApiHandler } from "../server/routes/api.mjs";

describe("Jev workspace API", () => {
  let server: ReturnType<typeof createServer>, origin: string;
  const calls: any[] = [];
  beforeAll(async () => {
    const handler = createApiHandler({
      runtimeConfig: { host: "127.0.0.1", port: 0 },
      authService: { getAuthContext: async (request: any) => ({ user: request.headers["x-test-signed-in"] ? { id: "owner" } : null }) },
      semanticService: { configured: true, async analyzeWorkspace(args: any) { calls.push(args); return { available: true, categories: [], related: [] }; } },
    });
    server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const headers = { "Content-Type": "application/json", "X-Test-Signed-In": "1", "X-Margin-Vault-User": "owner" };

  test("status is authenticated and exposes only configuration availability", async () => {
    expect((await fetch(`${origin}/api/jev/status`)).status).toBe(401);
    const response = await fetch(`${origin}/api/jev/status`, { headers });
    expect(await response.json()).toEqual({ configured: true });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  test("rejects stale-account and cross-site analysis before using the model", async () => {
    for (const [overrides, status] of [
      [{ "X-Margin-Vault-User": "other" }, 409],
      [{ "Sec-Fetch-Site": "cross-site" }, 403],
      [{ "Content-Type": "text/plain" }, 403],
    ] as const) {
      const response = await fetch(`${origin}/api/jev/workspace`, { method: "POST", headers: { ...headers, ...overrides }, body: "{}" });
      expect(response.status).toBe(status);
    }
    expect(calls).toHaveLength(0);
  });

  test("bounds incoming request bytes", async () => {
    const response = await fetch(`${origin}/api/jev/workspace`, { method: "POST", headers, body: JSON.stringify({ content: "x".repeat(270000) }) });
    expect(response.status).toBe(413); expect(calls).toHaveLength(0);
  });

  test("uses the authenticated account and passes cancellation to analysis", async () => {
    const response = await fetch(`${origin}/api/jev/workspace`, { method: "POST", headers, body: JSON.stringify({ enabled: true, userId: "attacker" }) });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1); expect(calls[0].userId).toBe("owner");
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});
