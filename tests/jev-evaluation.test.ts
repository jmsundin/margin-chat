import { afterEach, describe, expect, test } from "bun:test";
import { main, parseOptions } from "../scripts/evaluate-jev.mjs";
import { assertPinnedSuiteFingerprint, buildScenarios, fingerprint, PINNED_MODEL, PINNED_SUITE_FINGERPRINT } from "../scripts/jev-evaluation/fixtures.mjs";
import { percentile, runEvaluation } from "../scripts/jev-evaluation/runner.mjs";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function fixture() {
  const requests = [{ model: PINNED_MODEL, state: { note: "Synthetic content kept out of reports" }, questions: {
    task: { type: "choice", instructions: "Which task?", criteria: { coding: "Software", writing: "Prose" } },
    relevance: { type: "score", instructions: "How relevant?", criteria: ["None", "Broad topic", "Useful", "Direct answer"] },
    current: { type: "noul", instructions: "Needs current information?" },
  } }];
  return { id: "test-synthetic", requests, promptFingerprint: fingerprint(requests), expectations: {
    "0:task": { domain: "intent", choices: ["coding"], minimumConfidence: 0.55 },
    "0:relevance": { domain: "context", minimumScore: 2, minimumConfidence: 0.35 },
    "0:current": { domain: "freshness", maximumNoul: 0.35 },
  } };
}

function answerBody(body: any) {
  return { model: PINNED_MODEL, usage: { input_tokens: 100, output_tokens: 10 }, answers: Object.fromEntries(Object.entries(body.questions).map(([id, question]: any) => [id,
    question.type === "choice" ? { type: "choice", choice: "coding", confidence: 0.9, probabilities: { coding: 0.95, writing: 0.05 } }
      : question.type === "score" ? { type: "score", score: 2.8, confidence: 0.9, probabilities: { 0: 0, 1: 0, 2: 0.2, 3: 0.8 } }
        : { type: "noul", noul: 0.1 },
  ])) };
}

