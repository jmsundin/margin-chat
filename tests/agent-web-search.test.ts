import { afterEach, describe, expect, test } from "bun:test";
import { normalizeAIExecution } from "@margin-chat/workspace-contracts";
import prices from "../docs/config/hosted-prices-2026-10-18.json";
import { agentNeedFromPrompt } from "../server/chat/agent/autoAgent.mjs";
import { runAgent } from "../server/chat/agent/runner.mjs";
import { createChatService } from "../server/chat/index.mjs";
import { calculateUsageMicros, createHostedUsageMeter, getHostedModelPrice, normalizeProviderUsage } from "../server/billing/usage.mjs";
import { getDefaultModelIdForService } from "../server/lib/backendModels.mjs";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const META_URL = "https://api.meta.ai/v1/responses";
const usage = { input_tokens: 1000, output_tokens: 100 };
const searchCall = (query: string, status = "completed") => ({ type: "web_search_call", id: `ws_${query}`, status, action: { type: "search", query } });
const cited = (text: string, pages: Array<{ url: string; title: string }>) => ({ type: "message", role: "assistant",
  content: [{ type: "output_text", text, annotations: pages.map((page) => ({ type: "url_citation", start_index: 0, end_index: text.length, ...page })) }] });
const toolCall = (name: string, args: Record<string, unknown>) => ({ type: "function_call", name, call_id: "call_1", arguments: JSON.stringify(args) });

function recordCalls(respond: (body: any, index: number) => unknown) {
  const calls: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    return Response.json(respond(body, calls.length));
  }) as typeof fetch;
  return calls;
}

const chatRequest = (content: string, mode = "balanced") => ({ ai: { mode }, conversation: { id: "chat", ancestorContext: [] }, messages: [{ role: "user", content }] });
const agentArgs = (content: string, extra: Record<string, unknown> = {}) => ({
  provider: "meta", apiKey: "meta", model: "muse-wonder-1.0", systemInstruction: "Help.", maxOutputTokens: 500, usageMeter: null,
  chatRequest: chatRequest(content), ...extra,
});

const sse = (events: any[]) => new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });

describe("Agent mode live progress on Muse Wonder", () => {
  test("says what it is doing while each call and tool runs: the search query, the tool, and detailed thinking", async () => {
    const bodies: any[] = [];
    globalThis.fetch = (async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return bodies.length === 1 ? sse([
        { type: "response.web_search_call.searching", item_id: "ws_1" },
        { type: "response.output_item.done", item: searchCall("heat pump rebates") },
        { type: "response.output_item.added", item: { type: "function_call", name: "search_vault", call_id: "call_1", arguments: "" } },
        { type: "response.completed", response: { model: "muse-wonder-1.0", usage, output: [searchCall("heat pump rebates"), toolCall("search_vault", { query: "rebates" })] } },
      ]) : sse([
        { type: "response.output_text.delta", delta: "Up to $8,000." },
        { type: "response.completed", response: { model: "muse-wonder-1.0", usage, output: [cited("Up to $8,000.", [])] } },
      ]);
    }) as typeof fetch;
    const live: string[] = [];
    await runAgent({ ...agentArgs("What rebates are there?"), webSearch: true,
      workspace: { userId: "owner", vault: {}, database: { searchAgentPassages: async () => [] } },
      onActivity: async (activity: string, details: any = {}) => { live.push(`${activity}:${details.label ?? ""}`); } });
    expect(bodies[0].reasoning).toMatchObject({ summary: "detailed" });
    expect(live.slice(0, 5)).toEqual([
      "thinking:Reading your request", "searching:Searching the web", "searching:Searching the web for “heat pump rebates”",
      "tool:Searching your vault", "tool:Searching your vault for “rebates”",
    ]);
    expect(live.slice(5)).toEqual(["thinking:Thinking about what it found", "writing:"]);
  });
});

