import { createHash } from "node:crypto";
import { fitsEvaluationBudget, measureEvaluationBudget } from "./budget.mjs";
import { sanitizeAnswers } from "./answers.mjs";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const TTL_MS = 300_000;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const boundedNumber = (value, fallback, min, max) => {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};
const modelId = (value, fallback) => typeof value === "string" && /^jev-[a-zA-Z0-9._-]{1,90}$/.test(value) ? value : fallback;
const temporary = () => ({ warning: "Jev assistance is temporarily unavailable. Standard behavior was used." });
const busy = () => ({ warning: "Jev assistance is busy. Standard behavior was used; try again shortly." });

function abortable(work, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(work).then((result) => { cleanup(); resolve(result); }, (error) => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}

export function createSemanticEvaluator({ env = {}, fetchImpl = (...args) => globalThis.fetch(...args),
  onUsage = (event) => console.info(JSON.stringify(event)), now = Date.now, promptVersion = "margin-jev-3-parallel" } = {}) {
  const apiKey = [env.TYPESAFE_AI_JEV_API_KEY, env.TYPESAFE_API_KEY]
    .find((value) => typeof value === "string" && value.trim())?.trim() ?? "";
  const configured = Boolean(apiKey) && env.TYPESAFE_ENABLED !== "false";
  const model = modelId(env.TYPESAFE_MODEL, "jev-1.13.0");
  const timeoutMs = boundedNumber(env.TYPESAFE_TIMEOUT_MS, 2500, 100, 10000);
  const requestsPerMinute = boundedNumber(env.TYPESAFE_REQUESTS_PER_MINUTE, 20, 1, 120);
  const instanceRequestsPerMinute = boundedNumber(env.TYPESAFE_INSTANCE_REQUESTS_PER_MINUTE, 120, 1, 1200);
  const pricePerMillion = boundedNumber(env.TYPESAFE_INPUT_USD_PER_MILLION, 0.042, 0, 1000);
  // Completed values contain only judgments. Pending requests retain their bounded
  // state only until completion/cancellation; no prompt or account IDs are logged.
  const cache = new Map(), inFlight = new Map(), accounts = new Map(), queue = [];
  const instance = { started: now(), count: 0, active: 0 };
  let pumping = false;

  const numericFields = ["questionCount", "acceptedQuestionCount", "rejectedQuestionCount", "stateBytes", "perQuestionBytes", "requestBytes",
    "durationMs", "queueMs", "queueDepth", "inputTokens", "outputTokens", "estimatedCostUsd", "batchCount", "cachedJudgmentCount",
    "requestedJudgmentCount", "acceptedJudgmentCount", "rejectedJudgmentCount", "cacheHitCount", "cacheMissCount", "itemCount", "missingUsageCount"];
  const statuses = new Set(["cache_hit", "shared", "queued", "success", "partial", "timeout", "cancelled", "invalid_response", "upstream_error",
    "rate_limited", "oversized", "unconfigured", "unauthenticated", "empty"]);
  function emitMetric(event) {
    const safe = { event: ["jev_usage", "jev_workspace"].includes(event.event) ? event.event : "jev_evaluation",
      operation: ["chat", "workspace", "search"].includes(event.operation) ? event.operation : "unknown",
      model: modelId(event.model, model), promptVersion };
    if (statuses.has(event.status)) safe.status = event.status;
    if (["dispatch", "judgment"].includes(event.stage)) safe.stage = event.stage;
    for (const key of numericFields) if (typeof event[key] === "number" && Number.isFinite(event[key]) && event[key] >= 0) safe[key] = Math.min(event[key], 1e9);
    if (typeof event.fallback === "boolean") safe.fallback = event.fallback;
    try { onUsage(safe); } catch { /* Diagnostics cannot interrupt a reply. */ }
  }

  function accountWindow(userId) {
    const time = now();
    if (time - instance.started >= 60_000) { instance.started = time; instance.count = 0; }
    for (const [id, window] of accounts) if (!window.active && !window.queued && time - window.started >= 60_000) accounts.delete(id);
    let window = accounts.get(userId);
    if (!window) {
      if (accounts.size >= 2000) return null;
      window = { started: time, count: 0, active: 0, queued: 0 };
      accounts.set(userId, window);
    }
    if (time - window.started >= 60_000) { window.started = time; window.count = 0; }
    return window;
  }

  function removeQueued(entry) {
    const index = queue.indexOf(entry);
    if (index >= 0) { queue.splice(index, 1); entry.window.queued--; }
  }

  function finish(entry, result, status, acceptedQuestionCount = 0) {
    if (entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.timer);
    entry.controller.signal.removeEventListener("abort", entry.onAbort);
    removeQueued(entry);
    if (inFlight.get(entry.key) === entry) inFlight.delete(entry.key);
    if (status === "success" && !entry.controller.signal.aborted) {
      cache.set(entry.key, { at: now(), result });
      while (cache.size > 128) cache.delete(cache.keys().next().value);
    }
    emitMetric({ operation: entry.operation, stage: "dispatch", status, ...entry.size, durationMs: now() - entry.created,
      queueMs: (entry.dispatchedAt ?? now()) - entry.created, acceptedQuestionCount,
      rejectedQuestionCount: entry.size.questionCount - acceptedQuestionCount, fallback: status !== "success" });
    entry.resolve(result);
  }

  async function dispatch(entry) {
    const { controller } = entry;
    let status = "upstream_error";
    try {
      controller.signal.throwIfAborted();
      const response = await abortable(fetchImpl(ENDPOINT, {
        method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: entry.body, signal: controller.signal,
      }), controller.signal);
      if (!response.ok) { status = [429, 529].includes(response.status) ? "rate_limited" : "upstream_error"; throw new Error("Jev unavailable"); }
      status = "invalid_response";
      const data = await abortable(response.json(), controller.signal);
      controller.signal.throwIfAborted();
      if (!record(data) || !record(data.answers)) throw new Error("Invalid Jev response");
      const answers = sanitizeAnswers(data, entry.questions);
      const result = { answers, model: modelId(data.model, model) };
      const tokenCount = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
      const inputTokens = tokenCount(data.usage?.input_tokens) ? data.usage.input_tokens : undefined;
      const outputTokens = tokenCount(data.usage?.output_tokens) ? data.usage.output_tokens : undefined;
      emitMetric({ event: "jev_usage", operation: entry.operation, model: result.model, inputTokens, outputTokens,
        ...(inputTokens !== undefined ? { estimatedCostUsd: inputTokens * pricePerMillion / 1_000_000 } : {}),
        missingUsageCount: Number(inputTokens === undefined || outputTokens === undefined),
        durationMs: now() - entry.dispatchedAt, questionCount: entry.size.questionCount });
      const accepted = Object.keys(answers).length;
      // Do not cache incomplete responses as complete: missing judgments must be
      // eligible for retry. The workspace cache can retain valid individual ones.
      finish(entry, result, accepted === entry.size.questionCount ? "success" : accepted ? "partial" : "invalid_response", accepted);
    } catch {
      finish(entry, temporary(), controller.signal.aborted ? entry.timedOut ? "timeout" : "cancelled" : status);
    } finally {
      entry.window.active--; instance.active--;
      pump();
    }
  }

  function pump() {
    if (pumping) return;
    pumping = true;
    try {
      queue.sort((a, b) => a.priority - b.priority || a.created - b.created);
      for (let index = 0; index < queue.length;) {
        const entry = queue[index];
        const window = accountWindow(entry.userId);
        if (!window || window.count >= requestsPerMinute || instance.count >= instanceRequestsPerMinute) {
          finish(entry, busy(), "rate_limited"); continue;
        }
        if (window.active >= 2 || instance.active >= 12) { index++; continue; }
        removeQueued(entry);
        window.count++; window.active++; instance.count++; instance.active++;
        entry.running = true; entry.dispatchedAt = now();
        void dispatch(entry);
      }
    } finally { pumping = false; }
  }

  function subscribe(entry, signal) {
    entry.subscribers++;
    return new Promise((resolve, reject) => {
      let finished = false;
      const complete = (callback, value) => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener("abort", abort);
        entry.subscribers--;
        if (!entry.subscribers && !entry.settled) {
          if (inFlight.get(entry.key) === entry) inFlight.delete(entry.key);
          entry.controller.abort(new DOMException("No Jev subscribers remain", "AbortError"));
        }
        callback(value);
      };
      const abort = () => complete(reject, signal.reason);
      signal?.addEventListener("abort", abort, { once: true });
      entry.promise.then((result) => complete(resolve, structuredClone(result)), (error) => complete(reject, error));
      if (signal?.aborted) abort();
    });
  }

  async function evaluate({ state, questions, signal, userId, operation, priority }) {
    signal?.throwIfAborted();
    const report = (status, result, size = {}) => { emitMetric({ operation, stage: "dispatch", status, ...size, fallback: Boolean(result.warning) }); return result; };
    if (!configured) return report("unconfigured", { warning: "Jev assistance is not configured. Standard behavior is available." });
    if (!userId) return report("unauthenticated", { warning: "Sign in to use Jev assistance." });
    const request = { model, state, questions }, size = measureEvaluationBudget(request);
    if (!size.questionCount) return report("empty", { answers: {}, model }, size);
    if (!fitsEvaluationBudget(request)) return report("oversized", { warning: "This context is too large for Jev assistance. Standard behavior was used." }, size);
    const body = JSON.stringify(request);
    const key = createHash("sha256").update(JSON.stringify([userId, promptVersion, body])).digest("hex");
    const cached = cache.get(key);
    if (cached && now() - cached.at < TTL_MS) {
      cache.delete(key); cache.set(key, cached);
      return report("cache_hit", structuredClone(cached.result), size);
    }
    cache.delete(key);
    const pending = inFlight.get(key);
    if (pending && !pending.controller.signal.aborted) {
      emitMetric({ operation, stage: "dispatch", status: "shared", ...size, fallback: false });
      return subscribe(pending, signal);
    }
    const window = accountWindow(userId);
    if (!window || queue.length >= 128 || window.queued >= 8 || window.count >= requestsPerMinute || instance.count >= instanceRequestsPerMinute) return report("rate_limited", busy(), size);
    const entry = { key, body, questions, userId, operation, size, window, created: now(), controller: new AbortController(),
      priority: operation === "chat" ? 0 : priority === "background" || operation === "workspace" ? 2 : 1,
      subscribers: 0, running: false, settled: false, timedOut: false };
    entry.promise = new Promise((resolve) => { entry.resolve = resolve; });
    entry.onAbort = () => {
      if (!entry.running) { finish(entry, temporary(), entry.timedOut ? "timeout" : "cancelled"); pump(); }
    };
    entry.controller.signal.addEventListener("abort", entry.onAbort, { once: true });
    entry.timer = setTimeout(() => { entry.timedOut = true; entry.controller.abort(new DOMException("Jev timed out", "TimeoutError")); }, timeoutMs);
    inFlight.set(key, entry);
    const result = subscribe(entry, signal);
    if (!entry.settled) {
      window.queued++; queue.push(entry);
      if (window.active >= 2 || instance.active >= 12) emitMetric({ operation, stage: "dispatch", status: "queued", ...size, queueDepth: queue.length });
      pump();
    }
    return result;
  }

  return { configured, model, evaluate, emitMetric };
}
