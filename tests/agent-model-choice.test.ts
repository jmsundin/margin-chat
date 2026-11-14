import { afterEach, describe, expect, test } from "bun:test";
import { normalizeAISettings } from "@margin-chat/workspace-contracts";
import prices from "../docs/config/hosted-prices-2026-11-14.json";
import { runAgent } from "../server/chat/agent/runner.mjs";
import { createChatService } from "../server/chat/index.mjs";
import { validateAIOptions } from "../server/chat/validation.mjs";
import { calculateUsageMicros, createHostedUsageMeter, getHostedModelPrice, normalizeProviderUsage } from "../server/billing/usage.mjs";
import { getDefaultModelIdForService } from "../server/lib/backendModels.mjs";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const META_URL = "https://api.meta.ai/v1/responses";
const XAI_URL = "https://api.x.ai/v1/responses";
const usage = { input_tokens: 1000, output_tokens: 100 };
const answer = (text: string) => ({ output_text: text, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }], usage });

function payload(serviceId: string, content: string, ai: Record<string, unknown> = {}) {
  return {
    ai: { mode: "balanced", contextScope: "conversation", selectedConversationIds: [], ...ai },
    conversation: { ancestorContext: [], branchAnchor: null, id: "chat", parentId: null, title: "Chat", documents: [] },
    messages: [{ role: "user", content }],
    modelId: getDefaultModelIdForService(serviceId), serviceId,
  };
}

function service(env: Record<string, string> = {}) {
  return createChatService({ autoRouter: async () => null, database: {}, runtimeConfig: { defaultBackendProvider: "openai-api" },
    env: { OPENAI_API_KEY: "openai-test", META_API_KEY: "meta-test", XAI_API_KEY: "xai-test", ANTHROPIC_API_KEY: "anthropic-test", ...env } });
}

function sse(events: any[]) {
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}

/** A Claude Messages stream holding these content blocks, as the API sends them. */
function claudeSse(blocks: any[], stopReason: string, extraUsage: Record<string, unknown> = {}) {
  return sse([
    { type: "message_start", message: { id: "msg", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, usage: { input_tokens: 50, output_tokens: 1 } } },
    ...blocks.flatMap((block, index) => block.type === "text"
      ? [{ type: "content_block_start", index, content_block: { type: "text", text: "", ...(block.citations ? { citations: [] } : {}) } },
        ...(block.citations ?? []).map((citation: any) => ({ type: "content_block_delta", index, delta: { type: "citations_delta", citation } })),
        { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } },
        { type: "content_block_stop", index }]
      : block.type === "server_tool_use" || block.type === "tool_use"
        ? [{ type: "content_block_start", index, content_block: { ...block, input: {} } },
          { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } },
          { type: "content_block_stop", index }]
        : [{ type: "content_block_start", index, content_block: block }, { type: "content_block_stop", index }]),
    { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 20, ...extraUsage } },
    { type: "message_stop" },
  ]);
}

describe("Agent model setting", () => {
  test("keeps the chosen agent model and the X search switch, and refuses anything else", () => {
    expect(validateAIOptions({ agentService: "xai-api", agentXSearch: true })).toMatchObject({ agentService: "xai-api", agentXSearch: true });
    expect(validateAIOptions({})).not.toHaveProperty("agentService");
    expect(() => validateAIOptions({ agentService: "openai-api" })).toThrow("agent models");
    expect(normalizeAISettings({ agentService: "anthropic-api", agentXSearch: true })).toMatchObject({ agentService: "anthropic-api", agentXSearch: true });
    expect(normalizeAISettings({ agentService: "gemini-api", agentXSearch: "yes" })).not.toHaveProperty("agentService");
  });

  test("Auto runs Agent mode on the chosen model, and on Muse Wonder when none is chosen", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: any) => {
      calls.push(String(url));
      return Response.json(answer("Done."));
    }) as typeof fetch;
    const grok = await service().requestReply(payload("backend-services", "Summarize: cats nap.", { agent: true, agentService: "xai-api" }), { userId: "owner" });
    expect(calls[0]).toBe(XAI_URL);
    expect(grok.metadata.execution).toMatchObject({ provider: "xai-api", model: "grok-4.7" });
    expect(grok.metadata.execution.reason).toContain("as chosen in AI settings");
    calls.length = 0;
    const muse = await service().requestReply(payload("backend-services", "Summarize: cats nap.", { agent: true }), { userId: "owner" });
    expect(calls[0]).toBe(META_URL);
    expect(muse.metadata.execution.provider).toBe("meta-api");
  });

  test("falls back to Muse Wonder when the chosen model has no key", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: any) => { calls.push(String(url)); return Response.json(answer("Done.")); }) as typeof fetch;
    const result = await service({ XAI_API_KEY: "" }).requestReply(payload("backend-services", "Summarize: cats nap.", { agent: true, agentService: "xai-api" }), { userId: "owner" });
    expect(calls[0]).toBe(META_URL);
    expect(result.metadata.execution.reason).toContain("isn't available");
  });
});

