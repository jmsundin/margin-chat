import { afterEach, describe, expect, test } from "bun:test";
import { normalizeAIExecution, normalizeAISettings } from "@margin-chat/workspace-contracts";
import prices from "../docs/config/hosted-prices-2026-10-18.json";
import { agentNeedFromPrompt } from "../server/chat/agent/autoAgent.mjs";
import { runAgent } from "../server/chat/agent/runner.mjs";
import { createChatService } from "../server/chat/index.mjs";
import { validateAIOptions } from "../server/chat/validation.mjs";
import { calculateUsageMicros, getHostedModelPrice, normalizeProviderUsage } from "../server/billing/usage.mjs";
import { getDefaultModelIdForService } from "../server/lib/backendModels.mjs";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const META_URL = "https://api.meta.ai/v1/responses";
const toolCall = (name: string, args: Record<string, unknown>, id = "call_1") =>
  ({ output: [{ type: "function_call", name, call_id: id, arguments: JSON.stringify(args) }] });
const answer = (text: string) => ({ output_text: text, output: [] });

function payload(serviceId: string, content: string, ai: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    ai: { mode: "balanced", contextScope: "conversation", selectedConversationIds: [], ...ai },
    conversation: { ancestorContext: [], branchAnchor: null, id: "chat", parentId: null, title: "Chat", documents: [] },
    messages: [{ role: "user", content }],
    modelId: getDefaultModelIdForService(serviceId), serviceId, ...extra,
  };
}

function service(env: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
  return createChatService({ autoRouter: async () => null, database: {}, runtimeConfig: { defaultBackendProvider: "openai-api" },
    env: { OPENAI_API_KEY: "openai-test", GEMINI_API_KEY: "gemini-test", META_API_KEY: "meta-test", ...env }, ...extra });
}

function recordCalls(respond: (url: string, body: any, index: number) => unknown) {
  const calls: Array<{ url: string; body: any; headers: any }> = [];
  globalThis.fetch = (async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body, headers: init.headers });
    const result = respond(String(url), body, calls.length);
    return result instanceof Response ? result : Response.json(result);
  }) as typeof fetch;
  return calls;
}

describe("Meta Muse Wonder", () => {
  test("answers plain chats through Meta's Responses API", async () => {
    const calls = recordCalls(() => ({ model: "muse-wonder-1.0", output_text: "Hello from Muse.", usage: { input_tokens: 10, output_tokens: 4 } }));
    const result = await service().requestReply(payload("meta-api", "Say hello."));
    expect(result.reply).toBe("Hello from Muse.");
    expect(calls[0].url).toBe(META_URL);
    expect(calls[0].headers.Authorization).toBe("Bearer meta-test");
    expect(calls[0].body).toMatchObject({ model: "muse-wonder-1.0", instructions: expect.any(String) });
    expect(calls[0].body.input).toEqual([{ role: "user", content: "Say hello." }]);
  });

  test("agent runs send only settings Meta accepts: tool_choice auto, a reasoning effort, and no tools on the last call", async () => {
    let clock = 0;
    const calls = recordCalls((_url, body) => { clock += 100_000; return body.tools ? toolCall("list_recent_conversations", { limit: 1 }) : answer("Here is what I found."); });
    const result = await runAgent({ provider: "meta", apiKey: "meta", model: "muse-wonder-1.0", systemInstruction: "Help.", maxOutputTokens: 500,
      usageMeter: null, timeLimitMs: 240_000, now: () => clock,
      chatRequest: { ai: { mode: "fast" }, conversation: { id: "chat", ancestorContext: [] }, messages: [{ role: "user", content: "What's recent?" }] } });
    expect(calls.every((call) => call.url === META_URL)).toBe(true);
    expect(calls.slice(0, -1).every((call) => call.body.tool_choice === "auto" && call.body.tools.every((tool: any) => tool.strict))).toBe(true);
    expect(calls.at(-1)!.body).not.toHaveProperty("tools");
    expect(calls.at(-1)!.body).not.toHaveProperty("tool_choice");
    expect(calls.at(-1)!.body.instructions).toContain("time limit");
    expect(calls.every((call) => call.body.reasoning?.effort === "low" && call.body.reasoning?.summary === "detailed")).toBe(true);
    expect(result.agent).toMatchObject({ stopReason: "time-limit" });
  });

  test("Auto runs Agent mode on Muse Wonder and keeps it out of plain replies", async () => {
    const calls = recordCalls((url, body) => url === META_URL && body.tools && !body.input.some((item: any) => item.type === "function_call_output")
      ? toolCall("list_recent_conversations", { limit: 1 }) : answer("Done."));
    const agent = await service().requestReply(payload("backend-services", "Tidy this sentence: hi there", { agent: true }), { userId: "owner" });
    expect(calls[0].url).toBe(META_URL);
    expect(agent.metadata.execution).toMatchObject({ provider: "meta-api", model: "muse-wonder-1.0", routing: { method: "rules", selectedModel: "muse-wonder-1.0" } });
    expect(agent.metadata.execution.reason).toContain("Muse Wonder");
    calls.length = 0;
    const plain = await service().requestReply(payload("backend-services", "Tidy this sentence: hi there"), { userId: "owner" });
    expect(calls.some((call) => call.url === META_URL)).toBe(false);
    expect(plain.metadata.execution.provider).toBe("openai-api");
  });

  test("without a Meta key, Agent mode under Auto falls back to the other tool-calling models", async () => {
    const calls = recordCalls(() => answer("Done."));
    const result = await service({ META_API_KEY: "" }).requestReply(payload("backend-services", "Summarize: cats nap a lot.", { agent: true }), { userId: "owner" });
    expect(calls.some((call) => call.url === META_URL)).toBe(false);
    expect(result.metadata.execution.agent).toBeDefined();
  });

  test("the router never sees Muse Wonder as a plain-reply candidate", async () => {
    const seen: any[] = [];
    recordCalls(() => answer("Done."));
    await service({}, { autoRouter: async ({ routes }: any) => { seen.push(...routes); return null; } })
      .requestReply(payload("backend-services", "Tidy this sentence: hi there"), { userId: "owner" });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((route) => route.serviceId === "meta-api")).toBe(false);
  });

  test("bills Muse Wonder at Meta's published rates", () => {
    const price = getHostedModelPrice({ HOSTED_MODEL_PRICES_JSON: JSON.stringify(prices) }, "meta", "muse-wonder-1.0");
    const usage = normalizeProviderUsage("meta", { usage: { input_tokens: 1_000_000, output_tokens: 1_000_000,
      input_tokens_details: { cached_tokens: 500_000 }, output_tokens_details: { reasoning_tokens: 400_000 } } });
    expect(usage).toMatchObject({ inputTokens: 1_000_000, cachedInputTokens: 500_000, outputTokens: 1_000_000, reasoningTokens: 400_000 });
    // 0.5M fresh input at $4 + 0.5M cached at $0.20 + 1M output (reasoning included) at $20.
    expect(calculateUsageMicros(usage!, price)).toBe(2_000_000 + 100_000 + 20_000_000);
  });
});

