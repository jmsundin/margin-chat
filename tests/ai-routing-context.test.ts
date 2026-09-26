import { afterEach, describe, expect, test } from "bun:test";
import { createChatService } from "../server/chat/index.mjs";
import { createOpenAIAgentToolExecutor } from "../server/chat/agentTools.mjs";
import { prepareChatContext, CONTEXT_CHARACTER_BUDGETS } from "../server/chat/context.mjs";
import { validateChatRequest } from "../server/chat/validation.mjs";
import { buildSystemInstruction } from "../server/chat/systemPrompt.mjs";
import { createChatExecutionService } from "../server/chat/execution.mjs";
import { createBillingService } from "../server/billing/index.mjs";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function payload(overrides: any = {}) {
  return {
    conversation: { id: "current", title: "Current chat", parentId: null, branchAnchor: null, ancestorContext: [], documents: [] },
    messages: [{ id: "question", role: "user", content: "Reply with OK." }],
    modelId: "smart-routing", serviceId: "backend-services", ...overrides,
  };
}
function service(overrides: any = {}) {
  return createChatService({
    // Exercise generation and rule fallback independently of the router API.
    autoRouter: async () => null,
    database: {}, env: { OPENAI_API_KEY: "test-openai", GEMINI_API_KEY: "test-gemini", HUGGINGFACE_API_KEY: "test-hf", XAI_API_KEY: "test-xai" },
    runtimeConfig: { defaultBackendProvider: "openai-api", openaiModel: "gpt-5.6", geminiModel: "gemini-3.1-pro-preview", huggingFaceModel: "openai/gpt-oss-120b", xaiModel: "grok-4.5" },
    ...overrides,
  });
}
function sse(events: unknown[]) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}
function mockReplies(calls: Array<{ url: string; body: any }>) {
  globalThis.fetch = (async (input, init) => {
    const url = String(input); const body = JSON.parse(String(init?.body)); calls.push({ url, body });
    if (url.includes("googleapis")) return Response.json({ candidates: [{ content: { parts: [{ text: "OK" }] } }] });
    if (url.includes("huggingface")) return Response.json({ model: body.model, choices: [{ message: { content: "OK" } }] });
    return Response.json({ model: `${body.model}-resolved`, output_text: "OK" });
  }) as typeof fetch;
}

