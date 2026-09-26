import { describe, expect, test } from "bun:test";
import { createChatAnalyzer } from "../server/semantic/chatAnalysis.mjs";
import { applySemanticRouting, createSemanticRouteCandidates, planRoutes } from "../server/chat/routing.mjs";
import { getModelRoutingEvidence } from "../server/chat/modelRoutingEvidence.mjs";

const services = ["openai-api", "gemini-api", "huggingface-api", "xai-api"];
function request(overrides: any = {}) {
  return {
    serviceId: "backend-services", modelId: "smart-routing",
    ai: { jevEnabled: true, mode: "balanced", contextScope: "selected", selectedConversationIds: ["note"] },
    conversation: { id: "chat", title: "Current task", ancestorContext: [] },
    messages: [{ role: "user", content: "Compare the current options against our constraints." }],
    workspaceContext: [{ id: "note", title: "Constraints", content: "The response must handle interacting constraints.", messages: [] }],
    ...overrides,
  };
}
function planned(chatRequest = request(), allowed = services, runtime = {}) {
  const routes = planRoutes(chatRequest, allowed, runtime);
  return { routes, candidates: createSemanticRouteCandidates(chatRequest, routes, runtime) };
}
const demanding = { complexity: { score: 2.8, confidence: 0.9 } };