describe("Agent mode web search on Muse Wonder", () => {
  test("offers Meta's web_search with a search cap, records each search, and keeps the pages the answer cites", async () => {
    const page = { url: "https://example.gov/rebates", title: "Heat pump rebates" };
    const calls = recordCalls(() => ({ output_text: "You can get up to $8,000.", usage,
      output: [searchCall("heat pump rebates 2026"), cited("You can get up to $8,000.", [page, page])] }));
    const steps: any[] = [];
    const result = await runAgent({ ...agentArgs("What heat pump rebates are there now?"), webSearch: true, onStep: async ({ step }: any) => { steps.push(step); } });
    expect(calls[0].url).toBe(META_URL);
    expect(calls[0].body.tools).toContainEqual({ type: "web_search", search_context_size: "medium" });
    expect(calls[0].body.max_tool_calls).toBe(6);
    expect(calls[0].body.tool_choice).toBe("auto");
    expect(steps).toContainEqual({ kind: "tool", tool: "web_search", label: "Searched the web for “heat pump rebates 2026”", ok: true });
    expect(result.reply).toBe("You can get up to $8,000.");
    expect(result.agent.webSources).toEqual([page]);
    expect(normalizeAIExecution({ schemaVersion: 1, model: "m", provider: "meta-api", agent: result.agent })?.agent?.webSources).toEqual([page]);
  });

  test("counts searches across the run and never searches on the last, tool-free call", async () => {
    let clock = 0;
    const calls = recordCalls((body) => {
      clock += 100_000;
      // Meta ignores built-in calls past max_tool_calls.
      return body.tools ? { output: [...[searchCall("a"), searchCall("b", "failed")].slice(0, body.max_tool_calls ?? 0), toolCall("list_recent_conversations", { limit: 1 })], usage }
        : { output_text: "Done.", output: [], usage };
    });
    const steps: any[] = [];
    await runAgent({ ...agentArgs("Look this up online", { chatRequest: chatRequest("Look this up online", "fast") }), webSearch: true, timeLimitMs: 240_000, now: () => clock,
      onStep: async ({ step }: any) => { steps.push(step); } });
    expect(calls.map((call) => call.body.max_tool_calls)).toEqual([3, 1, undefined, undefined]);
    expect(calls[2].body.tools.some((tool: any) => tool.type === "web_search")).toBe(false);
    expect(calls[0].body.tools).toContainEqual({ type: "web_search", search_context_size: "low" });
    expect(calls[1].body.tools).toContainEqual({ type: "web_search", search_context_size: "low" });
    expect(calls.at(-1)!.body).not.toHaveProperty("tools");
    expect(steps.filter((step) => step.tool === "web_search").map((step) => step.ok)).toEqual([true, false, true]);
  });

  test("stops offering web_search once the run's searches are used up", async () => {
    const calls = recordCalls((_body, index) => index === 1
      ? { output: [searchCall("a"), searchCall("b"), searchCall("c"), toolCall("list_recent_conversations", { limit: 1 })], usage }
      : { output_text: "Done.", output: [], usage });
    await runAgent({ ...agentArgs("Search the web", { chatRequest: chatRequest("Search the web", "fast") }), webSearch: true });
    expect(calls[1].body.tools.some((tool: any) => tool.type === "web_search")).toBe(false);
    expect(calls[1].body).not.toHaveProperty("max_tool_calls");
  });

  test("leaves web search out unless the run allows it", async () => {
    const calls = recordCalls(() => ({ output_text: "Done.", output: [], usage }));
    await runAgent(agentArgs("What's new?"));
    expect(calls[0].body.tools.some((tool: any) => tool.type === "web_search")).toBe(false);
    expect(calls[0].body).not.toHaveProperty("max_tool_calls");
  });

  test("bills each search at Meta's $2.50 per 1,000 on top of tokens, and reserves for the most searches a call may make", async () => {
    const env = { HOSTED_MODEL_PRICES_JSON: JSON.stringify(prices) };
    const price = getHostedModelPrice(env, "meta", "muse-wonder-1.0");
    expect(price.webSearchMicrosPerSearch).toBe(2500);
    const counted = normalizeProviderUsage("meta", { usage, output: [searchCall("a"), searchCall("b"), searchCall("c", "failed")] });
    expect(counted).toMatchObject({ webSearches: 2 });
    // 1,000 input at $4/M + 100 output at $20/M + 2 searches at $0.0025.
    expect(calculateUsageMicros(counted!, price)).toBe(4000 + 2000 + 5000);
    expect(normalizeProviderUsage("meta", { usage, output: [] })).not.toHaveProperty("webSearches");

    const reservations: any[] = [];
    const settlements: any[] = [];
    const billingService = {
      reserveHostedRequest: async (args: any) => { reservations.push(args); return { amountMicros: args.amountMicros }; },
      settleHostedRequest: async (args: any) => { settlements.push(args); },
    };
    const meter = createHostedUsageMeter({ env, billingService, requestId: "run", userId: "member" });
    recordCalls(() => ({ output_text: "Found it.", usage, output: [searchCall("a"), searchCall("b"), cited("Found it.", [])] }));
    await runAgent({ ...agentArgs("Search the web for it"), usageMeter: meter, webSearch: true });
    expect(reservations[0].metadata.webSearchLimit).toBe(6);
    expect(settlements[0]).toMatchObject({ amountMicros: 11_000, metadata: { webSearches: 2 } });
  });

  test("a hosted call that offers web search needs a per-search price", async () => {
    const env = { HOSTED_MODEL_PRICES_JSON: JSON.stringify({ "meta:muse-wonder-1.0": { inputMicrosPerMillionTokens: 4_000_000, outputMicrosPerMillionTokens: 20_000_000 } }) };
    const meter = createHostedUsageMeter({ env, billingService: { reserveHostedRequest: async () => ({}), settleHostedRequest: async () => {} }, requestId: "run", userId: "member" });
    await expect(meter.begin({ provider: "meta", model: "muse-wonder-1.0", maxOutputTokens: 100, body: { tools: [{ type: "web_search" }], max_tool_calls: 3 } }))
      .rejects.toThrow("web search pricing");
  });
});