describe("AI routing and execution receipts", () => {
  test("task and mode select distinct eligible routes, while manual selections remain exact", async () => {
    const calls: any[] = []; mockReplies(calls); const chat = service();
    const summary = await chat.requestReply(payload({ messages: [{ role: "user", content: "Summarize these notes." }] }));
    expect(summary.metadata.execution).toMatchObject({ provider: "gemini-api", task: "summary", mode: "balanced", model: "gemini-3.8-flash", schemaVersion: 1, status: "complete" });
    const coding = await chat.requestReply(payload({ ai: { mode: "fast" }, messages: [{ role: "user", content: "Debug this TypeScript code." }] }));
    expect(calls[1].body.model).toBe("gpt-6-luna");
    expect(coding.metadata.execution).toMatchObject({ provider: "openai-api", task: "coding", model: "gpt-6-luna-resolved" });
    expect(coding.metadata.execution.reason).toContain("heuristic");
    const manual = await chat.requestReply(payload({ serviceId: "openai-api", modelId: "gpt-5.6-terra", ai: { mode: "thorough" } }));
    expect(calls[2].body.model).toBe("gpt-5.6-terra");
    expect(manual.metadata.execution.reason).toBe("Used your selected provider and model.");
    expect(manual.metadata.execution.sources[0].id).toBe("current");
  });

  test("provider exclusions gate both model calls and embedding retrieval, including titles", async () => {
    const calls: any[] = []; mockReplies(calls); let retrievals = 0;
    const chat = service({ documentService: { async retrieveContext() { retrievals++; throw new Error("Must not call embeddings"); } } });
    const request = payload({ ai: { allowedProviders: ["gemini"] }, conversation: { ...payload().conversation, documents: [{ id: "doc", filename: "private.txt" }] } });
    const result = await chat.requestReply(request);
    expect(retrievals).toBe(0);
    expect(calls).toHaveLength(1); expect(calls[0].url).toContain("googleapis");
    expect(result.metadata.execution.warnings[0]).toContain("embedding provider is not allowed");
    await expect(chat.requestReply({ ...request, serviceId: "openai-api", modelId: "gpt-5.6" })).rejects.toMatchObject({ statusCode: 403 });
    await expect(chat.requestReply(payload({ ai: { allowedProviders: [] } }))).rejects.toThrow("No model provider");
    await chat.generateTitle({ prompt: "A new title", serviceId: "backend-services", modelId: "smart-routing", ai: { allowedProviders: ["gemini"] } });
    expect(calls).toHaveLength(2); expect(calls[1].url).toContain("googleapis");
  });

  test("billing planning and Auto execution keep the permitted personal credential pool", async () => {
    const calls: any[] = []; mockReplies(calls); const chat = service();
    const request = payload({ messages: [{ role: "user", content: "Summarize this." }] });
    const context = { apiKeys: { openai: "personal" }, allowHosted: true };
    expect(chat.getPlannedCredentialSource(request, context)).toBe("personal");
    const result = await chat.requestReply(request, context);
    expect(result.metadata).toMatchObject({ credentialSource: "personal", resolvedServiceId: "openai-api" });
    expect(calls).toHaveLength(1);
  });

  test("zero-credit members get funding guidance for configured hosted models, including manual replies and titles", async () => {
    const calls: any[] = []; mockReplies(calls);
    const chat = service();
    const execute = createChatExecutionService({
      apiKeyService: { async getDecryptedKeys() { return {}; } },
      billingService: {}, chatService: chat,
    });
    const user = { id: "unfunded", role: "member", billing: { hasAccess: false, creditBalanceMicros: 0 } };
    for (const serviceId of ["backend-services", "openai-api"]) {
      const modelId = serviceId === "backend-services" ? "smart-routing" : "gpt-5.6";
      const request = payload({ serviceId, modelId });
      await expect(execute({ payload: request, user })).rejects.toMatchObject({ statusCode: 402, message: expect.stringContaining("Add money in Billing or subscribe for $20/month") });
      await expect(execute({ payload: { prompt: "A new conversation", serviceId, modelId }, user, operation: "title" }))
        .rejects.toMatchObject({ statusCode: 402, message: expect.stringContaining("prepaid AI balance is empty") });
    }
    expect(calls).toHaveLength(0);
  });

  test("lack of credit never masks disabled provider settings or blocks personal credentials", async () => {
    const calls: any[] = []; mockReplies(calls);
    const chat = service({ env: { OPENAI_API_KEY: "test-openai" } });
    const context = { allowHosted: false, apiKeys: {} };
    for (const allowedProviders of [[], ["gemini"]]) {
      await expect(chat.requestReply(payload({ ai: { allowedProviders } }), context))
        .rejects.toThrow("No model provider is available within your AI provider settings");
    }
    await expect(chat.requestReply(payload({ serviceId: "openai-api", modelId: "gpt-5.6", ai: { allowedProviders: ["gemini"] } }), context))
      .rejects.toMatchObject({ statusCode: 403, message: expect.stringContaining("excluded by your AI provider settings") });
    expect(calls).toHaveLength(0);
    const reply = await chat.requestReply(payload(), { allowHosted: false, apiKeys: { openai: "personal" } });
    expect(reply.metadata.credentialSource).toBe("personal");
    expect(calls).toHaveLength(1);
  });

  test("fallback receipts identify failed attempts and no fallback occurs after a delta", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = String(input); urls.push(url);
      if (url.includes("openai")) return Response.json({ error: { message: "Unavailable" } }, { status: 503 });
      return sse([{ candidates: [{ content: { parts: [{ text: "Fallback" }] } }] }]);
    }) as typeof fetch;
    const result = await service().requestReplyStream(payload());
    expect(result.metadata.execution.fallbacks).toEqual([expect.objectContaining({ provider: "openai-api", model: "gpt-5.6", reason: expect.stringContaining("503") })]);
    expect(result.metadata.execution.provider).toBe("gemini-api");
    urls.length = 0;
    globalThis.fetch = (async (input) => { urls.push(String(input)); return sse([
      { type: "response.output_text.delta", delta: "Partial" },
      { type: "response.failed", response: { error: { message: "failed after output" } } },
    ]); }) as typeof fetch;
    const deltas: string[] = [];
    await expect(service().requestReplyStream(payload(), {}, { onDelta: (delta: string) => deltas.push(delta) })).rejects.toThrow("failed after output");
    expect(urls).toHaveLength(1); expect(deltas).toEqual(["Partial"]);
  });

  test("cancellation before any output does not trigger another provider", async () => {
    const controller = new AbortController(); let calls = 0;
    globalThis.fetch = (async () => { calls++; controller.abort(); throw new DOMException("Canceled", "AbortError"); }) as typeof fetch;
    await expect(service().requestReplyStream(payload(), { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
  });

  test("hosted chat caps prepared context instead of rejecting a large local snapshot", async () => {
    const bodies: any[] = [];
    globalThis.fetch = (async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return sse([{ type: "response.output_text.delta", delta: "OK" }, { type: "response.completed", response: { model: "resolved", output: [] } }]);
    }) as typeof fetch;
    const reservations: any[] = [];
    const settlements: any[] = [];
    const database = {
      async chargeHostedRequest(args: any) { reservations.push(args); return 1_000_000; },
      async settleHostedRequest(args: any) { settlements.push(args); return { settled: true }; },
    };
    const billingService = createBillingService({ database, env: { HOSTED_MAX_INPUT_CHARACTERS: "60000" } });
    const request = payload({ ai: { mode: "thorough" }, messages: [
      { role: "assistant", content: "Long prior conversation. ".repeat(10_000) },
      { role: "user", content: "The current question" },
    ] });
    expect(() => billingService.getHostedUsageLimits(request)).toThrow("hosted request is too large");
    const execute = createChatExecutionService({
      apiKeyService: { async getDecryptedKeys() { return {}; } }, billingService,
      chatService: service({ env: { OPENAI_API_KEY: "test-openai", HOSTED_MODEL_PRICES_JSON: JSON.stringify({
        "openai:gpt-5.6": { inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 2_000_000 },
      }) } }),
    });
    const result = await execute({ payload: request, user: { id: "owner", billing: { hasAccess: true, accessKind: "subscription" } } });
    expect(bodies).toHaveLength(1);
    expect(reservations).toHaveLength(1);
    expect(settlements).toHaveLength(1);
    expect(settlements[0].requestId).toBe(reservations[0].requestId);
    expect(JSON.stringify({ instructions: bodies[0].instructions, input: bodies[0].input }).length).toBeLessThanOrEqual(60_000);
    expect(result.metadata.execution).toMatchObject({ mode: "thorough", truncated: true });
    expect(result.metadata.execution.warnings.join(" ")).toContain("Hosted access limits this request to 60,000");
  });
});

