import { EVALUATION_VERSION, PINNED_MODEL, fingerprint } from "./fixtures.mjs";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const STRATEGIES = ["batched", "sequential-singles", "concurrent-singles"];
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const probability = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const tokenCount = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;

export function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}

function latency(values) { return { samples: values.length, p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95) }; }

export function describePlan(scenarios, { repeats, concurrency, timeoutMs, pricePerMillion }) {
  const batched = scenarios.reduce((sum, scenario) => sum + scenario.requests.length, 0);
  const singles = scenarios.reduce((sum, scenario) => sum + scenario.requests.reduce((n, body) => n + Object.keys(body.questions).length, 0), 0);
  return {
    repeats, concurrency, timeoutMs, inputUsdPerMillion: pricePerMillion,
    plannedVendorRequests: repeats * (batched + singles * 2),
    requestsPerRepeat: { batched, "sequential-singles": singles, "concurrent-singles": singles },
    suiteFingerprint: fingerprint(scenarios.map(({ id, promptFingerprint }) => [id, promptFingerprint])),
    scenarios: scenarios.map(({ id, requests, promptFingerprint, expectations }) => ({ id, promptFingerprint,
      batches: requests.length, questions: Object.keys(expectations).length,
      stateFingerprints: requests.map((body) => fingerprint(body.state)),
      expectedDomains: [...new Set(Object.values(expectations).map((entry) => entry.domain))] })),
  };
}

function readAnswer(answer, question) {
  if (question.type === "noul") return record(answer) && answer.type === "noul" && probability(answer.noul) ? { type: "noul", noul: answer.noul } : null;
  if (!record(answer) || answer.type !== question.type || !probability(answer.confidence) || !record(answer.probabilities)) return null;
  const keys = question.type === "choice" ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
  if (Object.keys(answer.probabilities).length !== keys.length || keys.some((key) => !probability(answer.probabilities[key]))
    || Math.abs(keys.reduce((sum, key) => sum + answer.probabilities[key], 0) - 1) > 0.02) return null;
  const shared = { type: answer.type, confidence: answer.confidence, probabilities: Object.fromEntries(keys.map((key) => [key, answer.probabilities[key]])) };
  if (question.type === "choice") return typeof answer.choice === "string" && Object.hasOwn(question.criteria, answer.choice)
    ? { ...shared, choice: answer.choice } : null;
  return typeof answer.score === "number" && Number.isFinite(answer.score) && answer.score >= 0 && answer.score <= keys.length - 1
    ? { ...shared, score: answer.score } : null;
}

async function dispatch(body, options) {
  const { fetchImpl, apiKey, timeoutMs, signal } = options;
  const started = performance.now();
  const controller = new AbortController();
  let timer, rejectAborted;
  let usage = { inputTokens: null, outputTokens: null };
  const abort = () => { controller.abort(signal.reason); rejectAborted?.(signal.reason ?? new DOMException("Cancelled", "AbortError")); };
  const deadline = new Promise((_, reject) => {
    rejectAborted = reject;
    timer = setTimeout(() => {
      const error = new DOMException("Evaluation timed out", "TimeoutError");
      controller.abort(error); reject(error);
    }, timeoutMs);
  });
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    const response = await Promise.race([fetchImpl(ENDPOINT, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: controller.signal }), deadline]);
    if (!response.ok) return { status: [429, 529].includes(response.status) ? "rate_limited" : "upstream_error", httpStatus: response.status, answers: {}, ...usage, durationMs: performance.now() - started };
    const data = await Promise.race([response.json(), deadline]);
    usage = { inputTokens: tokenCount(data?.usage?.input_tokens), outputTokens: tokenCount(data?.usage?.output_tokens) };
    if (!record(data) || !record(data.answers)) return { status: "invalid_response", answers: {}, ...usage, durationMs: performance.now() - started };
    if (data.model !== PINNED_MODEL) return { status: "model_mismatch", answers: {}, ...usage, durationMs: performance.now() - started };
    const answers = {};
    for (const [id, definition] of Object.entries(body.questions)) {
      const answer = readAnswer(data.answers[id], definition);
      if (!answer) return { status: "invalid_response", answers: {}, ...usage, durationMs: performance.now() - started };
      answers[id] = answer;
    }
    return { status: "success", answers, ...usage, durationMs: performance.now() - started };
  } catch (error) {
    const status = signal?.aborted ? "cancelled" : controller.signal.reason?.name === "TimeoutError" || error?.name === "TimeoutError" ? "timeout"
      : error instanceof SyntaxError ? "invalid_response" : "upstream_error";
    return { status, answers: {}, ...usage, durationMs: performance.now() - started };
  } finally {
    clearTimeout(timer); signal?.removeEventListener("abort", abort);
  }
}

