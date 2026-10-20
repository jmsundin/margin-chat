import { afterEach, describe, expect, test } from "bun:test";
import { normalizeAIExecution, normalizeAISettings } from "@margin-chat/workspace-contracts";
import { createChatService } from "../server/chat/index.mjs";
import { runAgent } from "../server/chat/agent/runner.mjs";
import { validateAIOptions } from "../server/chat/validation.mjs";
import { getDefaultModelIdForService } from "../server/lib/backendModels.mjs";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const chatRequest = {
  ai: { mode: "balanced", contextScope: "selected", selectedConversationIds: ["notes"] },
  conversation: { id: "chat", title: "Chat", messages: [], ancestorContext: [] },
  messages: [{ role: "user", content: "What did I decide about pricing?" }],
  workspaceContext: [{ id: "notes", title: "Pricing notes", updatedAt: "2026-10-01", content: "We settled on $20 a month.", messages: [] }],
};

function claudeSse(blocks: any[], stopReason: string) {
  const events = [
    { type: "message_start", message: { id: "msg", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, usage: { input_tokens: 50, output_tokens: 1 } } },
    ...blocks.flatMap((block, index) => block.type === "tool_use"
      ? [{ type: "content_block_start", index, content_block: { ...block, input: {} } },
        { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } },
        { type: "content_block_stop", index }]
      : block.type === "thinking"
        ? [{ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } },
          { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } },
          { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "sig" } },
          { type: "content_block_stop", index }]
        : [{ type: "content_block_start", index, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } },
          { type: "content_block_stop", index }]),
    { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 20 } },
    { type: "message_stop" },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}

function responsesSse(events: any[]) {
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}

const answer = (text: string) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });

