import { afterEach, expect, test } from "bun:test";
import { createChatService } from "../server/chat/index.mjs";
import { createHostedUsageMeter } from "../server/billing/usage.mjs";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const payload = (ai = {}) => ({
  conversation: { id: "current", title: "Current", parentId: null, branchAnchor: null, ancestorContext: [], documents: [] },
  messages: [{ id: "q", role: "user", content: "Help me with this." }],
  serviceId: "backend-services", modelId: "smart-routing", ai,
});
function service(extra = {}) {
  return createChatService({ database: {}, runtimeConfig: {}, env: { OPENAI_API_KEY: "hosted", GEMINI_API_KEY: "hosted-gemini" },
    semanticService: { analyzeChat() { throw new Error("Auto must never call Jev"); } }, ...extra });
}
function replies(calls: any[], decision: any = { task: "summary", routeKey: "openai-api:gpt-6-sol", contextOrder: [] }) {
  globalThis.fetch = (async (url, init) => {
    const body = JSON.parse(String(init?.body)); calls.push({ url: String(url), body, headers: init?.headers });
    if (body.text?.format?.name === "auto_route") return Response.json({ output_text: JSON.stringify(decision), usage: { input_tokens: 20, output_tokens: 10 } });
    if (String(url).includes("googleapis")) return Response.json({ candidates: [{ content: { parts: [{ text: "OK" }] } }] });
    return Response.json({ model: body.model, output_text: "OK", usage: { input_tokens: 30, output_tokens: 20 } });
  }) as typeof fetch;
}

test("Auto uses Astra low reasoning without Jev consent and preserves exact manual choices", async () => {
  const calls: any[] = []; replies(calls);
  const chat = service();
  const result = await chat.requestReply(payload({ jevEnabled: false }), { apiKeys: { openai: "personal" } });
  expect(calls[0].body).toMatchObject({ model: "gpt-6-astra", reasoning: { effort: "low" }, store: false });
  expect(calls[0].headers.Authorization).toBe("Bearer personal");
  expect(calls[1].body.model).toBe("gpt-6-sol");
  expect(result.metadata.execution.routing).toEqual({ method: "astra", selectedModel: "gpt-6-sol" });
  const state = JSON.parse(calls[0].body.input);
  expect(state.routes.every((route: any) => route.serviceId === "openai-api")).toBe(true);
  await chat.requestReply({ ...payload(), serviceId: "openai-api", modelId: "gpt-6-luna" });
  expect(calls).toHaveLength(3);
  expect(calls[2].body.model).toBe("gpt-6-luna");
});

test("excluded OpenAI and personal-only non-OpenAI credentials skip Astra without using hosted keys", async () => {
  const calls: any[] = []; replies(calls);
  const chat = service();
  for (const [ai, context] of [
    [{ allowedProviders: ["gemini"] }, {}],
    [{}, { apiKeys: { gemini: "personal-gemini" }, allowHosted: true }],
    [{}, { apiKeys: { gemini: "personal-gemini" }, allowHosted: false }],
  ]) {
    const result = await chat.requestReply(payload(ai), context);
    expect(result.metadata.execution.routing.method).toBe("rules");
    expect(result.metadata.execution.warnings.join(" ")).toContain("Astra");
  }
  expect(calls).toHaveLength(3);
  expect(calls.every((call) => call.url.includes("googleapis"))).toBe(true);
});

test("invalid or unavailable routing falls back without exposing upstream errors", async () => {
  for (const decision of [{ task: "summary", routeKey: "excluded:model" }, null]) {
    const calls: any[] = []; replies(calls, decision);
    const result = await service().requestReply(payload());
    expect(result.metadata.execution.routing.method).toBe("rules");
    expect(calls).toHaveLength(2);
  }
  const calls: any[] = []; replies(calls);
  const result = await service({ autoRouter: async () => { throw new Error("PRIVATE PROVIDER ERROR"); } }).requestReply(payload());
  expect(result.metadata.execution.reason).toContain("Astra");
  expect(JSON.stringify(result)).not.toContain("PRIVATE PROVIDER ERROR");
});

test("hosted routing and generation both reserve and settle through the existing meter", async () => {
  const calls: any[] = []; replies(calls);
  const events: any[] = [];
  const price = { inputMicrosPerMillionTokens: 1000000, outputMicrosPerMillionTokens: 2000000 };
  const env = { OPENAI_API_KEY: "hosted", HOSTED_MODEL_PRICES_JSON: JSON.stringify({ "openai:gpt-6-astra": price, "openai:gpt-6-sol": price }) };
  const usageMeter = createHostedUsageMeter({ env, userId: "u", requestId: "r", billingService: {
    async reserveHostedRequest(value: any) { events.push({ kind: "reserve", value }); },
    async settleHostedRequest(value: any) { events.push({ kind: "settle", value }); },
  } });
  await service({ env }).requestReply(payload(), { usageMeter, hostedMaxOutputTokens: 512 });
  expect(events.map((entry) => entry.kind)).toEqual(["reserve", "settle", "reserve", "settle"]);
  expect(usageMeter.summary().operations.map((entry: any) => entry.kind)).toEqual(["routing", "generation"]);
});

test("cancellation and billing settlement failures stop before generation", async () => {
  const calls: any[] = []; replies(calls);
  const controller = new AbortController();
  await expect(service({ autoRouter: async () => { controller.abort(); throw controller.signal.reason; } })
    .requestReply(payload(), { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  await expect(service({ autoRouter: async () => { throw Object.assign(new Error("settlement"), { billingFailure: true }); } })
    .requestReply(payload())).rejects.toMatchObject({ billingFailure: true });
  await expect(service({ autoRouter: async () => { throw new DOMException("Stopped", "AbortError"); } })
    .requestReply(payload())).rejects.toMatchObject({ name: "AbortError" });
  expect(calls).toHaveLength(0);
});