describe("independent chat judgments and evidence", () => {
  test("batches task, route, complexity, freshness and context with self-contained questions", async () => {
    const calls: any[] = [];
    const chat = request();
    const { candidates } = planned(chat);
    const analyze = createChatAnalyzer({
      evaluate: async (args: any) => {
        calls.push(args);
        return { answers: {
          task: { type: "choice", choice: "research", confidence: 0.9 },
          route: { type: "choice", choice: "keep_default", confidence: 0.9 },
          complexity: { type: "score", score: 2.8, confidence: 0.8 },
          needsCurrentInformation: { type: "noul", noul: 0.93 },
          context_0: { type: "score", score: 2.6, confidence: 0.9 },
        } };
      },
      answerFor: (result: any, id: string) => result.answers[id] ?? null,
    });
    const result = await analyze({ chatRequest: chat, routes: candidates, userId: "test-user" });
    expect(calls).toHaveLength(1);
    const body = calls[0];
    expect(Object.keys(body.questions)).toEqual(["task", "route", "complexity", "needsCurrentInformation", "context_0"]);
    expect(body.questions.complexity.type).toBe("score");
    expect(body.questions.complexity.criteria).toHaveLength(4);
    expect(body.questions.needsCurrentInformation.type).toBe("noul");
    expect(body.questions.needsCurrentInformation.criteria).toHaveProperty("true");
    expect(body.state.adapterCapabilities.liveWebSearch).toBe(false);
    expect(body.state.modelOptions).toHaveLength(candidates.length);
    expect(body.state.modelOptions.every((option: any) => option.evidence.summary && option.evidence.preference)).toBe(true);
    expect(body.questions.route.criteria[candidates[0].key]).toContain("modelOptions[0]");
    for (const definition of Object.values(body.questions) as any[]) {
      expect(definition.instructions).not.toMatch(/answers\.|task answer|complexity answer|previous answer/i);
    }
    expect(result).toMatchObject({ task: "research", contextOrder: ["note"],
      signals: { complexity: { score: 2.8, confidence: 0.8 }, needsCurrentInformation: 0.93 } });
    expect(result).not.toHaveProperty("routeKey");
    expect(result.keepDefault).toBe(true);
  });

  test("manual choices keep context-only questions and disabled assistance makes no request", async () => {
    const calls: any[] = [];
    const analyze = createChatAnalyzer({
      evaluate: async (args: any) => { calls.push(args); return { answers: {} }; },
      answerFor: () => null,
    });
    await analyze({ chatRequest: request({ serviceId: "openai-api", modelId: "gpt-5.6" }), userId: "test-user" });
    expect(Object.keys(calls[0].questions)).toEqual(["context_0"]);
    expect(calls[0].state).not.toHaveProperty("modelOptions");
    expect(await analyze({ chatRequest: request({ ai: { jevEnabled: false } }), userId: "test-user" })).toBeNull();
    expect(calls).toHaveLength(1);
  });

  test("judgment metrics report accepted confidence-filtered answers without private content", async () => {
    const metrics: any[] = [];
    const { candidates } = planned();
    const answers = {
      task: { type: "choice", choice: "research", confidence: 0.2 },
      route: { type: "choice", choice: "keep_default", confidence: 0.9 },
      complexity: { type: "score", score: 2.8, confidence: 0.8 },
      needsCurrentInformation: { type: "noul", noul: 0.93 },
      context_0: { type: "score", score: 2.6, confidence: 0.9 },
    };
    const analyze = createChatAnalyzer({
      evaluate: async () => ({ answers }),
      answerFor: (result: any, id: string, _definition: any, minimum = 0.55) => {
        const answer = result.answers[id];
        return answer?.type === "noul" || answer?.confidence >= minimum ? answer : null;
      },
      onMetric: (metric: any) => metrics.push(metric),
    });
    const result = await analyze({ chatRequest: request(), routes: candidates, userId: "private-user" });
    expect(result).not.toHaveProperty("task");
    expect(result.warnings).toEqual([]);
    expect(metrics).toEqual([{ event: "jev_evaluation", operation: "chat", stage: "judgment",
      status: "partial", acceptedJudgmentCount: 4, rejectedJudgmentCount: 1, fallback: false }]);
    answers.route.confidence = 0.1;
    expect((await analyze({ chatRequest: request(), routes: candidates, userId: "private-user" })).warnings)
      .toEqual(["Some Jev judgments were unavailable or uncertain; their standard behavior was retained."]);
    expect(metrics[1]).toEqual({ event: "jev_evaluation", operation: "chat", stage: "judgment",
      status: "partial", acceptedJudgmentCount: 3, rejectedJudgmentCount: 2, fallback: true });
    answers.task.confidence = 0.9;
    answers.route.confidence = 0.9;
    expect((await analyze({ chatRequest: request(), routes: candidates, userId: "private-user" })).warnings).toEqual([]);
    expect(metrics[2]).toEqual({ event: "jev_evaluation", operation: "chat", stage: "judgment",
      status: "success", acceptedJudgmentCount: 5, rejectedJudgmentCount: 0, fallback: false });
  });

  test("rejected optional signals do not warn on an accepted keep_default or manual choice", async () => {
    const metrics: any[] = [];
    const analyze = createChatAnalyzer({
      evaluate: async () => ({ answers: {
        route: { type: "choice", choice: "keep_default", confidence: 0.9 },
        context_0: { type: "score", score: 2.4, confidence: 0.9 },
      } }),
      answerFor: (result: any, id: string) => result.answers[id] ?? null,
      onMetric: (metric: any) => metrics.push(metric),
    });
    expect((await analyze({ chatRequest: request(), routes: planned().candidates })).warnings).toEqual([]);
    expect(metrics[0]).toMatchObject({ status: "partial", fallback: false, rejectedJudgmentCount: 3 });
    expect((await analyze({ chatRequest: request({ serviceId: "openai-api", modelId: "gpt-5.6" }) })).warnings).toEqual([]);
    expect(metrics[1]).toMatchObject({ status: "success", fallback: false, rejectedJudgmentCount: 0 });
  });

  test("unavailable evaluations report judgment fallback and diagnostic failures are harmless", async () => {
    const metrics: any[] = [];
    const analyze = createChatAnalyzer({
      evaluate: async () => ({ warning: "Jev is unavailable." }),
      answerFor: () => null,
      onMetric: (metric: any) => { metrics.push(metric); throw new Error("Diagnostics offline"); },
    });
    expect(await analyze({ chatRequest: request(), routes: [], userId: "private-user" }))
      .toEqual({ warnings: ["Jev is unavailable."] });
    expect(metrics).toEqual([{ event: "jev_evaluation", operation: "chat", stage: "judgment",
      status: "partial", acceptedJudgmentCount: 0, rejectedJudgmentCount: 4, fallback: true }]);
  });

  test("catalog evidence distinguishes roles without invented numeric rankings or unknown-model claims", () => {
    expect(getModelRoutingEvidence("openai-api", "gpt-6-astra")).toMatchObject({ basis: "reviewed-catalog", preference: "demanding" });
    expect(getModelRoutingEvidence("openai-api", "gpt-6-sol")).toMatchObject({ preference: "general" });
    for (const [provider, model] of [["openai-api", "private-model"], ["gemini-api", "gpt-6-astra"]]) {
      expect(getModelRoutingEvidence(provider, model)).toMatchObject({ basis: "configured-only", preference: "unknown" });
      expect(getModelRoutingEvidence(provider, model)).not.toHaveProperty("source");
    }
    expect(getModelRoutingEvidence("xai-api", "grok-4.6")).not.toHaveProperty("qualityScore");
    expect(getModelRoutingEvidence("xai-api", "grok-4.6")).not.toHaveProperty("latencyMs");
  });
});