describe("agent loop across providers", () => {
  test("stops calling tools once its time limit has passed", async () => {
    const bodies: any[] = [];
    let clock = 0;
    globalThis.fetch = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      clock += 100_000;
      return Response.json(body.tool_choice === "none"
        ? { output_text: "Out of time, here is what I found.", output: [] }
        : { output: [{ type: "function_call", name: "list_recent_conversations", call_id: `call_${bodies.length}`, arguments: "{\"limit\":1}" }] });
    }) as typeof fetch;
    const result = await runAgent({ provider: "openai", apiKey: "sk", chatRequest, model: "gpt", systemInstruction: "Help.", maxOutputTokens: 500, usageMeter: null,
      timeLimitMs: 240_000, now: () => clock });
    expect(bodies.map((body) => body.tool_choice)).toEqual(["auto", "auto", "auto", "none"]);
    expect(bodies.at(-1).instructions).toContain("time limit");
    expect(result.agent).toMatchObject({ stopReason: "time-limit", modelCalls: 4 });
  });

  test("Claude: runs tool_use calls, streams its thinking and replays it with the tool results", async () => {
    const bodies: any[] = [];
    globalThis.fetch = (async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return bodies.length === 1
        ? claudeSse([{ type: "thinking", thinking: "Look it up." }, { type: "text", text: "Checking your notes." },
          { type: "tool_use", id: "toolu_1", name: "search_conversations", input: { query: "pricing" } }], "tool_use")
        : claudeSse([{ type: "text", text: "You chose $20 a month." }], "end_turn");
    }) as typeof fetch;
    const steps: any[] = [];
    const live: string[] = [];
    const result = await runAgent({ provider: "anthropic", apiKey: "sk-ant", chatRequest, model: "claude-opus-5-5", systemInstruction: "Help.",
      maxOutputTokens: 1000, usageMeter: null, onStep: async (event: any) => { steps.push(event.step); live.push(`step:${event.step.kind}`); },
      onThinking: async (delta: string) => { live.push(`thinking:${delta}`); }, onActivity: async (activity: string) => { live.push(activity); } });
    expect(result.reply).toBe("You chose $20 a month.");
    expect(result.agent).toEqual({ steps, stopReason: "answered", reasoning: "shared", modelCalls: 2 });
    // Thinking streams while the call runs, then is recorded ahead of the call's other steps.
    // Each call says it has started, and a tool says what it is doing as the model asks for it and again as it runs.
    expect(live).toEqual(["thinking", "thinking:Look it up.", "writing", "tool", "step:thinking", "step:note", "tool", "step:tool", "thinking", "writing"]);
    // Claude 5 models hide thinking unless the request asks for the summarized form.
    expect(bodies[0].thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(steps).toEqual([
      { kind: "thinking", label: "Look it up.", ok: true },
      { kind: "note", label: "Checking your notes.", ok: true },
      { kind: "tool", tool: "search_conversations", label: "Searched for “pricing”", detail: "2 matches", ok: true },
    ]);
    expect(bodies[0].tools.map((tool: any) => tool.name)).toEqual(["search_conversations", "list_recent_conversations", "get_conversation"]);
    expect(bodies[0].tools[0].input_schema.required).toEqual(["query"]);
    expect(bodies[0].tool_choice).toEqual({ type: "auto" });
    const [, assistant, toolResult] = bodies[1].messages;
    expect(assistant.content.map((block: any) => block.type)).toEqual(["thinking", "text", "tool_use"]);
    expect(assistant.content[0].signature).toBe("sig");
    expect(toolResult.role).toBe("user");
    expect(toolResult.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_1" });
    expect(JSON.parse(toolResult.content[0].content).matches[0].title).toBe("Pricing notes");
  });

  test("OpenAI: streams the reasoning summary and records it as a thinking step", async () => {
    const bodies: any[] = [];
    const reasoning = { type: "reasoning", id: "rs_1", summary: [
      { type: "summary_text", text: "**Checking notes**\n\nThe user asks about pricing." }, { type: "summary_text", text: "Search first." }] };
    globalThis.fetch = (async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return bodies.length === 1 ? responsesSse([
        { type: "response.reasoning_summary_part.added", summary_index: 0 },
        { type: "response.reasoning_summary_text.delta", delta: "**Checking notes**\n\n" },
        { type: "response.reasoning_summary_text.delta", delta: "The user asks about pricing." },
        { type: "response.reasoning_summary_part.added", summary_index: 1 },
        { type: "response.reasoning_summary_text.delta", delta: "Search first." },
        { type: "response.completed", response: { model: "gpt", output: [reasoning,
          { type: "function_call", name: "search_conversations", call_id: "call_1", arguments: "{\"query\":\"pricing\"}" }] } },
      ]) : responsesSse([
        { type: "response.output_text.delta", delta: "You chose $20 a month." },
        { type: "response.completed", response: { model: "gpt", output: [answer("You chose $20 a month.")] } },
      ]);
    }) as typeof fetch;
    const live: string[] = [];
    const result = await runAgent({ provider: "openai", apiKey: "sk", chatRequest, model: "gpt-summary", systemInstruction: "Help.", maxOutputTokens: 500, usageMeter: null,
      onThinking: async (delta: string) => { live.push(delta); }, onActivity: async (activity: string) => { live.push(`[${activity}]`); } });
    expect(bodies[0]).toMatchObject({ stream: true, reasoning: { summary: "auto" } });
    expect(live).toEqual(["[thinking]", "**Checking notes**\n\n", "The user asks about pricing.", "\n\n", "Search first.", "[tool]", "[thinking]", "[writing]"]);
    expect(result.reply).toBe("You chose $20 a month.");
    expect(result.agent.reasoning).toBe("shared");
    expect(result.agent.steps.map((step: any) => step.kind)).toEqual(["thinking", "tool"]);
    expect(result.agent.steps[0].label).toBe("**Checking notes**\n\nThe user asks about pricing.\n\nSearch first.");
    // The reasoning item goes back with the tool output so the model keeps its train of thought.
    expect(bodies[1].input).toContainEqual(reasoning);
  });

  test("OpenAI: a model or account that can't return reasoning summaries answers without them", async () => {
    const bodies: any[] = [];
    globalThis.fetch = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      return body.reasoning
        ? Response.json({ error: { message: "Your organization must be verified to generate reasoning summaries." } }, { status: 400 })
        : Response.json({ output: [answer("Hi")] });
    }) as typeof fetch;
    const run = () => runAgent({ provider: "openai", apiKey: "sk", chatRequest, model: "gpt-no-summary", systemInstruction: "Help.", maxOutputTokens: 500, usageMeter: null });
    const result = await run();
    expect(result.reply).toBe("Hi");
    expect(result.agent).toMatchObject({ reasoning: "not-shared", steps: [] });
    await run();
    // Asked once; later calls for that model don't ask again.
    expect(bodies.map((body) => Boolean(body.reasoning))).toEqual([true, false, false]);
  });

  test("an answer cut short by its output limit is kept, as before streaming", async () => {
    globalThis.fetch = (async () => responsesSse([
      { type: "response.output_text.delta", delta: "The first half" },
      { type: "response.incomplete", response: { model: "gpt", status: "incomplete", output: [answer("The first half")] } },
    ])) as typeof fetch;
    const result = await runAgent({ provider: "openai", apiKey: "sk", chatRequest, model: "gpt", systemInstruction: "Help.", maxOutputTokens: 500, usageMeter: null });
    expect(result.reply).toBe("The first half");
  });

  test("xAI: keeps the instruction as a system message and returns function outputs", async () => {
    const bodies: any[] = [];
    globalThis.fetch = (async (url: any, init: any) => {
      expect(String(url)).toBe("https://api.x.ai/v1/responses");
      bodies.push(JSON.parse(init.body));
      return Response.json(bodies.length === 1
        ? { output: [{ type: "function_call", name: "get_conversation", call_id: "call_1", arguments: JSON.stringify({ conversation_id: "notes" }) }] }
        : { output_text: "Done.", output: [] });
    }) as typeof fetch;
    const result = await runAgent({ provider: "xai", apiKey: "xai", chatRequest, model: "grok", systemInstruction: "Help.", maxOutputTokens: 500, usageMeter: null });
    expect(result.reply).toBe("Done.");
    expect(result.agent.steps[0]).toMatchObject({ label: "Read “Pricing notes”", ok: true });
    expect(bodies[0].input[0]).toEqual({ role: "system", content: "Help." });
    expect(bodies[0].instructions).toBeUndefined();
    expect(bodies[0].reasoning).toBeUndefined();
    expect(bodies[1].input.at(-1)).toMatchObject({ type: "function_call_output", call_id: "call_1" });
  });

  test("stops offering tools after the call limit and answers from what it has", async () => {
    const bodies: any[] = [];
    globalThis.fetch = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      return Response.json(body.tool_choice === "none"
        ? { output_text: "Best answer so far.", output: [] }
        : { output: [{ type: "function_call", name: "list_recent_conversations", call_id: `call_${bodies.length}`, arguments: "{\"limit\":1}" }] });
    }) as typeof fetch;
    const result = await runAgent({ provider: "openai", apiKey: "sk", chatRequest, model: "gpt", systemInstruction: "Help.", maxOutputTokens: 500, usageMeter: null });
    expect(bodies).toHaveLength(12);
    expect(result.agent).toMatchObject({ stopReason: "round-limit", modelCalls: 12 });
    expect(bodies.at(-1).instructions).toContain("limit of tool rounds");
    expect(result.reply).toBe("Best answer so far.");
  });
});

