import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { createApiHandler } from "../server/routes/api.mjs";
import { createSemanticService } from "../server/semantic/index.mjs";

describe("Jev search API", () => {
  let server: ReturnType<typeof createServer>, origin: string;
  const calls: any[] = [];
  const headers = { "Content-Type": "application/json", "X-Test-Signed-In": "1", "X-Margin-Vault-User": "owner" };
  const payload = { enabled: true, query: "reading", items: [{ id: "passage", sourceKind: "message", role: "user", title: "Reading", content: "A reading decision" }], facets: [] };
  beforeAll(async () => {
    const semanticService = createSemanticService({ env: { TYPESAFE_API_KEY: "fixture-key" }, onUsage: () => {}, fetchImpl: async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      return Response.json({ answers: { passage_0: { type: "score", score: 2.7, confidence: 0.9 } } });
    } });
    server = createServer(createApiHandler({ runtimeConfig: { host: "127.0.0.1", port: 0 }, semanticService,
      authService: { getAuthContext: async (request: any) => ({ user: request.headers["x-test-signed-in"] ? { id: "owner" } : null }) } }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });

  test("rejects unauthenticated, stale-account, cross-site and non-JSON requests before inference", async () => {
    const body = JSON.stringify(payload);
    expect((await fetch(`${origin}/api/jev/search`, { method: "POST", body })).status).toBe(401);
    for (const [overrides, status] of [[{ "X-Margin-Vault-User": "other" }, 409], [{ "Sec-Fetch-Site": "cross-site" }, 403], [{ "Content-Type": "text/plain" }, 403]] as const) {
      expect((await fetch(`${origin}/api/jev/search`, { method: "POST", headers: { ...headers, ...overrides }, body })).status).toBe(status);
    }
    expect(calls).toHaveLength(0);
  });

  test("validates consent and size before inference; authenticated search is private and bounded", async () => {
    expect((await fetch(`${origin}/api/jev/search`, { method: "POST", headers, body: JSON.stringify({ ...payload, enabled: false }) })).status).toBe(400);
    expect((await fetch(`${origin}/api/jev/search`, { method: "POST", headers, body: JSON.stringify({ content: "x".repeat(270000) }) })).status).toBe(413);
    expect(calls).toHaveLength(0);
    const response = await fetch(`${origin}/api/jev/search`, { method: "POST", headers, body: JSON.stringify(payload) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ available: true, scores: [{ id: "passage", score: 0.9, confidence: 0.9 }], suggestedFacetIds: [] });
    expect(calls).toHaveLength(1);
  });
});