describe("Grok agent search", () => {
  const args = (extra: Record<string, unknown> = {}) => ({ provider: "xai", apiKey: "xai", model: "grok-4.7", systemInstruction: "Help.", maxOutputTokens: 500, usageMeter: null,
    chatRequest: { ai: { mode: "balanced" }, conversation: { id: "chat", ancestorContext: [] }, messages: [{ role: "user", content: "What are people saying?" }] }, ...extra });

  test("offers web and X search capped by rounds, records each search, and drops xAI's own calls from the history", async () => {
    const bodies: any[] = [];
    globalThis.fetch = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      return Response.json(bodies.length === 1 ? { usage, output: [
        { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "longevity trial results" } },
        { type: "custom_tool_call", call_id: "xs_1", name: "x_keyword_search", input: JSON.stringify({ query: "rapamycin" }), status: "completed" },
        { type: "function_call", name: "list_recent_conversations", call_id: "call_1", arguments: "{\"limit\":1}" },
      ] } : answer("Mixed views."));
    }) as typeof fetch;
    const steps: any[] = [];
    const result = await runAgent({ ...args(), webSearch: true, xSearch: true, onStep: async ({ step }: any) => { steps.push(step); } });
    expect(bodies[0].tools).toContainEqual({ type: "web_search" });
    expect(bodies[0].tools).toContainEqual({ type: "x_search" });
    expect(bodies[0].max_turns).toBe(2);
    expect(bodies[0]).not.toHaveProperty("max_tool_calls");
    expect(steps).toContainEqual({ kind: "tool", tool: "web_search", label: "Searched the web for “longevity trial results”", ok: true });
    expect(steps).toContainEqual({ kind: "tool", tool: "x_search", label: "Searched X for “rapamycin”", ok: true });
    expect(bodies[1].input.some((item: any) => item.type === "web_search_call" || item.type === "custom_tool_call")).toBe(false);
    expect(bodies[1].input.some((item: any) => item.type === "function_call")).toBe(true);
    expect(result.reply).toBe("Mixed views.");
  });

  test("leaves X search off unless it is turned on", async () => {
    const bodies: any[] = [];
    globalThis.fetch = (async (_url: any, init: any) => { bodies.push(JSON.parse(init.body)); return Response.json(answer("Done.")); }) as typeof fetch;
    await runAgent({ ...args(), webSearch: true });
    expect(bodies[0].tools).toContainEqual({ type: "web_search" });
    expect(bodies[0].tools.some((tool: any) => tool.type === "x_search")).toBe(false);
  });
});

describe("Claude agent search and caching", () => {
  const args = { provider: "anthropic", apiKey: "sk-ant", model: "claude-opus-5-5", systemInstruction: "Help.", maxOutputTokens: 2000, usageMeter: null,
    chatRequest: { ai: { mode: "balanced" }, conversation: { id: "chat", ancestorContext: [] }, messages: [{ role: "user", content: "Latest on senolytics?" }] } };
  const page = { url: "https://example.org/senolytics", title: "Senolytics review" };

  test("offers web_search and web_fetch with fixed caps, asks for caching, resumes a paused turn and keeps cited pages", async () => {
    const bodies: any[] = [];
    globalThis.fetch = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      return bodies.length === 1
        ? claudeSse([{ type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "senolytics 2026" } },
          { type: "web_search_tool_result", tool_use_id: "srv_1", content: [{ type: "web_search_result", url: page.url, title: page.title, encrypted_content: "x" }] }], "pause_turn")
        : claudeSse([{ type: "text", text: "Trials are mixed.", citations: [{ type: "web_search_result_location", url: page.url, title: page.title, cited_text: "mixed", encrypted_index: "i" }] }], "end_turn");
    }) as typeof fetch;
    const steps: any[] = [];
    const live: string[] = [];
    const result = await runAgent({ ...args, webSearch: true, onStep: async ({ step }: any) => { steps.push(step); },
      onActivity: async (activity: string, details: any = {}) => { live.push(`${activity}:${details.label ?? ""}`); } });
    expect(bodies[0].tools).toContainEqual({ type: "web_search_20260209", name: "web_search", max_uses: 3 });
    expect(bodies[0].tools).toContainEqual({ type: "web_fetch_20260209", name: "web_fetch", max_uses: 3, max_content_tokens: 20_000 });
    expect(bodies[0].cache_control).toEqual({ type: "ephemeral" });
    // The paused turn is sent back as it stands, with the same tools, so Claude carries on.
    expect(bodies).toHaveLength(2);
    expect(bodies[1].tools).toEqual(bodies[0].tools);
    expect(bodies[1].messages.at(-1).role).toBe("assistant");
    expect(live).toContain("searching:Searching the web");
    expect(steps).toContainEqual({ kind: "tool", tool: "web_search", label: "Searched the web for “senolytics 2026”", ok: true });
    expect(result.reply).toBe("Trials are mixed.");
    expect(result.agent.webSources).toEqual([page]);
  });

  test("marks a failed search", async () => {
    globalThis.fetch = (async () => claudeSse([
      { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "x" } },
      { type: "web_search_tool_result", tool_use_id: "srv_1", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } },
      { type: "text", text: "Couldn't search." }], "end_turn")) as typeof fetch;
    const steps: any[] = [];
    await runAgent({ ...args, webSearch: true, onStep: async ({ step }: any) => { steps.push(step); } });
    expect(steps).toContainEqual({ kind: "tool", tool: "web_search", label: "Searched the web for “x”", ok: false });
  });

  test("offers no search tools when web search is off", async () => {
    const bodies: any[] = [];
    globalThis.fetch = (async (_url: any, init: any) => { bodies.push(JSON.parse(init.body)); return claudeSse([{ type: "text", text: "Hi." }], "end_turn"); }) as typeof fetch;
    await runAgent(args);
    expect(bodies[0].tools.some((tool: any) => String(tool.type ?? "").startsWith("web_"))).toBe(false);
  });
});