describe("Agent mode turning itself on", () => {
  const request = (content: string, extra: Record<string, unknown> = {}) => ({
    conversation: { ancestorContext: [], branchAnchor: null, documents: [] }, messages: [{ role: "user", content }], ...extra,
  });

  test("starts for links, questions about saved material, and references to something not in the conversation", () => {
    expect(agentNeedFromPrompt(request("Summarize https://example.com/post please"))).toContain("web link");
    expect(agentNeedFromPrompt(request("What did I write about pricing?"))).toContain("saved documents");
    expect(agentNeedFromPrompt(request("Find the part of my notes about heat pumps"))).toContain("saved documents");
    expect(agentNeedFromPrompt(request("Summarize the project plan"))).toContain("isn't in this conversation");
    expect(agentNeedFromPrompt(request("Like we discussed, what's next?"))).toContain("isn't in this conversation");
  });

  test("stays off for prompts that carry what they need", () => {
    expect(agentNeedFromPrompt(request("Write a project plan for a small bakery"))).toBeNull();
    expect(agentNeedFromPrompt(request("Explain how photosynthesis works"))).toBeNull();
    expect(agentNeedFromPrompt(request(`Fix the email below.\n\n${"Dear team, ".repeat(40)}`))).toBeNull();
    // "The plan" is in the conversation already.
    expect(agentNeedFromPrompt({ ...request("Summarize the plan"), messages: [
      { role: "user", content: "Here is my plan: ship in May." }, { role: "assistant", content: "Noted." }, { role: "user", content: "Summarize the plan" }] })).toBeNull();
    expect(agentNeedFromPrompt(request("Summarize the plan", { conversation: { ancestorContext: [], documents: [], branchAnchor: { quote: "Ship in May", prompt: "" } } }))).toBeNull();
  });

  test("a prompt that needs it runs as an agent and says why on the receipt", async () => {
    const calls = recordCalls((_url, body) => body.input.some((item: any) => item.type === "function_call_output") ? answer("You wrote about $20.") : toolCall("search_conversations", { query: "pricing" }));
    const result = await service().requestReply(payload("openai-api", "What did I write about pricing?"), { userId: "owner" });
    expect(calls[0].body.tools.length).toBeGreaterThan(0);
    const agent = normalizeAIExecution(result.metadata.execution)?.agent;
    expect(agent).toMatchObject({ automatic: "it asks about your saved documents and notes", stopReason: "answered" });
  });

  test("respects the switch, and never starts for models that can't call tools", async () => {
    const calls = recordCalls(() => answer("Plain."));
    const off = await service().requestReply(payload("openai-api", "What did I write about pricing?", { agentAuto: false }), { userId: "owner" });
    expect(calls[0].body.tools).toBeUndefined();
    expect(off.metadata.execution.agent).toBeUndefined();
    globalThis.fetch = (async () => Response.json({ candidates: [{ content: { parts: [{ text: "Plain answer" }] } }] })) as typeof fetch;
    const gemini = await service().requestReply(payload("gemini-api", "What did I write about pricing?"), { userId: "owner" });
    expect(gemini.metadata.execution.agent).toBeUndefined();
    expect(gemini.metadata.execution.warnings.join(" ")).not.toContain("Agent mode");
  });

  test("the auto router can ask for Agent mode when the rules don't", async () => {
    const calls = recordCalls(() => answer("Done."));
    const result = await service({}, { autoRouter: async () => ({ task: "general", keepDefault: true, contextOrder: [], needsAgent: true }) })
      .requestReply(payload("backend-services", "Continue where I left off."), { userId: "owner" });
    expect(calls[0].url).toBe(META_URL);
    expect(result.metadata.execution.agent).toMatchObject({ automatic: expect.stringContaining("information") });
  });

  test("the switch and the budget survive settings and request validation", () => {
    expect(normalizeAISettings({ agentAuto: false })).toMatchObject({ agentAuto: false });
    expect(normalizeAISettings({ agentAuto: true })).not.toHaveProperty("agentAuto");
    expect(validateAIOptions({ agentAuto: false, agentScope: "selected", agentBudgetMicros: 1_000_000 }))
      .toMatchObject({ agentAuto: false, agentScope: "selected", agentBudgetMicros: 1_000_000 });
    expect(() => validateAIOptions({ agentAuto: "yes" })).toThrow("agentAuto");
  });
});