function checkOutcomes(expectations, answers) {
  return Object.entries(expectations).map(([id, expected]) => {
    const answer = answers[id];
    let status = "unavailable";
    if (answer) {
      if (expected.minimumConfidence !== undefined && answer.confidence < expected.minimumConfidence) status = "abstained";
      else {
        const matches = expected.choices ? expected.choices.includes(answer.choice)
          : answer.type === "noul" ? (expected.minimumNoul === undefined || answer.noul >= expected.minimumNoul)
            && (expected.maximumNoul === undefined || answer.noul <= expected.maximumNoul)
          : (expected.minimumScore === undefined || answer.score >= expected.minimumScore)
            && (expected.maximumScore === undefined || answer.score <= expected.maximumScore);
        status = matches ? "passed" : "failed";
      }
    }
    return { id, domain: expected.domain, status, expected, confidence: answer?.confidence ?? null };
  });
}

async function executeScenario(scenario, strategy, repeat, options) {
  const started = performance.now();
  const jobs = scenario.requests.flatMap((body, batch) => strategy === "batched" ? [{ batch, body }]
    : Object.entries(body.questions).map(([id, definition]) => ({ batch, body: { model: body.model, state: body.state, questions: { [id]: definition } } })));
  const results = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const index = next++; const job = jobs[index];
      results[index] = { batch: job.batch, questionIds: Object.keys(job.body.questions), ...await dispatch(job.body, options) };
    }
  };
  const limit = strategy === "concurrent-singles" ? options.concurrency : 1;
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  const answers = {};
  for (const result of results) for (const [id, answer] of Object.entries(result.answers)) answers[`${result.batch}:${id}`] = answer;
  const checks = checkOutcomes(scenario.expectations, answers);
  return { scenario: scenario.id, strategy, repeat, durationMs: performance.now() - started,
    successfulWorkflow: results.every((result) => result.status === "success"),
    requests: results.map(({ answers: _answers, ...result }) => result), answers, checks,
    coverage: { expected: Object.keys(scenario.expectations).length, returned: Object.keys(answers).length,
      trusted: checks.filter((check) => ["passed", "failed"].includes(check.status)).length,
      meanConfidence: mean(Object.values(answers).map((answer) => answer.confidence).filter((value) => value !== undefined)) } };
}

function summarize(samples, pricePerMillion) {
  const requests = samples.flatMap((sample) => sample.requests);
  const checks = samples.flatMap((sample) => sample.checks);
  const outcomes = Object.fromEntries(["passed", "failed", "abstained", "unavailable"].map((status) => [status, checks.filter((check) => check.status === status).length]));
  const statuses = {};
  for (const request of requests) statuses[request.status] = (statuses[request.status] ?? 0) + 1;
  const knownInputTokens = requests.reduce((sum, request) => sum + (request.inputTokens ?? 0), 0);
  return { workflows: samples.length, successfulWorkflows: samples.filter((sample) => sample.successfulWorkflow).length,
    endToEndLatency: latency(samples.map((sample) => sample.durationMs)),
    successfulEndToEndLatency: latency(samples.filter((sample) => sample.successfulWorkflow).map((sample) => sample.durationMs)),
    requestStatusCounts: statuses, vendorRequests: requests.length, knownInputTokens,
    knownOutputTokens: requests.reduce((sum, request) => sum + (request.outputTokens ?? 0), 0),
    missingUsageRequests: requests.filter((request) => request.inputTokens === null || request.outputTokens === null).length,
    estimatedKnownCostUsd: knownInputTokens / 1_000_000 * pricePerMillion,
    coverage: { expected: checks.length, returned: samples.reduce((sum, sample) => sum + sample.coverage.returned, 0),
      trusted: outcomes.passed + outcomes.failed, trustedRate: checks.length ? (outcomes.passed + outcomes.failed) / checks.length : null,
      expectedMatchRateAmongTrusted: outcomes.passed + outcomes.failed ? outcomes.passed / (outcomes.passed + outcomes.failed) : null,
      meanConfidence: mean(checks.map((check) => check.confidence).filter((value) => value !== null)) },
    expectedOutcomes: outcomes,
    outcomesByDomain: Object.fromEntries([...new Set(checks.map((check) => check.domain))].map((domain) => [domain,
      Object.fromEntries(Object.keys(outcomes).map((status) => [status, checks.filter((check) => check.domain === domain && check.status === status).length]))])),
  };
}

