import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { createApiHandler } from "../server/routes/api.mjs";
import { API_DEPLOYMENT_PATH, API_DEPLOYMENT_QUERY, createDeploymentHandler } from "../server/routes/deployment.mjs";
import { API_ROUTES, matchApiRoute } from "../server/routes/registry.mjs";

function response() {
  return Object.assign(new EventEmitter(), {
    status: 0, headers: {} as Record<string, string>, body: undefined as any,
    headersSent: false, writableEnded: false,
    setHeader(name: string, value: string) { this.headers[name] = value; },
    writeHead(status: number, headers: Record<string, string>) { this.status = status; Object.assign(this.headers, headers); this.headersSent = true; },
    end(body: unknown) { this.body = body; this.writableEnded = true; },
  });
}

describe("shared API deployment", () => {
  test("one catch-all adapter covers every registered route while preserving the original request", async () => {
    const apiFiles = readdirSync(new URL("../api", import.meta.url), { recursive: true }).filter((name) => String(name).endsWith(".mjs"));
    expect(apiFiles).toEqual(["handler.mjs"]);
    const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
    expect(config.functions["api/*.mjs"].maxDuration).toBe(60);
    expect(new Bun.Glob(config.functions["api/*.mjs"].includeFiles).match("server/db/schema.sql")).toBe(true);
    expect(new Bun.Glob(config.functions["api/*.mjs"].includeFiles).match("server/db/migrations/manifest.json")).toBe(true);
    expect(new Bun.Glob(config.functions["api/*.mjs"].includeFiles).match("server/db/migrations/0001_baseline.sql")).toBe(true);
    expect(config.rewrites[0]).toEqual({ source: `/api/:${API_DEPLOYMENT_QUERY}*`, destination: `${API_DEPLOYMENT_PATH}?${API_DEPLOYMENT_QUERY}=:${API_DEPLOYMENT_QUERY}` });
    for (const route of API_ROUTES) {
      const pathname = route.path.replace(":id", "11111111-1111-4111-8111-111111111111");
      expect(pathname.startsWith("/api/")).toBe(true);
      for (const method of route.methods) {
        const request = { method, url: `${pathname}?revision=original` };
        const res = {};
        const handler = createDeploymentHandler(() => (incoming: any, outgoing: any) => {
          expect(incoming).toBe(request);
          expect(outgoing).toBe(res);
          return matchApiRoute(incoming.method, new URL(incoming.url, "http://localhost").pathname)?.id;
        });
        expect(await handler(request, res)).toBe(route.id);
        const rewritten = { method, url: `${API_DEPLOYMENT_PATH}?${API_DEPLOYMENT_QUERY}=${encodeURIComponent(pathname.slice(5))}&revision=original` };
        const rewrittenHandler = createDeploymentHandler(() => (incoming: any) => {
          expect(incoming.url).toBe(`${pathname}?revision=original`);
          return matchApiRoute(incoming.method, new URL(incoming.url, "http://localhost").pathname)?.id;
        });
        expect(await rewrittenHandler(rewritten, res)).toBe(route.id);
      }
    }
  });

  test("nested title, reset, and original-download routes reach the same API implementation", async () => {
    const calls: string[] = [];
    const user = { id: "owner", billing: { hasAccess: true, accessKind: "subscription" } };
    const handler = createDeploymentHandler(() => createApiHandler({
      runtimeConfig: { host: "localhost", port: 8787 },
      authService: {
        getAuthContext: async () => ({ user }),
        requestPasswordReset: async (body: any) => { calls.push(body.email); return { ok: true }; },
        resetPassword: async (body: any) => { calls.push(body.token); return { ok: true }; },
        buildClearedSessionCookie: () => "session=; Max-Age=0",
      },
      apiKeyService: { getDecryptedKeys: async () => ({}) },
      billingService: { getHostedUsageLimits: () => ({ maxOutputTokens: 100 }) },
      chatService: { createUsageMeter: () => ({}), getPlannedTitleCredentialSource: () => "hosted", generateTitle: async (body: any) => { calls.push(body.prompt); return { title: "A title" }; } },
      vaultService: {
        configured: true,
        readAttachment: async ({ documentId }: any) => {
          calls.push(documentId);
          return { id: documentId, mimeType: "text/plain", bytes: Buffer.from("original bytes") };
        },
      },
    }));
    const cases = [
      { path: "/api/auth/password-reset/request", body: { email: "owner@example.test" }, result: { ok: true } },
      { path: "/api/auth/password-reset/confirm", body: { token: "reset-token" }, result: { ok: true } },
      { path: "/api/chat/title", body: { prompt: "title prompt" }, result: { title: "A title" } },
    ];
    for (const item of cases) {
      const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(item.body))]), {
        url: item.path, method: "POST", headers: { host: "localhost", "content-type": "application/json" },
      });
      const res = response();
      await handler(req, res);
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual(item.result);
    }
    const res = response();
    await handler({ method: "GET", url: "/api/documents/document%20one/original", headers: { host: "localhost" } }, res);
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe("original bytes");
    expect(calls).toEqual(["owner@example.test", "reset-token", "title prompt", "document one"]);
  });
});