describe("Jev evaluation harness", () => {
  test("default mode builds actual application questions without network access or a credential", async () => {
    let networkCalls = 0;
    globalThis.fetch = (async () => { networkCalls++; throw new Error("Network must not run"); }) as typeof fetch;
    const report = await main([], { env: {}, write() {} });
    expect(report.status).toBe("not_run");
    expect(report.model).toBe("jev-1.13.0");
    expect(report.suiteFingerprint).toBe(PINNED_SUITE_FINGERPRINT);
    expect(report.matchesPinnedSuite).toBe(true);
    expect(report.scenarios.length).toBe(9);
    expect(report.scenarios.flatMap((scenario: any) => scenario.expectedDomains)).toEqual(expect.arrayContaining(["intent", "routing", "context", "category", "group", "freshness", "complexity"]));
    expect(report).not.toHaveProperty("summaries");
    expect(networkCalls).toBe(0);
    expect(parseOptions([]).live).toBe(false);
    expect(() => parseOptions(["--live", "--dry-run"])).toThrow();
    expect(() => parseOptions(["--concurrency", "0"])).toThrow();
    await expect(main(["--live"], { env: {}, write() {} })).rejects.toThrow("requires TYPESAFE");
    expect(networkCalls).toBe(0);
  });

  test("fixture state and questions are reproducible and include no credential", async () => {
    const first = await buildScenarios();
    const second = await buildScenarios();
    expect(first.map((scenario: any) => scenario.promptFingerprint)).toEqual(second.map((scenario: any) => scenario.promptFingerprint));
    for (const scenario of first) {
      expect(scenario.promptFingerprint).toBe(fingerprint(scenario.requests));
      expect(Object.keys(scenario.expectations)).toHaveLength(scenario.requests.reduce((sum: number, body: any) => sum + Object.keys(body.questions).length, 0));
    }
    expect(JSON.stringify(first)).not.toContain("synthetic-capture-only");
    const grouped = first.find((scenario: any) => scenario.id === "workspace-groups-and-no-match");
    expect(Object.values(grouped.expectations)).toEqual(expect.arrayContaining([
      expect.objectContaining({ domain: "group", choices: ["none"], minimumConfidence: 0.75 }),
      expect.objectContaining({ domain: "group", choices: ["g0"], minimumConfidence: 0.75 }),
    ]));
  });

  test("fresh repetitions compare identical state, measure every dispatch, and bound concurrency", async () => {
    const scenario = fixture(); const bodies: any[] = []; let active = 0, maximumActive = 0;
    const report = await runEvaluation([scenario], { live: true, apiKey: "secret-test-key", repeats: 3, concurrency: 2, pricePerMillion: 1,
      fetchImpl: async (_url: string, init: any) => {
        const body = JSON.parse(init.body); bodies.push(body); active++; maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 1)); active--;
        return Response.json(answerBody(body));
      } });
    expect(bodies).toHaveLength(21);
    expect(maximumActive).toBe(2);
    for (const body of bodies) {
      expect(body.state).toEqual(scenario.requests[0].state);
      expect(body.model).toBe(PINNED_MODEL);
      for (const [id, definition] of Object.entries(body.questions)) expect(definition).toEqual((scenario.requests[0].questions as any)[id]);
    }
    expect(report.samples.map((sample: any) => sample.strategy)).toEqual([
      "batched", "sequential-singles", "concurrent-singles", "sequential-singles", "concurrent-singles", "batched", "concurrent-singles", "batched", "sequential-singles",
    ]);
    expect(report.status).toBe("completed");
    expect(report.summaries.batched.knownInputTokens).toBe(300);
    expect(report.summaries["sequential-singles"].knownInputTokens).toBe(900);
    expect(report.summaries["concurrent-singles"].estimatedKnownCostUsd).toBe(0.0009);
    expect(report.summaries.batched.endToEndLatency.samples).toBe(3);
    expect(report.comparisonsToBatched["sequential-singles"]).toMatchObject({ comparedQuestions: 9, matchingChoices: 3, choiceAgreement: 1, meanAbsoluteProbabilityDifference: 0, meanAbsoluteScoreDifference: 0, meanAbsoluteNoulDifference: 0 });
    expect(report.withinStrategyRepeatability.batched.comparedQuestions).toBe(6);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("secret-test-key");
    expect(serialized).not.toContain("Synthetic content kept out of reports");
  });

  test("agreement catches changed distributions even when labels and scores agree", async () => {
    let call = 0;
    const report = await runEvaluation([fixture()], { live: true, apiKey: "key", repeats: 1,
      fetchImpl: async (_url: string, init: any) => {
        const data: any = answerBody(JSON.parse(init.body));
        if (call++ && data.answers.task) data.answers.task.probabilities = { coding: 0.7, writing: 0.3 };
        return Response.json(data);
      } });
    expect(report.comparisonsToBatched["sequential-singles"].choiceAgreement).toBe(1);
    expect(report.comparisonsToBatched["sequential-singles"].maximumProbabilityDifference).toBeCloseTo(0.25);
    expect(report.comparisonsToBatched["sequential-singles"].meanAbsoluteProbabilityDifference).toBeGreaterThan(0);
  });

  test("service failures, invalid answers, low confidence and missing usage are not reported as passed", async () => {
    let call = 0;
    const report = await runEvaluation([fixture()], { live: true, apiKey: "secret", repeats: 1,
      fetchImpl: async (_url: string, init: any) => {
        const index = call++;
        if (index === 0) return Response.json({ error: "PRIVATE VENDOR BODY" }, { status: 503 });
        if (index >= 4) return Response.json({}, { status: 429 });
        const data: any = answerBody(JSON.parse(init.body));
        if (index === 1) delete data.answers.task.probabilities;
        if (index === 2) data.answers.relevance.confidence = 0.1;
        if (index === 3) delete data.usage;
        return Response.json(data);
      } });
    expect(report.status).toBe("completed_with_issues");
    expect(report.summaries.batched.requestStatusCounts).toEqual({ upstream_error: 1 });
    expect(report.summaries.batched.expectedOutcomes).toEqual({ passed: 0, failed: 0, abstained: 0, unavailable: 3 });
    expect(report.summaries["sequential-singles"].expectedOutcomes).toEqual({ passed: 1, failed: 0, abstained: 1, unavailable: 1 });
    expect(report.summaries["sequential-singles"].missingUsageRequests).toBe(1);
    expect(report.summaries["concurrent-singles"].requestStatusCounts).toEqual({ rate_limited: 3 });
    expect(report.comparisonsToBatched["concurrent-singles"]).toMatchObject({ comparedQuestions: 0, unavailableComparisons: 3, choiceAgreement: null });
    expect(JSON.stringify(report)).not.toContain("PRIVATE VENDOR BODY");
  });

  test("timeouts remain separate from quality and missing answers never agree", async () => {
    const report = await runEvaluation([fixture()], { live: true, apiKey: "key", repeats: 1, timeoutMs: 2,
      fetchImpl: async () => new Promise(() => {}) });
    expect(report.summaries.batched.requestStatusCounts).toEqual({ timeout: 1 });
    expect(report.summaries.batched.successfulEndToEndLatency).toEqual({ samples: 0, p50Ms: null, p95Ms: null });
    expect(report.comparisonsToBatched["sequential-singles"].unavailableComparisons).toBe(3);
    expect(report.status).toBe("completed_with_issues");
  });

  test("missing output usage remains incomplete accounting while known input cost is preserved", async () => {
    const report = await runEvaluation([fixture()], { live: true, apiKey: "key", repeats: 1, pricePerMillion: 1,
      fetchImpl: async (_url: string, init: any) => {
        const data: any = answerBody(JSON.parse(init.body));
        delete data.usage.output_tokens;
        return Response.json(data);
      } });
    expect(report.summaries.batched.missingUsageRequests).toBe(1);
    expect(report.summaries.batched.knownInputTokens).toBe(100);
    expect(report.summaries.batched.estimatedKnownCostUsd).toBe(0.0001);
    expect(report.summaries["sequential-singles"].missingUsageRequests).toBe(3);
    expect(report.samples[0].requests[0].outputTokens).toBeNull();
  });

  test("live guard, pinned payload guard and percentile handling reject misleading runs", async () => {
    let calls = 0; const fetchImpl = async () => { calls++; return Response.json({}); };
    await expect(runEvaluation([fixture()], { apiKey: "key", fetchImpl })).rejects.toThrow("explicit live flag");
    const changed = fixture(); changed.requests[0].state.note = "changed after capture";
    await expect(runEvaluation([changed], { live: true, apiKey: "key", fetchImpl })).rejects.toThrow("unchanged, pinned");
    expect(() => assertPinnedSuiteFingerprint("unreviewed-builder-change")).toThrow("No requests were sent");
    expect(() => assertPinnedSuiteFingerprint(PINNED_SUITE_FINGERPRINT)).not.toThrow();
    expect(calls).toBe(0);
    expect(percentile([], 0.95)).toBeNull();
    expect(percentile([3, 1, 2, 4, 5], 0.5)).toBe(3);
    expect(percentile([3, 1, 2, 4, 5], 0.95)).toBe(5);
  });
});