describe("billing Claude and Grok searches", () => {
  const env = { HOSTED_MODEL_PRICES_JSON: JSON.stringify(prices) };

  test("prices searches, X posts and profiles from the November price map", () => {
    const claude = getHostedModelPrice(env, "anthropic", "claude-opus-5-5");
    expect(claude.webSearchMicrosPerSearch).toBe(10_000);
    const grok = getHostedModelPrice(env, "xai", "grok-4.7");
    expect(grok).toMatchObject({ webSearchMicrosPerSearch: 5_000, xPostMicrosPerPost: 5_000, xUserMicrosPerUser: 10_000 });
    const base = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningTokens: 0 };
    expect(calculateUsageMicros({ ...base, webSearches: 2, xPosts: 40, xUsers: 3 }, grok)).toBe(2 * 5_000 + 40 * 5_000 + 3 * 10_000);
  });

  test("reads Claude's and Grok's own search counts from usage", () => {
    expect(normalizeProviderUsage("anthropic", { usage: { input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 } } }))
      .toMatchObject({ webSearches: 2 });
    expect(normalizeProviderUsage("xai", { output: [], usage: { input_tokens: 10, output_tokens: 5,
      server_side_tool_usage_details: { web_search_calls: 3, x_search_calls: 2, x_posts_fetched: 44, x_users_fetched: 1 } } }))
      .toMatchObject({ webSearches: 3, xPosts: 44, xUsers: 1 });
  });

  test("reserves for every search, X post and page a call may use, and settles at what was reported", async () => {
    const reservations: any[] = [];
    const settlements: any[] = [];
    const billingService = { reserveHostedRequest: async (entry: any) => { reservations.push(entry); }, settleHostedRequest: async (entry: any) => { settlements.push(entry); } };
    const meter = createHostedUsageMeter({ env, billingService, requestId: "r", userId: "u" });
    const grok = await meter.begin({ provider: "xai", model: "grok-4.7", maxOutputTokens: 100,
      body: { model: "grok-4.7", input: [], tools: [{ type: "web_search" }, { type: "x_search" }], max_turns: 2 } });
    expect(reservations[0].metadata).toMatchObject({ webSearchLimit: 8, xPostLimit: 120, xUserLimit: 20 });
    grok.markDispatched();
    grok.recordUsage({ usage: { input_tokens: 2000, output_tokens: 50, server_side_tool_usage_details: { web_search_calls: 2, x_posts_fetched: 30, x_users_fetched: 0 } } });
    await grok.finish();
    expect(settlements[0].metadata).toMatchObject({ webSearches: 2, xPosts: 30, usageSource: "provider" });
    const claude = await meter.begin({ provider: "anthropic", model: "claude-opus-5-5", maxOutputTokens: 100,
      body: { model: "claude-opus-5-5", messages: [], tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 3 },
        { type: "web_fetch_20260209", name: "web_fetch", max_uses: 3, max_content_tokens: 20_000 }] } });
    expect(reservations[1].metadata.webSearchLimit).toBe(3);
    // Room for three searches' results and three fetched pages, beyond the request itself.
    expect(reservations[1].metadata.inputTokenLimit).toBeGreaterThan(3 * 10_000 + 3 * 20_000);
    claude.markDispatched();
    await claude.finish();
  });

  test("refuses a hosted X search without a round limit", async () => {
    const meter = createHostedUsageMeter({ env, billingService: { reserveHostedRequest: async () => {}, settleHostedRequest: async () => {} }, requestId: "r", userId: "u" });
    await expect(meter.begin({ provider: "xai", model: "grok-4.7", maxOutputTokens: 100, body: { model: "grok-4.7", input: [], tools: [{ type: "x_search" }] } }))
      .rejects.toThrow("rounds of searching");
  });
});
