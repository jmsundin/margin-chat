import { describe, expect, test } from "bun:test";
import { answerFor, sanitizeAnswers } from "../server/semantic/answers.mjs";
import { createSemanticEvaluator } from "../server/semantic/evaluator.mjs";
import { fitsEvaluationBudget, measureEvaluationBudget } from "../server/semantic/budget.mjs";

const questions = {
  task: { type: "choice", instructions: "Choose", criteria: { coding: "Code", general: "Other" } },
  relevance: { type: "score", instructions: "Useful?", criteria: ["No", "Some", "Direct"] },
  freshness: { type: "noul", instructions: "Needs current information?" },
};
const validAnswers = () => ({
  task: { type: "choice", choice: "coding", confidence: 0.9, probabilities: { coding: 0.95, general: 0.05 } },
  relevance: { type: "score", score: 1.9, confidence: 0.8, probabilities: { 0: 0, 1: 0.1, 2: 0.9 } },
  freshness: { type: "noul", noul: 0.8 },
});
const response = (answers: unknown = validAnswers()) => Response.json({ model: "jev-1.13.0", answers, usage: { input_tokens: 100, output_tokens: 0 } });
const request = (extra: any = {}) => ({ state: { request: "PRIVATE CONTENT" }, questions, userId: "PRIVATE USER", operation: "chat", ...extra });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("Jev typed answers", () => {
  test("Noul validates its probability without requiring or retaining confidence", () => {
    const data = { answers: { freshness: { type: "noul", noul: 0.5, confidence: "not applicable", secret: "PRIVATE" } } };
    expect(answerFor(data, "freshness", questions.freshness, 0.99)).not.toBeNull();
    expect(sanitizeAnswers(data, questions)).toEqual({ freshness: { type: "noul", noul: 0.5 } });
    for (const noul of [-1, 1.01, NaN, Infinity, "0.8", null]) {
      expect(answerFor({ answers: { freshness: { type: "noul", noul } } }, "freshness", questions.freshness)).toBeNull();
    }
  });

  test("retains only bounded, known numeric distributions and rejects malformed answers independently", () => {
    const answers: any = validAnswers();
    answers.task.probabilities.secret = "PRIVATE";
    answers.task.secret = "PRIVATE";
    answers.relevance.score = 3;
    const clean = sanitizeAnswers({ answers }, questions);
    expect(clean.task.probabilities).toEqual({ coding: 0.95, general: 0.05 });
    expect(clean).not.toHaveProperty("relevance");
    expect(JSON.stringify(clean)).not.toContain("PRIVATE");
    answers.task.probabilities.coding = Infinity;
    expect(sanitizeAnswers({ answers }, questions).task).not.toHaveProperty("probabilities");
    expect(answerFor({ answers: { arbitrary: { type: "invented", confidence: 1, score: 0 } } }, "arbitrary", { type: "invented" })).toBeNull();
  });
});

