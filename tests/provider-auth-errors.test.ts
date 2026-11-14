import { afterEach, describe, expect, test } from "bun:test";
import { providerHttpError, requestProviderJson, requestResponsesApiStream } from "../server/chat/providers.mjs";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function refuse(status: number) {
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: "Invalid API key" } }), {
    status, headers: { "Content-Type": "application/json" },
  })) as unknown as typeof fetch;
}

// The browser signs the user out on a 401, so a provider refusing its own key must never reach it as one.
describe("AI provider key refusals", () => {
  test("a provider's 401 goes back as 502 and names the key", () => {
    const error = providerHttpError(401, "Invalid API key", "openai");
    expect(error.statusCode).toBe(502);
    expect(error.message).toContain("openai refused its API key");
    expect(providerHttpError(429, "Slow down", "openai").statusCode).toBe(429);
  });

  test("Responses API stream (agent mode) refusing its key is not a 401", async () => {
    refuse(401);
    const failure = await requestResponsesApiStream({ apiKey: "bad", body: { model: "m", input: "hi" }, fallbackError: "failed", url: "https://api.openai.com/v1/responses" }).catch((error) => error);
    expect(failure.statusCode).toBe(502);
    expect(failure.message).toContain("Invalid API key");
  });

  test("JSON provider request refusing its key is not a 401", async () => {
    refuse(401);
    const failure = await requestProviderJson({ apiKey: "bad", body: { model: "m" }, provider: "xai", url: "https://api.x.ai/v1/chat" }).catch((error) => error);
    expect(failure.statusCode).toBe(502);
  });
});
