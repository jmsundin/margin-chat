import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { createApiHandler } from "../server/routes/api.mjs";
import { createUrlMapService } from "../server/urlMap/index.mjs";
import { extractPage } from "../server/urlMap/page.mjs";
import { requestUrlMap } from "../client/src/lib/urlMap";
import { urlMapHtml, urlMapModelReply } from "./helpers/urlMapFixture";

describe("URL map authenticated API", () => {
  let server: ReturnType<typeof createServer>, origin: string;
  let reads = 0, inferences = 0;
  const headers = { "Content-Type": "application/json", "X-Test-Signed-In": "1", "X-Margin-Vault-User": "owner" };
  beforeAll(async () => {
    const urlMapService = createUrlMapService({ readPage: async (url: string) => { reads++; return extractPage(urlMapHtml, url); }, executeChatReply: async () => { inferences++; return { reply: urlMapModelReply }; } });
    server = createServer(createApiHandler({ runtimeConfig: { host: "127.0.0.1", port: 0 }, urlMapService,
      authService: { getAuthContext: async (request: any) => ({ user: request.headers["x-test-signed-in"] ? { id: "owner" } : null }) } }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  test("blocks anonymous, stale-account, cross-site, and oversized requests before reading or inference", async () => {
    const body = JSON.stringify({ url: "https://example.org/trees" });
    expect((await fetch(`${origin}/api/graph/url`, { method: "POST", body })).status).toBe(401);
    for (const [overrides, status] of [[{ "X-Margin-Vault-User": "other" }, 409], [{ "Sec-Fetch-Site": "cross-site" }, 403], [{ "Content-Type": "text/plain" }, 403]] as const) {
      expect((await fetch(`${origin}/api/graph/url`, { method: "POST", headers: { ...headers, ...overrides }, body })).status).toBe(status);
    }
    expect((await fetch(`${origin}/api/graph/url`, { method: "POST", headers, body: JSON.stringify({ url: "x".repeat(9000) }) })).status).toBe(413);
    expect(reads).toBe(0); expect(inferences).toBe(0);
  });
  test("streams real progress and a validated final map through the shared deployment route", async () => {
    const response = await fetch(`${origin}/api/graph/url`, { method: "POST", headers, body: JSON.stringify({ url: "https://example.org/trees" }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("private, no-store");
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(events.map((item) => item.type)).toEqual(["progress", "progress", "progress", "done"]);
    expect(events.at(-1).graph.nodes).toHaveLength(4);
    expect(reads).toBe(1); expect(inferences).toBe(1);
  });
});

describe("URL map response handling", () => {
  test("handles split stream chunks, reports provider errors, and rejects incomplete replies", async () => {
    const original = globalThis.fetch;
    try {
      const service = createUrlMapService({ readPage: async (url: string) => extractPage(urlMapHtml, url), executeChatReply: async () => ({ reply: urlMapModelReply }) });
      const graph = await service({ payload: { url: "https://example.org/trees" }, user: { id: "fixture" } });
      const stream = `${JSON.stringify({ type: "progress", message: "Reading…" })}\n${JSON.stringify({ type: "done", graph })}\n`;
      const bytes = new TextEncoder().encode(stream);
      globalThis.fetch = (async (_url, init) => {
        expect((init?.headers as any)["X-Margin-Vault-User"]).toBe("owner");
        return new Response(new ReadableStream({ start(controller) { for (let index = 0; index < bytes.length; index += 17) controller.enqueue(bytes.slice(index, index + 17)); controller.close(); } }));
      }) as typeof fetch;
      const messages: string[] = [];
      const args = { url: "https://example.org/trees", expectedUserId: "owner", signal: new AbortController().signal, onProgress: (message: string) => messages.push(message) };
      expect((await requestUrlMap(args)).nodes).toHaveLength(4); expect(messages).toEqual(["Reading…"]);
      globalThis.fetch = (async () => new Response('{"type":"error","statusCode":402,"error":"Add an API key or AI balance."}\n')) as typeof fetch;
      await expect(requestUrlMap(args)).rejects.toThrow("API key");
      globalThis.fetch = (async () => new Response('{"type":"progress","message":"Reading"}\n')) as typeof fetch;
      await expect(requestUrlMap(args)).rejects.toThrow("before the map was complete");
    } finally { globalThis.fetch = original; }
  });
});
