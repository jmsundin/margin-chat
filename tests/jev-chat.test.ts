import { afterEach, describe, expect, test } from "bun:test";
import { createChatService } from "../server/chat/index.mjs";
import { prepareChatContext } from "../server/chat/context.mjs";
import { validateChatRequest } from "../server/chat/validation.mjs";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function payload(overrides: any = {}) {
  return {
    conversation: { id: "current", title: "Current", parentId: null, branchAnchor: null, ancestorContext: [], documents: [] },
    messages: [{ id: "question", role: "user", content: "Help me with this." }],
    modelId: "smart-routing", serviceId: "backend-services", ai: { jevEnabled: true }, ...overrides,
  };
}

function service(semanticService: any, overrides: any = {}) {
  return createChatService({
    database: {}, env: { OPENAI_API_KEY: "hosted-openai", GEMINI_API_KEY: "hosted-gemini", HUGGINGFACE_API_KEY: "hosted-hf" },
    runtimeConfig: { defaultBackendProvider: "openai-api", openaiModel: "gpt-5.6", geminiModel: "gemini-3.1-pro-preview", huggingFaceModel: "openai/gpt-oss-120b" },
    semanticService, ...overrides,
  });
}

function mockReplies(calls: any[]) {
  globalThis.fetch = (async (input, init) => {
    const url = String(input); const body = JSON.parse(String(init?.body)); calls.push({ url, body });
    if (url.includes("googleapis")) return Response.json({ candidates: [{ content: { parts: [{ text: "OK" }] } }] });
    return Response.json({ model: body.model, output_text: "OK" });
  }) as typeof fetch;
}

