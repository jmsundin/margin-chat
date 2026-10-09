import { afterEach, describe, expect, test } from "bun:test";
import prices from "../docs/config/hosted-prices-2026-10-09.json";
import { BACKEND_SERVICE_OPTIONS } from "../client/src/lib/services";
import { requestAnthropicResponse, requestAnthropicResponseStream } from "../server/chat/providers.mjs";
import { calculateUsageMicros, getHostedModelPrice, normalizeProviderUsage } from "../server/billing/usage.mjs";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function sse(events: any[]) {
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "Content-Type": "text/event-stream" },
  });
}

function claudeStream({ text = ["Hello", " there"], stopReason = "end_turn", stopDetails = null as any, model = "claude-opus-5-5" } = {}) {
  return [
    { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model, content: [], stop_reason: null,
      usage: { input_tokens: 40, output_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    ...text.map((chunk) => ({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: chunk } })),
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: stopReason, stop_details: stopDetails }, usage: { output_tokens: 25 } },
    { type: "message_stop" },
  ];
}

function args(overrides: Record<string, unknown> = {}) {
  return {
    apiKey: "sk-ant-test",
    model: "claude-opus-5-5",
    systemInstruction: "Be helpful.",
    chatRequest: { ai: { mode: "balanced" }, messages: [
      { role: "system", content: "ignored" },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
      { role: "user", content: "How are you?" },
    ] },
    usageMeter: null,
    ...overrides,
  };
}

function captureFetch(response: () => Response) {
  const calls: { url: string; headers: Headers; body: any }[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(init.body) });
    return response();
  }) as typeof fetch;
  return calls;
}

describe("Anthropic Claude provider", () => {
  test("streams text, requests effort and the default refusal fallback, and reports usage", async () => {
    const calls = captureFetch(() => sse(claudeStream()));
    const deltas: string[] = [];
    let ready = 0;
    const result = await requestAnthropicResponseStream(args({ onReady: () => { ready++; }, onDelta: (delta: string) => { deltas.push(delta); } }));
    expect(result).toEqual({ model: "claude-opus-5-5", reply: "Hello there",
      usage: { inputTokens: 50, outputTokens: 25, cachedInputTokens: 10, cacheWriteInputTokens: 0, reasoningTokens: 0 } });
    expect(deltas).toEqual(["Hello", " there"]);
    expect(ready).toBe(1);
    expect(calls[0].url).toContain("api.anthropic.com/v1/messages");
    expect(calls[0].headers.get("x-api-key")).toBe("sk-ant-test");
    expect(calls[0].headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(calls[0].body).toMatchObject({
      model: "claude-opus-5-5", max_tokens: 32000, system: "Be helpful.", stream: true, fallbacks: "default",
      output_config: { effort: "medium" },
      messages: [{ role: "user", content: "Hi" }, { role: "assistant", content: "Hello" }, { role: "user", content: "How are you?" }],
    });
    expect(calls[0].body.thinking).toBeUndefined();
  });

  test("Haiku skips the fallback beta, and short or fast requests use low effort", async () => {
    const calls = captureFetch(() => sse(claudeStream({ model: "claude-haiku-5-5" })));
    const result = await requestAnthropicResponse(args({ model: "claude-haiku-5-5", maxOutputTokens: 256 }));
    expect(result.reply).toBe("Hello there");
    expect(calls[0].body).toMatchObject({ max_tokens: 256, output_config: { effort: "low" } });
    expect(calls[0].body.fallbacks).toBeUndefined();
    expect(calls[0].headers.get("anthropic-beta")).toBeNull();
    await requestAnthropicResponse(args({ chatRequest: { ai: { mode: "thorough" }, messages: [{ role: "user", content: "Go" }] } }));
    expect(calls[1].body.output_config).toEqual({ effort: "high" });
  });

  test("a declined request becomes a clear error instead of an empty reply", async () => {
    captureFetch(() => sse(claudeStream({ text: [], stopReason: "refusal", stopDetails: { type: "refusal", category: "cyber" } })));
    await expect(requestAnthropicResponse(args())).rejects.toMatchObject({ statusCode: 422, message: expect.stringContaining("Claude declined") });
  });

  test("provider HTTP errors keep their status and message", async () => {
    captureFetch(() => Response.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: 401 }));
    await expect(requestAnthropicResponse(args())).rejects.toMatchObject({ statusCode: 401, message: "invalid x-api-key" });
  });

  test("usage adds cache tokens to input and sums refusal-fallback attempts", () => {
    expect(normalizeProviderUsage("anthropic", { usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } }))
      .toEqual({ inputTokens: 10, outputTokens: 7, cachedInputTokens: 3, cacheWriteInputTokens: 2, reasoningTokens: 0 });
    expect(normalizeProviderUsage("anthropic", { usage: { input_tokens: 20, output_tokens: 9, iterations: [
      { type: "message", input_tokens: 20, output_tokens: 4 },
      { type: "fallback_message", input_tokens: 24, output_tokens: 9, cache_read_input_tokens: 0 },
    ] } })).toEqual({ inputTokens: 44, outputTokens: 13, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningTokens: 0 });
  });
});

describe("October 2026 hosted price map", () => {
  const env = { HOSTED_MODEL_PRICES_JSON: JSON.stringify(prices) };
  const priced = { "openai-api": "openai", "anthropic-api": "anthropic", "xai-api": "xai" } as const;

  test("every OpenAI, Claude, and Grok picker model has a valid price", () => {
    for (const [serviceId, provider] of Object.entries(priced)) {
      const service = BACKEND_SERVICE_OPTIONS.find((option) => option.id === serviceId)!;
      for (const model of service.models) expect(() => getHostedModelPrice(env, provider, model.id)).not.toThrow();
    }
    expect(() => getHostedModelPrice(env, "openai", "text-embedding-3-small")).not.toThrow();
  });

  test("Claude Opus 5.5 prices match Anthropic's published rates", () => {
    const price = getHostedModelPrice(env, "anthropic", "claude-opus-5-5");
    // 1M uncached input at $4 plus 1M output at $20.
    expect(calculateUsageMicros({ inputTokens: 1_000_000, outputTokens: 1_000_000, cachedInputTokens: 0, cacheWriteInputTokens: 0 }, price)).toBe(24_000_000);
  });
});