describe("Jev shared evaluation", () => {
  test("deduplicates identical in-flight work, isolates subscriber cancellation, and logs no private data", async () => {
    const gate = deferred(), events: any[] = [];
    let calls = 0, upstreamSignal!: AbortSignal;
    const { evaluate } = createSemanticEvaluator({ env: { TYPESAFE_API_KEY: "PRIVATE KEY" }, onUsage: (event: any) => events.push(event),
      fetchImpl: (_url: string, init: any) => { calls++; upstreamSignal = init.signal; return gate.promise; } });
    const controller = new AbortController();
    const first = evaluate(request({ signal: controller.signal })).catch((error: any) => error.name);
    const second = evaluate(request());
    expect(calls).toBe(1);
    controller.abort();
    expect(await first).toBe("AbortError");
    expect(upstreamSignal.aborted).toBe(false);
    gate.resolve(response());
    expect((await second).answers.freshness.noul).toBe(0.8);
    await evaluate(request());
    expect(calls).toBe(1);
    expect(events.filter((event) => event.event === "jev_usage")).toHaveLength(1);
    expect(events.map((event) => event.status)).toContain("shared");
    expect(events.map((event) => event.status)).toContain("cache_hit");
    expect(JSON.stringify(events)).not.toContain("PRIVATE");
  });

  test("aborts upstream only after every subscriber leaves and never caches a late result", async () => {
    const gates: ReturnType<typeof deferred>[] = [], signals: AbortSignal[] = [];
    const { evaluate } = createSemanticEvaluator({ env: { TYPESAFE_API_KEY: "mock" }, onUsage: () => {},
      fetchImpl: (_url: string, init: any) => { const gate = deferred(); gates.push(gate); signals.push(init.signal); return gate.promise; } });
    const a = new AbortController(), b = new AbortController();
    const p = evaluate(request({ signal: a.signal })).catch((error: any) => error.name);
    const q = evaluate(request({ signal: b.signal })).catch((error: any) => error.name);
    a.abort(); b.abort();
    expect(await p).toBe("AbortError"); expect(await q).toBe("AbortError");
    expect(signals[0].aborted).toBe(true);
    gates[0].resolve(response()); await tick();
    const retry = evaluate(request());
    expect(gates).toHaveLength(2);
    gates[1].resolve(response()); await retry;
  });

  test("queues work beyond two active requests and gives waiting chat priority over background", async () => {
    const calls: string[] = [], gates: ReturnType<typeof deferred>[] = [];
    const { evaluate } = createSemanticEvaluator({ env: { TYPESAFE_API_KEY: "mock" }, onUsage: () => {},
      fetchImpl: (_url: string, init: any) => { calls.push(JSON.parse(init.body).state.id); const gate = deferred(); gates.push(gate); return gate.promise; } });
    const first = evaluate(request({ state: { id: "first" }, operation: "workspace" }));
    const second = evaluate(request({ state: { id: "second" }, operation: "workspace" }));
    const background = evaluate(request({ state: { id: "background" }, operation: "workspace", priority: "background" }));
    const chat = evaluate(request({ state: { id: "chat" }, operation: "chat" }));
    expect(calls).toEqual(["first", "second"]);
    gates[0].resolve(response()); await first; await tick();
    expect(calls).toEqual(["first", "second", "chat"]);
    gates[1].resolve(response()); await second; await tick();
    expect(calls).toEqual(["first", "second", "chat", "background"]);
    gates[2].resolve(response()); gates[3].resolve(response()); await Promise.all([chat, background]);
  });

  test("enforces the instance concurrency limit across accounts", async () => {
    const gates: ReturnType<typeof deferred>[] = [];
    const { evaluate } = createSemanticEvaluator({ env: { TYPESAFE_API_KEY: "mock" }, onUsage: () => {},
      fetchImpl: () => { const gate = deferred(); gates.push(gate); return gate.promise; } });
    const pending = Array.from({ length: 13 }, (_, index) => evaluate(request({ userId: `account-${index}` })));
    expect(gates).toHaveLength(12);
    gates[0].resolve(response()); await pending[0]; await tick();
    expect(gates).toHaveLength(13);
    gates.forEach((gate) => gate.resolve(response())); await Promise.all(pending);
  });

  test("removes cancelled queued work without a provider call", async () => {
    const gates: ReturnType<typeof deferred>[] = [];
    const { evaluate } = createSemanticEvaluator({ env: { TYPESAFE_API_KEY: "mock" }, onUsage: () => {},
      fetchImpl: () => { const gate = deferred(); gates.push(gate); return gate.promise; } });
    const a = evaluate(request({ state: "a" })), b = evaluate(request({ state: "b" }));
    const controller = new AbortController();
    const queued = evaluate(request({ state: "queued", signal: controller.signal })).catch((error: any) => error.name);
    controller.abort(); expect(await queued).toBe("AbortError");
    gates.forEach((gate) => gate.resolve(response())); await Promise.all([a, b]);
    expect(gates).toHaveLength(2);
  });

  test("keys completed and in-flight caches by account and expires judgments", async () => {
    let clock = 0, calls = 0;
    const { evaluate } = createSemanticEvaluator({ env: { TYPESAFE_API_KEY: "mock" }, onUsage: () => {}, now: () => clock,
      fetchImpl: async () => { calls++; return response(); } });
    await evaluate(request()); await evaluate(request());
    await evaluate(request({ userId: "other" }));
    expect(calls).toBe(2);
    clock = 300_001; await evaluate(request()); expect(calls).toBe(3);
  });

  test("does not poison cache with missing or malformed judgments", async () => {
    let calls = 0;
    const { evaluate } = createSemanticEvaluator({ env: { TYPESAFE_API_KEY: "mock" }, onUsage: () => {},
      fetchImpl: async () => { calls++; return response(calls === 1 ? { freshness: { type: "noul", noul: 1 } } : validAnswers()); } });
    const first = await evaluate(request()); expect(first.answers.task).toBeUndefined();
    const second = await evaluate(request()); expect(second.answers.task.choice).toBe("coding");
    await evaluate(request()); expect(calls).toBe(2);
  });

  test("marks missing provider usage as unknown, not free, and isolates logging failures", async () => {
    const events: any[] = [];
    const { evaluate } = createSemanticEvaluator({ env: { TYPESAFE_API_KEY: "mock" }, onUsage: (event: any) => { events.push(event); throw new Error("Logger unavailable"); },
      fetchImpl: async () => Response.json({ answers: validAnswers() }) });
    expect((await evaluate(request())).answers.task.choice).toBe("coding");
    const usage = events.find((event) => event.event === "jev_usage");
    expect(usage.missingUsageCount).toBe(1);
    expect(usage).not.toHaveProperty("inputTokens");
    expect(usage).not.toHaveProperty("estimatedCostUsd");
  });

  test("records timeouts and rate limits without retaining response bodies or throwing into fallback", async () => {
    const events: any[] = [];
    const slow = createSemanticEvaluator({ env: { TYPESAFE_API_KEY: "mock", TYPESAFE_TIMEOUT_MS: 100 }, onUsage: (event: any) => events.push(event),
      fetchImpl: () => new Promise(() => {}) });
    expect((await slow.evaluate(request())).warning).toContain("temporarily unavailable");
    expect(events.some((event) => event.status === "timeout")).toBe(true);
    const limited = createSemanticEvaluator({ env: { TYPESAFE_API_KEY: "mock", TYPESAFE_REQUESTS_PER_MINUTE: 1 }, onUsage: (event: any) => events.push(event),
      fetchImpl: async () => response() });
    await limited.evaluate(request());
    expect((await limited.evaluate(request({ state: "different" }))).warning).toContain("busy");
    expect(events.some((event) => event.status === "rate_limited")).toBe(true);
  });

  test("enforces separate state, per-question, total, and multilingual byte budgets before dispatch", async () => {
    expect(fitsEvaluationBudget({ model: "jev-1.13.0", state: "資料".repeat(5000), questions })).toBe(false);
    const largeQuestion = { type: "noul", instructions: "x".repeat(4000) };
    const combined = { model: "jev-1.13.0", state: "x".repeat(27000), questions: { one: largeQuestion } };
    expect(measureEvaluationBudget(combined).stateBytes).toBeLessThan(28000);
    expect(fitsEvaluationBudget(combined)).toBe(false);
    expect(fitsEvaluationBudget({ model: "jev-1.13.0", state: "x", questions: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [String(i), largeQuestion])) })).toBe(false);
    let calls = 0;
    const { evaluate } = createSemanticEvaluator({ env: { TYPESAFE_API_KEY: "mock" }, onUsage: () => {}, fetchImpl: async () => { calls++; return response(); } });
    expect((await evaluate(request(combined))).warning).toContain("too large"); expect(calls).toBe(0);
  });
});