/** Compare full distributions, not just the winning choice; absent answers never count as agreement. */
export function compareAnswers(pairs) {
  let compared = 0, unavailable = 0, choices = 0, matchingChoices = 0;
  const scores = [], nouls = [], distributions = [], confidence = [];
  for (const [left, right] of pairs) {
    const ids = new Set([...Object.keys(left.expectations ?? left.answers), ...Object.keys(right.expectations ?? right.answers)]);
    for (const id of ids) {
      const a = left.answers[id], b = right.answers[id];
      if (!a || !b || a.type !== b.type) { unavailable++; continue; }
      compared++;
      if (a.type === "noul") { nouls.push(Math.abs(a.noul - b.noul)); continue; }
      confidence.push(Math.abs(a.confidence - b.confidence));
      if (a.type === "choice") { choices++; if (a.choice === b.choice) matchingChoices++; }
      else scores.push(Math.abs(a.score - b.score));
      distributions.push(...Object.keys(a.probabilities).map((key) => Math.abs(a.probabilities[key] - b.probabilities[key])));
    }
  }
  return { comparedQuestions: compared, unavailableComparisons: unavailable, comparedChoices: choices, matchingChoices,
    choiceAgreement: choices ? matchingChoices / choices : null,
    meanAbsoluteProbabilityDifference: mean(distributions), maximumProbabilityDifference: distributions.length ? Math.max(...distributions) : null,
    meanAbsoluteScoreDifference: mean(scores), maximumScoreDifference: scores.length ? Math.max(...scores) : null,
    meanAbsoluteNoulDifference: mean(nouls), maximumNoulDifference: nouls.length ? Math.max(...nouls) : null,
    meanAbsoluteConfidenceDifference: mean(confidence) };
}

export async function runEvaluation(scenarios, { live = false, apiKey, repeats = 5, concurrency = 3, timeoutMs = 10_000,
  pricePerMillion = 0.042, fetchImpl = globalThis.fetch, signal } = {}) {
  if (!live || !apiKey) throw new Error("Live evaluation requires an explicit live flag and API key.");
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 50 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8
    || !Number.isFinite(timeoutMs) || timeoutMs < 1 || !Number.isFinite(pricePerMillion) || pricePerMillion < 0) throw new Error("Invalid evaluation limits.");
  if (!scenarios.length || scenarios.some((scenario) => !scenario.requests.length || scenario.promptFingerprint !== fingerprint(scenario.requests)
    || scenario.requests.some((body) => body.model !== PINNED_MODEL || !Object.keys(body.questions).length))) throw new Error("Evaluation requires unchanged, pinned scenario payloads.");
  const options = { apiKey, repeats, concurrency, timeoutMs, pricePerMillion, fetchImpl, signal };
  const samples = [];
  // No adapter cache, SDK retry, or result reuse. Rotate order to reduce warm-up/order bias.
  for (let repeat = 0; repeat < repeats; repeat++) {
    const order = [...STRATEGIES.slice(repeat % STRATEGIES.length), ...STRATEGIES.slice(0, repeat % STRATEGIES.length)];
    for (const scenario of scenarios) for (const strategy of order) {
      samples.push(await executeScenario(scenario, strategy, repeat, options));
    }
  }
  const get = (id, strategy, repeat) => samples.find((sample) => sample.scenario === id && sample.strategy === strategy && sample.repeat === repeat);
  const pair = (scenario, a, b) => [{ ...a, expectations: scenario.expectations }, { ...b, expectations: scenario.expectations }];
  const comparisons = Object.fromEntries(STRATEGIES.slice(1).map((strategy) => [strategy, compareAnswers(scenarios.flatMap((scenario) =>
    Array.from({ length: repeats }, (_, repeat) => pair(scenario, get(scenario.id, "batched", repeat), get(scenario.id, strategy, repeat)))))]));
  const repeatability = Object.fromEntries(STRATEGIES.map((strategy) => [strategy, compareAnswers(scenarios.flatMap((scenario) =>
    Array.from({ length: repeats - 1 }, (_, index) => pair(scenario, get(scenario.id, strategy, 0), get(scenario.id, strategy, index + 1)))))]));
  const summaries = Object.fromEntries(STRATEGIES.map((strategy) => [strategy, summarize(samples.filter((sample) => sample.strategy === strategy), pricePerMillion)]));
  const issues = samples.some((sample) => !sample.successfulWorkflow || sample.checks.some((check) => check.status !== "passed"));
  return { evaluationVersion: EVALUATION_VERSION, model: PINNED_MODEL, status: issues ? "completed_with_issues" : "completed",
    ...describePlan(scenarios, options),
    protocol: { cache: "Application caches bypassed; fresh dispatch per repeat. Vendor-side caching is not controllable.",
      ordering: "Strategy order rotates each repeat; scenario order is fixed.",
      retries: "None. Failures, timeouts, invalid responses, and abstentions are reported separately.",
      scope: "Synthetic application question payloads; transport/workflow measurements, not full UI latency or a production-quality benchmark.",
      cost: "Known input-token usage only; requests with missing usage may still be billable. Output tokens are free at the configured rate.",
      comparisons: "Singles retain the exact state and question definitions from each captured application batch. p50/p95 use nearest ranks; small samples are unstable." },
    summaries, comparisonsToBatched: comparisons, withinStrategyRepeatability: repeatability,
    scenarioSummaries: Object.fromEntries(scenarios.map((scenario) => [scenario.id, Object.fromEntries(STRATEGIES.map((strategy) =>
      [strategy, summarize(samples.filter((sample) => sample.scenario === scenario.id && sample.strategy === strategy), pricePerMillion)]))])),
    samples,
  };
}