describe("the chat service and web search", () => {
  function payload(serviceId: string, content: string, ai: Record<string, unknown> = {}) {
    return {
      ai: { mode: "balanced", contextScope: "conversation", selectedConversationIds: [], ...ai },
      conversation: { ancestorContext: [], branchAnchor: null, id: "chat", parentId: null, title: "Chat", documents: [] },
      messages: [{ role: "user", content }], modelId: getDefaultModelIdForService(serviceId), serviceId,
    };
  }
  const service = (env: Record<string, string> = {}) => createChatService({ autoRouter: async () => null, database: {},
    runtimeConfig: { defaultBackendProvider: "openai-api" }, env: { OPENAI_API_KEY: "openai-test", ...env } });
  const metaAnswers = () => recordCalls(() => ({ output_text: "React 21.", output: [searchCall("latest React version"),
    cited("React 21.", [{ url: "https://react.dev/blog", title: "React Blog" }])], usage }));

  test("a question about current events starts Agent mode on Muse Wonder with web search", async () => {
    const calls = metaAnswers();
    const result = await service().requestReply(payload("backend-services", "What is the latest version of React?"), { userId: "owner", apiKeys: { meta: "personal-meta" } });
    expect(calls[0].url).toBe(META_URL);
    expect(calls[0].body.tools).toContainEqual(expect.objectContaining({ type: "web_search" }));
    expect(calls[0].body.instructions).toContain("web_search searches the web");
    const agent = normalizeAIExecution(result.metadata.execution)?.agent;
    expect(agent).toMatchObject({ automatic: "it needs current information from the web", webSources: [{ url: "https://react.dev/blog", title: "React Blog" }] });
  });

  test("on Margin Chat's key, web search needs the per-search price in the hosted price map", async () => {
    let calls = metaAnswers();
    await service({ META_API_KEY: "hosted-meta", HOSTED_MODEL_PRICES_JSON: JSON.stringify(prices) })
      .requestReply(payload("meta-api", "Hi", { agent: true }), { userId: "owner" });
    expect(calls[0].body.tools).toContainEqual(expect.objectContaining({ type: "web_search" }));
    calls = metaAnswers();
    const withoutSearchPrice = { ...prices, "meta:muse-wonder-1.0": { ...prices["meta:muse-wonder-1.0"], webSearchMicrosPerSearch: undefined } };
    await service({ META_API_KEY: "hosted-meta", HOSTED_MODEL_PRICES_JSON: JSON.stringify(withoutSearchPrice) })
      .requestReply(payload("meta-api", "Hi", { agent: true }), { userId: "owner" });
    expect(calls[0].body.tools.some((tool: any) => tool.type === "web_search")).toBe(false);
  });

  test("without a model that can search, current-events questions stay plain replies", async () => {
    const calls = recordCalls(() => ({ output_text: "Plain.", output: [], usage }));
    const result = await service().requestReply(payload("openai-api", "What is the latest version of React?"), { userId: "owner" });
    expect(calls[0].body.tools).toBeUndefined();
    expect(result.metadata.execution.agent).toBeUndefined();
  });

  test("the rule only fires when the agent could search the web", () => {
    const request = (content: string) => ({ conversation: { ancestorContext: [], documents: [] }, messages: [{ role: "user", content }] });
    for (const prompt of ["What is the latest version of React?", "Search the web for heat pump rebates", "Look up the population of Oslo",
      "Any news about the Mars mission?", "What are the current guidelines for statins?"]) {
      expect(agentNeedFromPrompt(request(prompt), { web: true })).toBe("it needs current information from the web");
      expect(agentNeedFromPrompt(request(prompt))).toBeNull();
    }
    for (const prompt of ["Explain current in a circuit", "Write a poem about the current moment", "Tidy this sentence: hi there"]) {
      expect(agentNeedFromPrompt(request(prompt), { web: true })).toBeNull();
    }
  });
});