describe("Jev chat orchestration", () => {
  test("runs once per enabled reply and never during billing preflight or title generation", async () => {
    const calls: any[] = []; mockReplies(calls); const analyses: any[] = [];
    const chat = service({ async analyzeChat(input: any) { analyses.push(input); return { task: "summary", routeKey: "gemini-api:gemini-3.8-flash" }; } });
    expect(chat.getPlannedCredentialSource(payload())).toBe("hosted");
    await chat.generateTitle({ prompt: "A short title", serviceId: "backend-services", modelId: "smart-routing", ai: { jevEnabled: true } });
    await chat.requestReply(payload({ ai: {} }));
    expect(analyses).toHaveLength(0);
    const result = await chat.requestReply(payload());
    expect(analyses).toHaveLength(1);
    expect(analyses[0].routes).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "gemini-api:gemini-3.8-flash", tasks: ["summary"] }),
      expect.objectContaining({ key: "huggingface-api:zai-org/GLM-5.3", tasks: ["coding"] }),
    ]));
    expect(result.metadata.execution).toMatchObject({ task: "summary", provider: "gemini-api", model: "gemini-3.8-flash",
      routing: { method: "jev", selectedModel: "gemini-3.8-flash" } });
    expect(result.metadata.execution.reason).toContain("Jev selected");
    expect(result.metadata.execution.reason).toContain("balanced profile assigns this model to summary tasks");
    expect(calls).toHaveLength(3);
  });

  test("manual model selections are exact while classification still updates the receipt", async () => {
    const calls: any[] = []; mockReplies(calls);
    const chat = service({ async analyzeChat({ routes }: any) {
      expect(routes).toEqual([]);
      return { task: "research", routeKey: "gemini-api:gemini-3.8-flash" };
    } });
    const result = await chat.requestReply(payload({ serviceId: "openai-api", modelId: "gpt-5.6-terra" }));
    expect(calls[0].body.model).toBe("gpt-5.6-terra");
    expect(result.metadata.execution).toMatchObject({ task: "research", provider: "openai-api",
      routing: { method: "manual", selectedModel: "gpt-5.6-terra" } });
    expect(result.metadata.execution.reason).toContain("Used your selected provider and model.");
  });

  test("semantic choices cannot escape permitted providers, supported models, or the personal credential pool", async () => {
    const calls: any[] = []; mockReplies(calls); const pools: string[][] = [];
    const chat = service({ async analyzeChat({ routes }: any) {
      pools.push(routes.map((route: any) => route.serviceId));
      return { task: "not-a-task", routeKey: "gemini-api:unconfigured-model" };
    } });
    const personal = await chat.requestReply(payload(), { apiKeys: { openai: "personal-openai" }, allowHosted: true });
    expect(new Set(pools[0])).toEqual(new Set(["openai-api"]));
    expect(personal.metadata).toMatchObject({ credentialSource: "personal", resolvedServiceId: "openai-api" });
    expect(personal.metadata.execution.task).toBe("general");
    expect(personal.metadata.execution.routing).toEqual({ method: "rules", selectedModel: "gpt-5.6" });
    expect(personal.metadata.execution.reason).toContain("Jev did not provide a usable routing decision");
    await chat.requestReply(payload({ ai: { jevEnabled: true, allowedProviders: ["openai"] } }));
    expect(new Set(pools[1])).toEqual(new Set(["openai-api"]));
    expect(calls.map((call) => call.body.model)).toEqual(["gpt-5.6", "gpt-5.6"]);
  });

  test("reranks before final packing without exposing excluded items or margin comments", async () => {
    const calls: any[] = []; mockReplies(calls);
    const ids = ["first", "second", "third", "fourth", "fifth", "target"];
    const request = payload({
      ai: { jevEnabled: true, mode: "fast", contextScope: "selected", selectedConversationIds: ids },
      workspaceContext: [
        ...ids.map((id) => ({ id, title: id, content: id === "target" ? "RELEVANT LATE SOURCE" : `${id} `.repeat(3_000), messages: [], notes: [{ content: "PRIVATE MARGIN SECRET" }] })),
        { id: "excluded", title: "Excluded", content: "OUTSIDE SCOPE SECRET", messages: [] },
      ],
    });
    expect(prepareChatContext(validateChatRequest(request)).sources.map((source: any) => source.id)).not.toContain("target");
    const chat = service({ async analyzeChat({ chatRequest }: any) {
      expect(chatRequest.workspaceContext.map((item: any) => item.id)).toEqual(ids);
      expect(chatRequest.workspaceContext.every((item: any) => item.content.length <= 1_200)).toBe(true);
      expect(JSON.stringify(chatRequest)).not.toContain("PRIVATE MARGIN SECRET");
      expect(JSON.stringify(chatRequest)).not.toContain("OUTSIDE SCOPE SECRET");
      return { contextOrder: ["excluded", "target", "target", 1] };
    } });
    const result = await chat.requestReply(request);
    expect(result.metadata.execution.sources.map((source: any) => source.id).slice(0, 4)).toEqual(["current", "target", "first", "second"]);
    expect(JSON.stringify(calls[0].body)).toContain("RELEVANT LATE SOURCE");
    expect(JSON.stringify(calls[0].body)).not.toContain("OUTSIDE SCOPE SECRET");
    expect(JSON.stringify(calls[0].body)).not.toContain("PRIVATE MARGIN SECRET");
    expect(result.metadata.execution.truncated).toBe(true);
  });

  test("conversation scope supplies no workspace candidates to Jev", async () => {
    const calls: any[] = []; mockReplies(calls);
    const chat = service({ async analyzeChat({ chatRequest }: any) {
      expect(chatRequest.workspaceContext).toEqual([]);
      return { contextOrder: ["outside"] };
    } });
    const result = await chat.requestReply(payload({ workspaceContext: [{ id: "outside", title: "Outside", content: "PRIVATE", messages: [] }] }));
    expect(result.metadata.execution.sources.map((source: any) => source.id)).toEqual(["current"]);
  });

  test("unavailable semantic analysis falls back, but user cancellation prevents generation", async () => {
    const calls: any[] = []; mockReplies(calls);
    const unavailable = service({ async analyzeChat() { throw new Error("PRIVATE PROVIDER RESPONSE"); } });
    const result = await unavailable.requestReply(payload());
    expect(result.metadata.execution).toMatchObject({ task: "general", provider: "openai-api",
      routing: { method: "rules", selectedModel: "gpt-5.6" } });
    expect(result.metadata.execution.reason).toContain("Jev was unavailable. Routing rules selected OpenAI");
    expect(result.metadata.execution.warnings.join(" ")).toContain("Jev is unavailable");
    expect(JSON.stringify(result)).not.toContain("PRIVATE PROVIDER RESPONSE");
    const controller = new AbortController();
    const cancelled = service({ async analyzeChat() { controller.abort(); throw new Error("cancelled"); } });
    await expect(cancelled.requestReply(payload(), { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toHaveLength(1);
  });

  test("provider fallback reuses semantic analysis and attempts each eligible provider only once", async () => {
    let analyses = 0; const urls: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input); urls.push(url);
      if (url.includes("googleapis")) return Response.json({ error: { message: "Unavailable" } }, { status: 503 });
      const body = JSON.parse(String(init?.body));
      return Response.json({ model: body.model, output_text: "OK" });
    }) as typeof fetch;
    const chat = service({ async analyzeChat() { analyses++; return { task: "summary", routeKey: "gemini-api:gemini-3.8-flash" }; } });
    const result = await chat.requestReply(payload());
    expect(analyses).toBe(1);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("googleapis");
    expect(urls[1]).toContain("openai");
    expect(result.metadata.execution).toMatchObject({ provider: "openai-api", model: "gpt-5.6-terra",
      routing: { method: "jev-task", selectedModel: "gpt-5.6-terra" } });
    expect(result.metadata.execution.reason).toContain("Gemini (gemini-3.8-flash) request failed");
    expect(result.metadata.execution.reason).toContain("Routing rules selected OpenAI");
    expect(result.metadata.execution.reason).not.toContain("Jev selected");
    expect(result.metadata.execution.fallbacks).toEqual([expect.objectContaining({ provider: "gemini-api", model: "gemini-3.8-flash" })]);
  });

  test("a task-only judgment explains that rules chose the model", async () => {
    const calls: any[] = []; mockReplies(calls);
    const chat = service({ async analyzeChat() { return { task: "summary" }; } });
    const result = await chat.requestReply(payload());
    expect(result.metadata.execution).toMatchObject({ provider: "gemini-api", task: "summary",
      routing: { method: "jev-task", selectedModel: "gemini-3.8-flash" } });
    expect(result.metadata.execution.reason).toContain("Jev classified this request as summary. Routing rules selected Gemini");
    expect(result.metadata.execution.reason).not.toContain("Jev selected");
  });

  test("deferred decisions and disabled assistance explicitly use routing rules", async () => {
    const calls: any[] = []; mockReplies(calls); let analyses = 0;
    const chat = service({ async analyzeChat() { analyses++; return { contextOrder: [], warnings: [] }; } });
    const deferred = await chat.requestReply(payload());
    expect(deferred.metadata.execution.routing.method).toBe("rules");
    expect(deferred.metadata.execution.reason).toContain("Jev did not provide a usable routing decision. Routing rules selected OpenAI");
    const disabled = await chat.requestReply(payload({ ai: { jevEnabled: false } }));
    expect(disabled.metadata.execution.routing.method).toBe("rules");
    expect(disabled.metadata.execution.reason).toStartWith("Routing rules selected OpenAI");
    expect(disabled.metadata.execution.reason).not.toContain("Jev");
    expect(analyses).toBe(1);
  });

  test("a selected candidate is never described as a task profile it does not have", async () => {
    const calls: any[] = []; mockReplies(calls);
    const chat = service({ async analyzeChat() {
      return { task: "coding", routeKey: "openai-api:gpt-5.6-terra", reason: "PRIVATE GENERATED RATIONALE" };
    } });
    const result = await chat.requestReply(payload());
    expect(result.metadata.execution).toMatchObject({ task: "coding", routing: { method: "jev", selectedModel: "gpt-5.6-terra" } });
    expect(result.metadata.execution.reason).toContain("Jev classified the request as coding");
    expect(result.metadata.execution.reason).toContain("configured candidate in balanced mode");
    expect(result.metadata.execution.reason).not.toContain("assigns this model to coding");
    expect(JSON.stringify(result.metadata)).not.toContain("PRIVATE GENERATED RATIONALE");
  });

  test("streaming and completion preserve the chosen model when the provider resolves an alias", async () => {
    let analyses = 0; const ready: any[] = []; const deltas: string[] = [];
    globalThis.fetch = (async () => new Response([
      { type: "response.output_text.delta", delta: "OK" },
      { type: "response.completed", response: { model: "gpt-5.6-terra-2026-09-19", output: [] } },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } })) as typeof fetch;
    const chat = service({ async analyzeChat() { analyses++; return { task: "summary", routeKey: "openai-api:gpt-5.6-terra" }; } });
    const result = await chat.requestReplyStream(payload(), {}, { onReady: (metadata: any) => ready.push(metadata), onDelta: (delta: string) => deltas.push(delta) });
    expect(ready).toHaveLength(1);
    expect(ready[0].execution).toMatchObject({ status: "streaming", provider: "openai-api", model: "gpt-5.6-terra",
      routing: { method: "jev", selectedModel: "gpt-5.6-terra" } });
    expect(result.metadata.execution).toMatchObject({ status: "complete", provider: "openai-api", model: "gpt-5.6-terra-2026-09-19",
      routing: { method: "jev", selectedModel: "gpt-5.6-terra" } });
    expect(result.metadata.execution.reason).toBe(ready[0].execution.reason);
    expect(deltas).toEqual(["OK"]);
    expect(analyses).toBe(1);
  });

  test("a failed Jev choice without a classification falls back using rules in both receipts", async () => {
    const ready: any[] = []; let analyses = 0;
    globalThis.fetch = (async (input) => {
      if (String(input).includes("googleapis")) return Response.json({ error: { message: "Unavailable" } }, { status: 503 });
      return new Response([
        { type: "response.output_text.delta", delta: "OK" },
        { type: "response.completed", response: { model: "gpt-5.6-resolved", output: [] } },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;
    const chat = service({ async analyzeChat() { analyses++; return { routeKey: "gemini-api:gemini-3.8-flash" }; } });
    const result = await chat.requestReplyStream(payload(), {}, { onReady: (metadata: any) => ready.push(metadata) });
    expect(ready).toHaveLength(1);
    for (const receipt of [ready[0].execution, result.metadata.execution]) {
      expect(receipt).toMatchObject({ provider: "openai-api", task: "general", routing: { method: "rules", selectedModel: "gpt-5.6" } });
      expect(receipt.reason).toContain("Gemini (gemini-3.8-flash) request failed");
      expect(receipt.reason).toContain("Routing rules selected OpenAI");
      expect(receipt.reason).not.toContain("Jev selected");
    }
    expect(analyses).toBe(1);
  });
});