describe("shared permitted context", () => {
  test("all providers receive an unanchored child's ancestors and only explicitly selected workspace items", async () => {
    const calls: any[] = []; mockReplies(calls);
    const ancestor = { id: "ancestor", title: "Parent", messages: [{ role: "user", content: "Ancestor history without a text anchor" }] };
    const request = payload({
      ai: { contextScope: "selected", selectedConversationIds: ["selected"] },
      conversation: { ...payload().conversation, parentId: "ancestor", ancestorContext: [ancestor] },
      workspaceContext: [
        { id: "selected", title: "Selected note", content: "Fresh unsaved body", messages: [], notes: [{ kind: "comment", content: "PRIVATE MARGIN SECRET" }] },
        { id: "excluded", title: "Outside scope", messages: [{ role: "user", content: "OUTSIDE SECRET" }] },
      ],
    });
    for (const [serviceId, modelId] of [["openai-api", "gpt-5.6"], ["gemini-api", "gemini-3.5-flash"], ["xai-api", "grok-4.5"], ["huggingface-api", "openai/gpt-oss-120b"]]) {
      const result = await service().requestReply({ ...request, serviceId, modelId });
      expect(result.metadata.execution.sources.map((source: any) => source.id)).toEqual(["current", "ancestor", "selected"]);
    }
    for (const call of calls) {
      const body = JSON.stringify(call.body);
      expect(body).toContain("Ancestor history without a text anchor"); expect(body).toContain("Fresh unsaved body");
      expect(body).not.toContain("PRIVATE MARGIN SECRET"); expect(body).not.toContain("OUTSIDE SECRET");
    }
  });

  test("Agent tools never query saved workspace or search private annotations", async () => {
    let reads = 0;
    const raw = payload({ workspaceContext: [{ id: "other", title: "Other", messages: [{ role: "user", content: "Not permitted" }] }] });
    const execute = createOpenAIAgentToolExecutor({ chatRequest: raw, database: { async loadState() { reads++; return { conversations: {} }; } }, userId: "owner" });
    expect(await execute("get_conversation", { conversation_id: "other" })).toMatchObject({ found: false });
    const selected = createOpenAIAgentToolExecutor({ chatRequest: { ...raw,
      ai: { contextScope: "selected", selectedConversationIds: ["other"] },
      workspaceContext: [{ id: "other", title: "Other", content: "Local primary note", messages: [], notes: [{ kind: "comment", content: "annotationsecret" }] }],
    } });
    expect(await selected("get_conversation", { conversation_id: "other" })).toMatchObject({ found: true, conversation: { messages: [{ content: "Local primary note" }] } });
    expect(await selected("search_conversations", { query: "annotationsecret" })).toMatchObject({ total_matches: 0 });
    expect(reads).toBe(0);
  });

  test("budgets retain the latest question, expose omissions, and never silently clip an oversized question", () => {
    const request = validateChatRequest(payload({ ai: { mode: "fast" }, workspaceContextTruncated: true,
      messages: [{ role: "assistant", content: "Older history ".repeat(10_000) }, { role: "user", content: "LATEST QUESTION" }],
    }));
    const prepared = prepareChatContext(request);
    expect(prepared.chatRequest.messages.at(-1).content).toBe("LATEST QUESTION");
    expect(prepared.truncated).toBe(true);
    expect(prepared.warnings.join(" ")).toContain("24,000-character budget");
    const sent = buildSystemInstruction(prepared.chatRequest) + JSON.stringify(prepared.chatRequest.messages);
    expect(sent.length).toBeLessThan(CONTEXT_CHARACTER_BUDGETS.fast);
    expect(() => prepareChatContext(validateChatRequest(payload({ ai: { mode: "fast" }, messages: [{ role: "user", content: "x".repeat(25_000) }] })))).toThrow("latest message exceeds");
  });
});
