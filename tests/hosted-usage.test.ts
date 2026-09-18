import { afterEach, describe, expect, test } from "bun:test";
import { calculateUsageMicros, createHostedUsageMeter, getHostedModelPrice, normalizeProviderUsage } from "../server/billing/usage.mjs";
import * as providers from "../server/chat/providers.mjs";
import { requestOpenAIAgentResponse, requestOpenAIAgentResponseStream } from "../server/chat/openaiAgent.mjs";
import { createChatService } from "../server/chat/index.mjs";
import { createChatExecutionService } from "../server/chat/execution.mjs";
import { createEmbeddings } from "../server/documents/embeddings.mjs";
import { createDocumentService } from "../server/documents/index.mjs";
import { getDefaultModelIdForService } from "../server/lib/backendModels.mjs";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

// Deliberately fictional rates: one micro per input token, two per output,
// and a quarter micro per cached token. These are not provider price quotes.
const price = { inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 2_000_000, cachedInputMicrosPerMillionTokens: 250_000 };
const prices = Object.fromEntries(["openai", "xai", "gemini", "huggingface"].map((provider) => [`${provider}:test`, { ...price, ...(provider === "gemini" ? { maxReasoningTokens: 64 } : {}) }]));
const env = { HOSTED_MODEL_PRICES_JSON: JSON.stringify({ ...prices, "openai:text-embedding-3-small": { ...price, outputMicrosPerMillionTokens: 0 }, "openai:gpt-5.6": price, "gemini:gemini-3.1-pro-preview": { ...price, maxReasoningTokens: 64 } }) };
function fixture(extra: any = {}) {
  const reservations: any[] = [];
  const settlements: any[] = [];
  const billingService = {
    getHostedUsageLimits: () => ({ maxOutputTokens: 512, maxInputCharacters: 40_000 }),
    reserveHostedRequest: async (args: any) => { reservations.push(args); return { amountMicros: args.amountMicros }; },
    settleHostedRequest: async (args: any) => { settlements.push(args); },
    ...extra,
  };
  const meter = createHostedUsageMeter({ env, billingService, requestId: "execution", userId: "member" });
  return { meter, billingService, reservations, settlements };
}
const chatRequest = { conversation: { id: "conversation", title: "Test", documents: [], ancestorContext: [] }, messages: [{ role: "user", content: "Hello 🌎" }], ai: {} };
function args(meter: any) {
  return { apiKey: "test-key", model: "test", systemInstruction: "Answer briefly.", maxOutputTokens: 100, usageMeter: meter, chatRequest, userId: "member", database: {} };
}
const usage = { input_tokens: 120, input_tokens_details: { cached_tokens: 20 }, output_tokens: 10, output_tokens_details: { reasoning_tokens: 3 }, total_tokens: 130 };
const hfUsage = { prompt_tokens: 120, prompt_tokens_details: { cached_tokens: 20 }, completion_tokens: 10, total_tokens: 130 };
const geminiUsage = { promptTokenCount: 120, cachedContentTokenCount: 20, candidatesTokenCount: 7, thoughtsTokenCount: 3, totalTokenCount: 130 };
function sse(events: any[]) {
  return new Response(events.map((event) => `data: ${event === "[DONE]" ? event : JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}

describe("prepaid usage accounting", () => {
  test("prices exact models and rejects incomplete or invalid pricing", () => {
    expect(getHostedModelPrice(env, "openai", "test")).toEqual(price);
    for (const value of ["{", "{}", JSON.stringify({ "openai:test": { ...price, inputMicrosPerMillionTokens: -1 } }), JSON.stringify({ "openai:test": { ...price, cachedInputMicrosPerMillionTokens: 2_000_000 } })]) {
      expect(() => getHostedModelPrice({ HOSTED_MODEL_PRICES_JSON: value }, "openai", "test")).toThrow();
    }
    expect(() => getHostedModelPrice({ HOSTED_MODEL_PRICES_JSON: JSON.stringify({ "gemini:test": price }) }, "gemini", "test")).toThrow();
    expect(calculateUsageMicros({ inputTokens: 1, outputTokens: 0, cachedInputTokens: 1 }, price)).toBe(1);
  });

  test("normalizes cached and reasoning tokens without counting Responses reasoning twice", () => {
    for (const provider of ["openai", "xai"]) expect(normalizeProviderUsage(provider, { usage })).toEqual({ inputTokens: 120, outputTokens: 10, cachedInputTokens: 20, cacheWriteInputTokens: 0, reasoningTokens: 3 });
    expect(normalizeProviderUsage("gemini", { usageMetadata: geminiUsage })).toEqual({ inputTokens: 120, outputTokens: 10, cachedInputTokens: 20, cacheWriteInputTokens: 0, reasoningTokens: 3 });
    expect(normalizeProviderUsage("huggingface", { usage: hfUsage })?.outputTokens).toBe(10);
    expect(normalizeProviderUsage("openai", { usage: { prompt_tokens: 120, total_tokens: 120 } }, "embedding")?.outputTokens).toBe(0);
    expect(normalizeProviderUsage("openai", { usage: { ...usage, input_tokens: -1 } })).toBeNull();
    expect(normalizeProviderUsage("openai", { usage: { ...usage, input_tokens_details: { cached_tokens: 121 } } })).toBeNull();
    expect(calculateUsageMicros(normalizeProviderUsage("openai", { usage }), price)).toBe(125);
  });

  test("cache writes replace ordinary input and reserve at the highest applicable input rate", async () => {
    const f = fixture();
    const writePrice = { ...price, cacheWriteInputMicrosPerMillionTokens: 1_250_000 };
    const meter = createHostedUsageMeter({ env: { HOSTED_MODEL_PRICES_JSON: JSON.stringify({ "openai:test": writePrice }) }, billingService: f.billingService, requestId: "writes", userId: "member" });
    const writtenUsage = { ...usage, input_tokens_details: { cached_tokens: 20, cache_write_tokens: 40 } };
    globalThis.fetch = (async () => Response.json({ output_text: "Hello", usage: writtenUsage })) as typeof fetch;
    await providers.requestOpenAIResponse(args(meter));
    // Ordinary 60 + cached 5 + written 50 + output 20; no double charge.
    expect(f.settlements[0]).toMatchObject({ amountMicros: 135, metadata: { cachedInputTokens: 20, cacheWriteInputTokens: 40 } });
    const inputBound = f.reservations[0].metadata.inputTokenLimit;
    expect(f.reservations[0].amountMicros).toBe(Math.ceil(inputBound * 1.25 + 100 * 2));
    expect(normalizeProviderUsage("openai", { usage: { ...usage, input_tokens_details: { cached_tokens: 100, cache_write_tokens: 30 } } })).toBeNull();
    expect(() => getHostedModelPrice({ HOSTED_MODEL_PRICES_JSON: JSON.stringify({ "openai:test": { ...price, cacheWriteInputMicrosPerMillionTokens: -1 } }) }, "openai", "test")).toThrow();
  });

  test("observed cache writes without configured pricing stop execution with a capped estimate", async () => {
    const f = fixture();
    globalThis.fetch = (async () => Response.json({ output_text: "Hello", usage: { ...usage, input_tokens_details: { cache_write_tokens: 120 } } })) as typeof fetch;
    await expect(providers.requestOpenAIResponse(args(f.meter))).rejects.toMatchObject({ billingFailure: true });
    expect(f.settlements).toHaveLength(1);
    expect(f.settlements[0]).toMatchObject({ amountMicros: f.reservations[0].amountMicros, metadata: { usageSource: "estimated-upper-bound", unpricedCacheWriteTokens: 120 } });
  });

  for (const [provider, regular, streaming] of [
    ["openai", providers.requestOpenAIResponse, providers.requestOpenAIResponseStream],
    ["xai", providers.requestXAIResponse, providers.requestXAIResponseStream],
    ["gemini", providers.requestGeminiResponse, providers.requestGeminiResponseStream],
    ["huggingface", providers.requestHuggingFaceResponse, providers.requestHuggingFaceResponseStream],
  ] as const) {
    for (const stream of [false, true]) test(`${provider} ${stream ? "stream" : "JSON"} settles provider usage and releases its unused reservation`, async () => {
      const f = fixture();
      let body: any;
      globalThis.fetch = (async (_input, init) => {
        body = JSON.parse(String(init?.body));
        if (provider === "gemini") {
          const payload = { candidates: [{ content: { parts: [{ text: "hidden", thought: true }, { text: "Hello" }] }, finishReason: "STOP" }], usageMetadata: geminiUsage };
          return stream ? sse([payload]) : Response.json(payload);
        }
        if (provider === "huggingface") return stream
          ? sse([{ choices: [{ delta: { content: "Hello" } }] }, { choices: [], usage: hfUsage }, "[DONE]"])
          : Response.json({ choices: [{ message: { content: "Hello" } }], usage: hfUsage });
        return stream ? sse([{ type: "response.output_text.delta", delta: "Hello" }, { type: "response.completed", response: { usage } }]) : Response.json({ output_text: "Hello", usage });
      }) as typeof fetch;
      expect((await (stream ? streaming : regular)(args(f.meter))).reply).toBe("Hello");
      expect(f.reservations).toHaveLength(1);
      expect(f.settlements).toHaveLength(1);
      expect(f.reservations[0].amountMicros).toBeGreaterThan(125);
      expect(f.settlements[0]).toMatchObject({ requestId: "execution:1", amountMicros: 125, metadata: { usageSource: "provider", provider, inputTokens: 120, outputTokens: 10 } });
      expect(f.meter.summary()).toMatchObject({ amountMicros: 125, estimated: false });
      if (provider === "huggingface" && stream) expect(body.stream_options).toEqual({ include_usage: true });
      expect(body.max_output_tokens ?? body.max_tokens ?? body.generationConfig.maxOutputTokens).toBe(100);
    });
  }

  test("unpriced hosted models fail before dispatch; personal calls bypass price configuration", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return Response.json({ output_text: "Hello", usage }); }) as typeof fetch;
    const f = fixture();
    await expect(providers.requestOpenAIResponse({ ...args(f.meter), model: "unpriced" })).rejects.toThrow("pricing is unavailable");
    expect(calls).toBe(0);
    expect(f.reservations).toHaveLength(0);
    await providers.requestOpenAIResponse({ ...args(null), model: "unpriced" });
    expect(calls).toBe(1);
  });

  test("provider HTTP rejection releases the hold while missing usage is explicitly estimated", async () => {
    const f = fixture();
    globalThis.fetch = (async () => Response.json({ error: { message: "Rejected" } }, { status: 429 })) as typeof fetch;
    await expect(providers.requestOpenAIResponse(args(f.meter))).rejects.toThrow("Rejected");
    expect(f.settlements[0]).toMatchObject({ amountMicros: 0, metadata: { usageSource: "not-billed" } });
    globalThis.fetch = (async () => Response.json({ output_text: "Hello" })) as typeof fetch;
    await providers.requestOpenAIResponse(args(f.meter));
    expect(f.settlements[1]).toMatchObject({ amountMicros: f.reservations[1].amountMicros, metadata: { usageSource: "estimated-upper-bound" } });
    expect(f.meter.summary().estimated).toBe(true);
  });

  test("a failed stream cannot use intermediate Gemini usage to release generated but unreported output", async () => {
    const f = fixture();
    globalThis.fetch = (async () => sse([{ candidates: [{ content: { parts: [{ text: "Hello" }] } }], usageMetadata: geminiUsage }, { error: { message: "interrupted" } }])) as typeof fetch;
    await expect(providers.requestGeminiResponseStream(args(f.meter))).rejects.toThrow("interrupted");
    expect(f.settlements[0]).toMatchObject({ amountMicros: f.reservations[0].amountMicros, metadata: { usageSource: "estimated-upper-bound", outcome: "failed" } });
  });

  test("an interrupted Responses stream settles once and never fabricates successful completion", async () => {
    const f = fixture();
    globalThis.fetch = (async () => sse([{ type: "response.output_text.delta", delta: "partial" }])) as typeof fetch;
    await expect(providers.requestOpenAIResponseStream(args(f.meter))).rejects.toThrow("before completion");
    expect(f.settlements).toHaveLength(1);
    expect(f.settlements[0].metadata.usageSource).toBe("estimated-upper-bound");
  });

  test("cancelling a live provider stream cancels its reader and settles the held reservation", async () => {
    const f = fixture();
    const controller = new AbortController();
    let cancelled = false;
    globalThis.fetch = (async (_input, init) => {
      expect(init?.signal).toBe(controller.signal);
      return new Response(new ReadableStream({
        start(stream) { stream.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"partial"}\n\n')); },
        cancel() { cancelled = true; },
      }));
    }) as typeof fetch;
    await expect(providers.requestOpenAIResponseStream({ ...args(f.meter), signal: controller.signal, onDelta: () => { controller.abort(); } })).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(true);
    expect(f.settlements).toHaveLength(1);
    expect(f.settlements[0]).toMatchObject({ amountMicros: f.reservations[0].amountMicros, metadata: { usageSource: "estimated-upper-bound", outcome: "failed" } });
  });

  test("the input bound includes UTF-8 content and the complete serialized tool schema", async () => {
    const f = fixture();
    const body = { model: "test", input: "🌍".repeat(200), tools: [{ type: "function", description: "schema".repeat(1000) }] };
    const tracker = await f.meter.begin({ provider: "openai", model: "test", body, maxOutputTokens: 100 });
    expect(f.reservations[0].metadata.inputTokenLimit).toBe(Buffer.byteLength(JSON.stringify(body), "utf8") + 1024);
    await tracker.finish();
    expect(f.settlements[0].amountMicros).toBe(0);
  });

  test("reported usage above the prepaid bound cannot overdraw or silently succeed", async () => {
    const f = fixture();
    globalThis.fetch = (async () => Response.json({ output_text: "Hello", usage: { input_tokens: 10_000, output_tokens: 200 } })) as typeof fetch;
    await expect(providers.requestOpenAIResponse(args(f.meter))).rejects.toMatchObject({ billingFailure: true });
    expect(f.settlements).toHaveLength(1);
    expect(f.settlements[0].amountMicros).toBe(f.reservations[0].amountMicros);
    expect(f.settlements[0].metadata.exceededReservation).toBe(true);
  });

  test("settlement retries reuse the identical amount and metadata after ambiguous commit", async () => {
    const attempts: any[] = [];
    const f = fixture({ settleHostedRequest: async (value: any) => { attempts.push(value); if (attempts.length < 3) throw new Error("lost connection after commit"); } });
    globalThis.fetch = (async () => Response.json({ output_text: "Hello", usage })) as typeof fetch;
    await providers.requestOpenAIResponse(args(f.meter));
    expect(attempts).toHaveLength(3);
    expect(attempts[0]).toEqual(attempts[1]);
    expect(attempts[1]).toEqual(attempts[2]);
    expect(f.meter.summary().operations).toHaveLength(1);
  });

  test("persistent settlement errors retain the hold and allow later idempotent recovery", async () => {
    let fail = true;
    let attempts = 0;
    const f = fixture({ settleHostedRequest: async () => { attempts += 1; if (fail) throw new Error("database down"); } });
    const tracker = await f.meter.begin({ provider: "openai", model: "test", body: {}, maxOutputTokens: 100 });
    tracker.markDispatched();
    tracker.recordUsage({ usage });
    await expect(tracker.finish()).rejects.toMatchObject({ billingFailure: true });
    expect(attempts).toBe(3);
    expect(f.meter.summary().operations).toHaveLength(0);
    fail = false;
    await tracker.finish(new Error("a later caller does not change the measured cost"));
    await tracker.finish();
    expect(attempts).toBe(4);
    expect(f.meter.summary()).toMatchObject({ amountMicros: 125, operations: [{ outcome: "completed" }] });
  });

  test("a concurrent request cannot start a provider until its own hold succeeds", async () => {
    let available = 2000;
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const f = fixture({
      reserveHostedRequest: async ({ amountMicros }: any) => { if (available < amountMicros) throw Object.assign(new Error("Insufficient prepaid balance"), { statusCode: 402 }); available -= amountMicros; },
      settleHostedRequest: async ({ metadata, amountMicros }: any) => { available += metadata.reservedMicros - amountMicros; },
    });
    globalThis.fetch = (async () => { calls += 1; await gate; return Response.json({ output_text: "Hello", usage }); }) as typeof fetch;
    const pending = providers.requestOpenAIResponse(args(f.meter));
    await expect(providers.requestOpenAIResponse(args(f.meter))).rejects.toMatchObject({ statusCode: 402 });
    expect(calls).toBe(1);
    release();
    await pending;
    expect(available).toBe(1875);
  });
});

describe("all model work uses the same prepaid meter", () => {
  for (const settlementFails of [false, true]) test(settlementFails ? "a settlement failure prevents automatic fallback" : "automatic fallback settles the rejected attempt before paying the next provider", async () => {
    const f = fixture(settlementFails ? { settleHostedRequest: async () => { throw new Error("database unavailable"); } } : {});
    let calls = 0;
    const service = createChatService({ database: {}, env: { ...env, OPENAI_API_KEY: "hosted", GEMINI_API_KEY: "hosted" }, runtimeConfig: { defaultBackendProvider: "openai-api", openaiModel: "gpt-5.6", geminiModel: "gemini-3.1-pro-preview" } });
    const execute = createChatExecutionService({ apiKeyService: { getDecryptedKeys: async () => ({}) }, chatService: service, billingService: f.billingService });
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) return Response.json({ error: { message: "Rejected" } }, { status: 429 });
      expect(f.settlements).toHaveLength(1);
      return sse([{ candidates: [{ content: { parts: [{ text: "Hello" }] }, finishReason: "STOP" }], usageMetadata: geminiUsage }]);
    }) as typeof fetch;
    const request = { payload: { ...chatRequest, serviceId: "backend-services", modelId: getDefaultModelIdForService("backend-services") }, user: { id: "member", role: "member", billing: { hasAccess: true, accessKind: "credits" } } };
    if (settlementFails) {
      await expect(execute(request)).rejects.toMatchObject({ billingFailure: true });
      expect(calls).toBe(1);
    } else {
      expect((await execute(request)).reply).toBe("Hello");
      expect(f.settlements.map((item) => item.amountMicros)).toEqual([0, 125]);
      expect(f.reservations).toHaveLength(2);
    }
  });

  for (const stream of [false, true]) test(`agent ${stream ? "stream" : "JSON"} charges each tool round separately`, async () => {
    const f = fixture();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      const payload = calls === 1
        ? { output: [{ type: "function_call", name: "list_recent_conversations", call_id: "tool-1", arguments: "{}" }], usage }
        : { output_text: "Hello", output: [], usage };
      return stream ? sse([...(calls === 2 ? [{ type: "response.output_text.delta", delta: "Hello" }] : []), { type: "response.completed", response: payload }]) : Response.json(payload);
    }) as typeof fetch;
    expect((await (stream ? requestOpenAIAgentResponseStream : requestOpenAIAgentResponse)(args(f.meter))).reply).toBe("Hello");
    expect(calls).toBe(2);
    expect(f.settlements.map((item) => item.amountMicros)).toEqual([125, 125]);
    expect(f.reservations.map((item) => item.requestId)).toEqual(["execution:1", "execution:2"]);
    expect(f.reservations[1].metadata.inputTokenLimit).toBeGreaterThan(f.reservations[0].metadata.inputTokenLimit);
  });

  test("embedding batches settle separately using input usage only", async () => {
    const f = fixture();
    globalThis.fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      return Response.json({ data: body.input.map((_: string, index: number) => ({ index, embedding: Array(1536).fill(0.1) })), usage: { prompt_tokens: 120, total_tokens: 120 } });
    }) as typeof fetch;
    expect(await createEmbeddings({ apiKey: "hosted", inputs: Array(65).fill("Document chunk"), usageMeter: f.meter })).toHaveLength(65);
    expect(f.settlements.map((item) => item.amountMicros)).toEqual([120, 120]);
    expect(f.settlements.every((item) => item.metadata.kind === "embedding" && item.metadata.outputTokens === 0)).toBe(true);
  });

  test("upload indexing and retrieval embeddings are billed, including a personal chat using hosted embeddings", async () => {
    const f = fixture();
    const database = { createDocument: async () => ({ id: "document" }), completeDocument: async () => ({ id: "document", status: "ready" }), findRelevantDocumentChunks: async () => [], deleteDocument: async () => true };
    const service = createDocumentService({ database, env: { OPENAI_API_KEY: "hosted" } });
    globalThis.fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      return Response.json({ data: body.input.map((_: string, index: number) => ({ index, embedding: Array(1536).fill(0.1) })), usage: { prompt_tokens: 120, total_tokens: 120 } });
    }) as typeof fetch;
    const context = { allowHosted: true, apiKeys: { gemini: "personal" }, userId: "member", usageMeter: f.meter };
    await service.upload({ context, file: new File(["Refunds within 30 days."], "policy.txt", { type: "text/plain" }), userId: "member" });
    const request = { ...chatRequest, conversation: { ...chatRequest.conversation, documents: [{ id: "document" }] } };
    await service.retrieveContext({ chatRequest: request, context });
    expect(f.settlements).toHaveLength(2);
    await service.retrieveContext({ chatRequest: request, context: { ...context, apiKeys: { openai: "personal" } } });
    expect(f.settlements).toHaveLength(2);
  });

  test("subscribed members pay for titles; administrators and personal keys bypass the hosted wallet", async () => {
    const f = fixture();
    let keys = {};
    let body: any;
    const service = createChatService({ database: {}, env: { ...env, OPENAI_API_KEY: "hosted" }, runtimeConfig: { defaultBackendProvider: "openai-api", openaiModel: "gpt-5.6" } });
    const execute = createChatExecutionService({ apiKeyService: { getDecryptedKeys: async () => keys }, chatService: service, billingService: f.billingService });
    globalThis.fetch = (async (_input, init) => { body = JSON.parse(String(init?.body)); return Response.json({ output_text: "Refund Policy", usage }); }) as typeof fetch;
    const user = { id: "member", role: "member", billing: { accessKind: "subscription", hasAccess: true } };
    const payload = { modelId: "gpt-5.6", serviceId: "openai-api", prompt: "When can I get a refund?" };
    expect((await execute({ payload, user, operation: "title" })).title).toBe("Refund Policy");
    expect(body.max_output_tokens).toBe(256);
    expect(f.settlements[0]).toMatchObject({ amountMicros: 125, metadata: { operation: "title" } });
    await execute({ payload, user: { ...user, role: "admin" }, operation: "title" });
    keys = { openai: "personal" };
    await execute({ payload, user, operation: "title" });
    expect(f.settlements).toHaveLength(1);
  });
});