function payload(serviceId: string, ai: Record<string, unknown> = {}) {
  return { ...chatRequest, ai: { ...chatRequest.ai, ...ai }, conversation: { ancestorContext: [], branchAnchor: null, id: "chat", parentId: null, title: "Chat" },
    modelId: getDefaultModelIdForService(serviceId), serviceId };
}

function service() {
  return createChatService({ autoRouter: async () => null, database: {}, runtimeConfig: { defaultBackendProvider: "openai-api" },
    env: { OPENAI_API_KEY: "openai-test", GEMINI_API_KEY: "gemini-test", ANTHROPIC_API_KEY: "anthropic-test" } });
}

describe("agent mode in the chat service", () => {
  test("streams steps before the answer and records the run on the receipt", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return Response.json(calls === 1
        ? { output: [{ type: "function_call", name: "search_conversations", call_id: "call_1", arguments: "{\"query\":\"pricing\"}" }] }
        : { output_text: "You chose $20 a month.", output: [] });
    }) as typeof fetch;
    const events: string[] = [];
    const result = await service().requestReplyStream(payload("openai-api", { agent: true }), { userId: "owner" }, {
      onReady: () => { events.push("ready"); },
      onStep: ({ step }: any) => { events.push(`step:${step.tool}`); },
      onDelta: (delta: string) => { events.push(`delta:${delta}`); },
    });
    expect(events).toEqual(["ready", "step:search_conversations", "delta:You chose $20 a month."]);
    expect(result.metadata.execution.agent).toMatchObject({ stopReason: "answered", modelCalls: 2, steps: [{ tool: "search_conversations" }] });
    expect(normalizeAIExecution(result.metadata.execution)?.agent?.steps).toHaveLength(1);
  });

  test("streams the model's thinking as it is written, ahead of the step that records it", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return calls === 1 ? responsesSse([
        { type: "response.reasoning_summary_text.delta", delta: "Look in the notes." },
        { type: "response.completed", response: { model: "gpt", output: [{ type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Look in the notes." }] },
          { type: "function_call", name: "search_conversations", call_id: "call_1", arguments: "{\"query\":\"pricing\"}" }] } },
      ]) : responsesSse([{ type: "response.completed", response: { model: "gpt", output: [answer("You chose $20 a month.")] } }]);
    }) as typeof fetch;
    const events: string[] = [];
    const result = await service().requestReplyStream(payload("openai-api", { agent: true }), { userId: "owner" }, {
      onReady: () => { events.push("ready"); },
      onThinking: (delta: string) => { events.push(`thinking:${delta}`); },
      onStep: ({ step }: any) => { events.push(`step:${step.kind}`); },
      onDelta: (delta: string) => { events.push(`delta:${delta}`); },
    });
    expect(events).toEqual(["ready", "thinking:Look in the notes.", "step:thinking", "step:tool", "delta:You chose $20 a month."]);
    expect(normalizeAIExecution(result.metadata.execution)?.agent).toMatchObject({ reasoning: "shared", steps: [{ kind: "thinking", label: "Look in the notes." }, { kind: "tool" }] });
  });

  test("streams the answer as it is written and withdraws text that turned out to come before tool calls", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return calls === 1 ? responsesSse([
        { type: "response.output_text.delta", delta: "Let me " }, { type: "response.output_text.delta", delta: "look." },
        { type: "response.completed", response: { model: "gpt", output: [answer("Let me look."),
          { type: "function_call", name: "search_conversations", call_id: "call_1", arguments: "{\"query\":\"pricing\"}" }] } },
      ]) : responsesSse([
        { type: "response.output_text.delta", delta: "You chose " }, { type: "response.output_text.delta", delta: "$20 a month." },
        { type: "response.completed", response: { model: "gpt", output: [answer("You chose $20 a month.")] } },
      ]);
    }) as typeof fetch;
    const events: string[] = [];
    const result = await service().requestReplyStream(payload("openai-api", { agent: true }), { userId: "owner" }, {
      onReady: () => { events.push("ready"); },
      onStep: ({ step }: any) => { events.push(`step:${step.kind}`); },
      onDelta: (delta: string) => { events.push(`delta:${delta}`); },
      onRetract: () => { events.push("retract"); },
    });
    expect(events).toEqual(["ready", "delta:Let me ", "delta:look.", "retract", "step:note", "step:tool", "delta:You chose ", "delta:$20 a month."]);
    expect(result.reply).toBe("You chose $20 a month.");
  });

  test("streams Claude's answer text as it is written", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return calls === 1
        ? claudeSse([{ type: "text", text: "Checking." }, { type: "tool_use", id: "tool_1", name: "search_conversations", input: { query: "pricing" } }], "tool_use")
        : claudeSse([{ type: "text", text: "You chose $20 a month." }], "end_turn");
    }) as typeof fetch;
    const events: string[] = [];
    await service().requestReplyStream(payload("anthropic-api", { agent: true }), { userId: "owner" }, {
      onStep: ({ step }: any) => { events.push(`step:${step.kind}`); },
      onDelta: (delta: string) => { events.push(`delta:${delta}`); },
      onRetract: () => { events.push("retract"); },
    });
    expect(events).toEqual(["delta:Checking.", "retract", "step:note", "step:tool", "delta:You chose $20 a month."]);
  });

  test("the retired OpenAI Agent service still runs as an agent", async () => {
    const bodies: any[] = [];
    globalThis.fetch = (async (_url: any, init: any) => { bodies.push(JSON.parse(init.body)); return Response.json({ output_text: "Hi", output: [] }); }) as typeof fetch;
    const result = await service().requestReply(payload("openai-agent"), { userId: "owner" });
    expect(bodies[0].tools).toHaveLength(3);
    expect(result.metadata.execution.agent).toMatchObject({ stopReason: "answered" });
  });

  test("models without tool calling answer normally and say why", async () => {
    globalThis.fetch = (async () => Response.json({ candidates: [{ content: { parts: [{ text: "Plain answer" }] } }] })) as typeof fetch;
    const result = await service().requestReply(payload("gemini-api", { agent: true }), { userId: "owner" });
    expect(result.reply).toBe("Plain answer");
    expect(result.metadata.execution.agent).toBeUndefined();
    expect(result.metadata.execution.warnings.join(" ")).toContain("Agent mode isn't available for gemini");
  });

  test("passes cancellation to agent calls", async () => {
    const controller = new AbortController();
    globalThis.fetch = (async (_url: any, init: any) => {
      expect(init?.signal).toBe(controller.signal);
      controller.abort();
      throw controller.signal.reason;
    }) as typeof fetch;
    await expect(service().requestReply(payload("openai-api", { agent: true }), { signal: controller.signal, userId: "owner" }))
      .rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("agent settings", () => {
  test("validation accepts only offered budgets and defaults one when agent mode is on", () => {
    expect(validateAIOptions({ agent: true })).toMatchObject({ agent: true, agentBudgetMicros: 1_000_000, agentScope: "workspace" });
    expect(validateAIOptions({ agent: true, agentScope: "selected" }).agentScope).toBe("selected");
    expect(() => validateAIOptions({ agent: true, agentScope: "everything" })).toThrow("agent search scope");
    expect(validateAIOptions({ agent: true, agentBudgetMicros: 2_000_000 }).agentBudgetMicros).toBe(2_000_000);
    expect(validateAIOptions({ agent: false, agentBudgetMicros: 250_000 }).agent).toBeUndefined();
    expect(() => validateAIOptions({ agent: true, agentBudgetMicros: 123 })).toThrow("offered agent budgets");
    expect(() => validateAIOptions({ agent: "yes" })).toThrow("agent must be a boolean");
  });

  test("saved settings and receipts keep only well-formed agent fields", () => {
    expect(normalizeAISettings({ agent: true, agentBudgetMicros: 1_000_000 })).toMatchObject({ agent: true, agentBudgetMicros: 1_000_000 });
    expect(normalizeAISettings({ agent: "true", agentBudgetMicros: 7 })).not.toHaveProperty("agent");
    expect(normalizeAISettings({ agent: true, agentScope: "conversation" }).agentScope).toBe("conversation");
    expect(normalizeAISettings({ agent: true, agentScope: "everything" })).not.toHaveProperty("agentScope");
    const receipt = normalizeAIExecution({ schemaVersion: 1, model: "m", provider: "openai-api", agent: {
      stopReason: "nope", spentMicros: -1, budgetMicros: 500_000,
      steps: [{ kind: "tool", tool: "x", label: "Read" }, { kind: "evil", label: "x" }, { kind: "note", label: "" }],
    } });
    expect(receipt?.agent).toEqual({ steps: [{ kind: "tool", tool: "x", label: "Read", ok: true }], stopReason: "answered", budgetMicros: 500_000 });
    const thinking = normalizeAIExecution({ schemaVersion: 1, model: "m", provider: "anthropic-api", agent: {
      reasoning: "shared", steps: [{ kind: "thinking", label: "x".repeat(5_000) }, { kind: "thinking", label: "  " }],
    } })?.agent;
    expect(thinking?.reasoning).toBe("shared");
    expect(thinking?.steps).toEqual([{ kind: "thinking", label: "x".repeat(4_000), ok: true }]);
    expect(normalizeAIExecution({ schemaVersion: 1, model: "m", provider: "openai-api", agent: { reasoning: "maybe", steps: [] } })?.agent).not.toHaveProperty("reasoning");
  });
});
