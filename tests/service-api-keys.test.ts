import { describe, expect, test } from "bun:test";
import { createApiKeyService, parseAzureSpeechKey } from "../server/apiKeys/index.mjs";
import { createWebSearchService } from "../server/webSearch/index.mjs";
import { createLanguageSpeechService } from "../server/languageTerms/speech.mjs";

// With their own keys for web search, translation and voices, people have every feature without a plan
// (docs/desktop-local-mode.md).
const env = { API_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") };

function memoryKeys() {
  const rows = new Map<string, any>();
  return {
    async listUserApiKeys(userId: string) { return [...rows.values()].filter((row) => row.userId === userId); },
    async upsertUserApiKey(row: any) { rows.set(`${row.userId}:${row.provider}`, row); },
    async deleteUserApiKey({ userId, provider }: any) { rows.delete(`${userId}:${provider}`); },
  };
}

describe("service keys", () => {
  test("are saved like model keys, but only model keys count as having AI", async () => {
    const service = createApiKeyService({ database: memoryKeys(), env });
    const saved = await service.updateKeys("u1", { keys: { tavily: "tvly-0123456789", azure_speech: "eastus:0123456789abcdef0123" } });
    expect(saved.byProvider.tavily).toEqual({ configured: true, hint: "6789" });
    expect(saved.hasAny).toBe(false);
    expect((await service.getDecryptedKeys("u1")).tavily).toBe("tvly-0123456789");
    expect((await service.updateKeys("u1", { keys: { openai: "sk-0123456789" } })).hasAny).toBe(true);
  });

  test("Azure Speech needs its region with the key", async () => {
    expect(parseAzureSpeechKey("eastus:0123456789abcdef0123")).toEqual({ region: "eastus", key: "0123456789abcdef0123" });
    expect(parseAzureSpeechKey("0123456789abcdef0123")).toBeNull();
    expect(parseAzureSpeechKey("east us:0123456789abcdef0123")).toBeNull();
    const service = createApiKeyService({ database: memoryKeys(), env });
    await expect(service.updateKeys("u1", { keys: { azure_speech: "0123456789abcdef0123" } })).rejects.toThrow("region:key");
  });
});

describe("web search with the person's own Tavily key", () => {
  const billing = { calls: 0, async reserveHostedRequest() { this.calls += 1; }, async settleHostedRequest() { this.calls += 1; } };
  const tavily = (seen: string[]) => (async (_url: string, init: any) => {
    seen.push(init.headers.Authorization);
    return new Response(JSON.stringify({ results: [{ url: "https://example.com/a", title: "A", content: "About A" }] }), { status: 200 });
  }) as unknown as typeof fetch;

  test("works with no plan and no server key, and bills nothing here", async () => {
    const seen: string[] = [];
    const service = createWebSearchService({ env: {}, billingService: billing, fetchImpl: tavily(seen) });
    const user = { id: "u1", role: "member", billing: { hasAccess: false, accessKind: "local" } };
    await expect(service.search({ user, payload: { query: "telomeres" } })).rejects.toThrow("Tavily key");
    const found = await service.search({ user, payload: { query: "telomeres" }, apiKey: "tvly-own" });
    expect(found).toMatchObject({ chargedMicros: 0, results: [{ url: "https://example.com/a" }] });
    expect(seen).toEqual(["Bearer tvly-own"]);
    expect(billing.calls).toBe(0);
  });

  test("a refused key says so", async () => {
    const service = createWebSearchService({ env: {}, billingService: billing, fetchImpl: (async () => new Response("no", { status: 401 })) as unknown as typeof fetch });
    await expect(service.search({ user: { id: "u1", role: "member", billing: { hasAccess: false } }, payload: { query: "telomeres" }, apiKey: "tvly-bad" }))
      .rejects.toThrow("Tavily refused your web search key");
  });
});

describe("read-aloud with the person's own Azure key", () => {
  test("uses their region and key on a server with no voices", async () => {
    const urls: string[] = [];
    const keys: string[] = [];
    const service = createLanguageSpeechService({ env: {}, fetchImpl: (async (url: string, init: any) => {
      urls.push(url); keys.push(init.headers["Ocp-Apim-Subscription-Key"]);
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as unknown as typeof fetch });
    await expect(service.speak({ userId: "u1", text: "Hallo", language: "de" })).rejects.toThrow("aren't set up");
    const { audio } = await service.speak({ userId: "u1", text: "Hallo", language: "de", own: { region: "westeurope", key: "k".repeat(20) } });
    expect(audio.length).toBe(3);
    expect(urls[0]).toStartWith("https://westeurope.tts.speech.microsoft.com/");
    expect(keys[0]).toBe("k".repeat(20));
  });
});