describe("signal-aware routing policy", () => {
  test("an accepted default deferral without task classification is explained truthfully", async () => {
    const chat = request();
    const { routes, candidates } = planned(chat);
    const analyze = createChatAnalyzer({
      evaluate: async () => ({ answers: { route: { type: "choice", choice: "keep_default", confidence: 0.9 } } }),
      answerFor: (result: any, id: string) => result.answers[id] ?? null,
    });
    const analysis = await analyze({ chatRequest: chat, routes: candidates });
    expect(analysis.keepDefault).toBe(true);
    expect(analysis).not.toHaveProperty("task");
    const result = applySemanticRouting(chat, routes, {}, analysis, candidates);
    expect(result[0].routing.method).toBe("rules");
    expect(result[0].reason).toContain("Jev kept the configured routing preference.");
    expect(result[0].reason).not.toContain("did not provide a usable routing decision");
    expect(result.map((route: any) => [route.serviceId, route.model]))
      .toEqual(routes.map((route: any) => [route.serviceId, route.model]));
    expect(applySemanticRouting(chat, routes, {}, {}, candidates)[0].reason)
      .toContain("Jev did not provide a usable routing decision.");
  });

  test("demanding work can prefer a reviewed model within the existing provider candidates", () => {
    const chat = request({ messages: [{ role: "user", content: "Summarize these options." }] });
    const { routes, candidates } = planned(chat, ["openai-api"]);
    expect(routes[0].model).toBe("gpt-6-sol");
    const result = applySemanticRouting(chat, routes, {}, { task: "summary", signals: demanding }, candidates);
    expect(result[0]).toMatchObject({ serviceId: "openai-api", model: "gpt-6-astra", routing: { method: "jev-task", selectedModel: "gpt-6-astra" } });
    expect(result[0].reason).toContain("complex-work preference");
    expect(result[0].reason).not.toContain("Jev selected");
    expect(result[0].reason).not.toContain("(gpt-6-sol)");
  });

  test("signals never override an explicit Jev choice, a manual choice, or Fast mode", () => {
    const chat = request();
    const { routes, candidates } = planned(chat);
    const explicit = applySemanticRouting(chat, routes, {}, { routeKey: "openai-api:gpt-6-sol", signals: demanding }, candidates);
    expect(explicit[0]).toMatchObject({ model: "gpt-6-sol", routing: { method: "jev" } });
    const manual = request({ serviceId: "openai-api", modelId: "gpt-5.6-luna" });
    const manualPlan = planned(manual);
    expect(applySemanticRouting(manual, manualPlan.routes, {}, { signals: demanding }, manualPlan.candidates)[0])
      .toMatchObject({ model: "gpt-5.6-luna", routing: { method: "manual" } });
    const fast = request({ ai: { jevEnabled: true, mode: "fast" } });
    const fastPlan = planned(fast);
    expect(applySemanticRouting(fast, fastPlan.routes, {}, { signals: demanding }, fastPlan.candidates).map((route: any) => route.model))
      .toEqual(fastPlan.routes.map((route: any) => route.model));
  });

  test("uncertain and invalid signals do not change route choice or invent a signal rationale", () => {
    const chat = request();
    const { routes, candidates } = planned(chat);
    for (const signals of [
      { complexity: { score: 2.8, confidence: 0.2 }, needsCurrentInformation: 0.5 },
      { complexity: { score: 99, confidence: 1 }, needsCurrentInformation: 2 },
      { complexity: { score: "3", confidence: 1 }, needsCurrentInformation: "0.9" },
    ]) {
      const result = applySemanticRouting(chat, routes, {}, { signals }, candidates);
      expect(result.map((route: any) => route.model)).toEqual(routes.map((route: any) => route.model));
      expect(result[0].reason).not.toContain("assessed demanding");
      expect(result[0].reason).not.toContain("current external information");
    }
  });

  test("a freshness signal discloses the limitation without creating browsing or a new provider", () => {
    const chat = request({ ai: { jevEnabled: true, mode: "balanced", allowedProviders: ["openai"] } });
    const { routes, candidates } = planned(chat, ["openai-api"]);
    const result = applySemanticRouting(chat, routes, {}, { signals: { needsCurrentInformation: 0.95 } }, candidates);
    expect(result.map((route: any) => [route.serviceId, route.model])).toEqual(routes.map((route: any) => [route.serviceId, route.model]));
    expect(result[0].reason).toContain("does not perform live web search");
    expect(result[0]).not.toHaveProperty("tools");
  });

  test("legacy configured models without reviewed evidence remain conservative", () => {
    const chat = request();
    const runtime = { huggingFaceModel: "openai/gpt-oss-120b" };
    const { routes, candidates } = planned(chat, ["huggingface-api"], runtime);
    const result = applySemanticRouting(chat, routes, runtime, { signals: demanding }, candidates);
    expect(result[0].model).toBe("openai/gpt-oss-120b");
    expect(result[0].reason).toContain("existing model and speed preference were retained");
  });
});
