import { describe, expect, test } from "bun:test";
import { createWorkspaceAnalyzer, validateWorkspaceAnalysis } from "../server/semantic/workspaceAnalysis.mjs";
import { answerFor } from "../server/semantic/answers.mjs";
import { fitsEvaluationBudget } from "../server/semantic/budget.mjs";

type Request = { state: any; questions: Record<string, any>; signal?: AbortSignal; userId: string; priority: string; operation: string };
const item = (id: string, content = `Useful specific material for ${id}`) => ({ id, title: `Title ${id}`, kind: "note", content });
const group = (id: string) => ({ id, name: `Project ${id}`, memberTitles: [`Example ${id}`] });
function workspace(overrides: Record<string, unknown> = {}) {
  return { enabled: true, items: [item("a"), item("b"), item("c")], current: item("a"), groups: [group("z"), group("a")], ...overrides };
}
function answer(request: Request, modify?: (value: any, id: string, itemId: string) => any) {
  return { model: "jev-fixture", answers: Object.fromEntries(Object.entries(request.questions).map(([id, definition]) => {
    const value = definition.type === "score" ? { type: "score", score: 2.7, confidence: 0.9 }
      : { type: "choice", choice: id.startsWith("group_") ? "g0" : "writing", confidence: 0.9 };
    return [id, modify ? modify(value, id, request.state.items[Number(id.split("_")[1])].id) : value];
  })) };
}
function judgments(requests: Request[]) {
  return requests.flatMap((request) => Object.keys(request.questions).map((id) => {
    const [type, index] = id.split("_");
    return `${type}:${request.state.items[Number(index)].id}`;
  })).sort();
}
function harness(options: { now?: () => number; configured?: boolean; evaluate?: (request: Request, count: number) => any } = {}) {
  const calls: Request[] = [], metrics: any[] = [];
  const analyze = createWorkspaceAnalyzer({ answerFor, configured: options.configured ?? true, model: "jev-1.13.0", promptVersion: "test-v1", now: options.now,
    onMetric: (metric: any) => metrics.push(metric), evaluate: async (request: Request) => {
      calls.push(request);
      return options.evaluate ? await options.evaluate(request, calls.length) : answer(request);
    } });
  return { calls, metrics, analyze: (payload = workspace(), userId = "account-a", signal?: AbortSignal) => analyze({ payload, userId, signal }) };
}

describe("incremental Jev workspace judgments", () => {
  test("identical requests reuse all judgments and metrics never include workspace/account text", async () => {
    const { analyze, calls, metrics } = harness();
    const first = await analyze();
    const second = await analyze();
    expect(second).toEqual(first);
    expect(calls).toHaveLength(1);
    expect(judgments(calls)).toEqual(["category:a", "category:b", "category:c", "group:a", "group:b", "group:c", "related:b", "related:c"]);
    expect(metrics[1]).toMatchObject({ event: "jev_workspace", batchCount: 0, questionCount: 0, cachedJudgmentCount: 8, acceptedJudgmentCount: 8 });
    expect(metrics[1]).toMatchObject({ operation: "workspace", stage: "judgment", status: "success", fallback: false });
    expect(Object.values(metrics[1]).every((value) => ["number", "string", "boolean"].includes(typeof value))).toBe(true);
    expect(JSON.stringify(metrics)).not.toContain("account-a");
    expect(JSON.stringify(metrics)).not.toContain("Useful specific material");
    expect(calls[0]).toMatchObject({ operation: "workspace", priority: "background", userId: "account-a" });
  });

  test("navigation changes only related judgments and editing one item changes only its dependencies", async () => {
    const { analyze, calls } = harness();
    await analyze(); calls.length = 0;
    await analyze(workspace({ current: item("b") }));
    expect(judgments(calls)).toEqual(["related:a", "related:c"]);
    calls.length = 0;
    const edited = item("c", "Changed semantic content");
    const result = await analyze(workspace({ items: [item("a"), item("b"), edited], current: item("b") }));
    expect(judgments(calls)).toEqual(["category:c", "group:c", "related:c"]);
    expect(result.categories.map((value: any) => value.id)).toEqual(["a", "b", "c"]);
    calls.length = 0;
    await analyze(workspace({ items: [item("a"), item("b"), edited, item("d")], current: item("b") }));
    expect(judgments(calls)).toEqual(["category:d", "group:d", "related:d"]);
  });

  test("a focused-current edit invalidates relatedness without reclassifying unchanged excerpts", async () => {
    const { analyze, calls } = harness();
    await analyze(); calls.length = 0;
    await analyze(workspace({ current: item("a", "New focused material beyond the stable item excerpt") }));
    expect(judgments(calls)).toEqual(["related:b", "related:c"]);
  });

  test("group edits refresh group matches only while group order is canonical", async () => {
    const { analyze, calls } = harness();
    const first = await analyze();
    expect(first.groupSuggestions.every((suggestion: any) => suggestion.groupId === "a")).toBe(true);
    calls.length = 0;
    await analyze(workspace({ groups: [group("a"), group("z")] }));
    expect(calls).toHaveLength(0);
    const renamed = [group("z"), { ...group("a"), name: "New project subject" }];
    await analyze(workspace({ groups: renamed }));
    expect(judgments(calls)).toEqual(["group:a", "group:b", "group:c"]);
    expect(calls[0].state).not.toHaveProperty("current");
    calls.length = 0;
    await analyze(workspace({ groups: [{ ...renamed[0], memberTitles: ["A changed example"] }, renamed[1]] }));
    expect(judgments(calls)).toEqual(["group:a", "group:b", "group:c"]);
  });

  test("valid uncertainty and no-match are cached, malformed judgments alone are retried", async () => {
    let valid = false;
    const { analyze, calls } = harness({ evaluate: (request) => answer(request, (value, id, itemId) => {
      if (id.startsWith("group_")) return itemId === "b" ? { ...value, confidence: 0.2 } : { ...value, choice: "none" };
      if (id.startsWith("related_")) return { ...value, score: 0, confidence: 0.1 };
      if (itemId === "b") return { ...value, confidence: 0.01 };
      if (itemId === "c" && !valid) return { ...value, choice: "fabricated" };
      return value;
    }) });
    const first = await analyze();
    expect(first.available).toBe(true);
    expect(first.categories.map((value: any) => value.id)).toEqual(["a"]);
    expect(first.evaluatedCategoryIds).toEqual(["a", "b"]);
    expect(first.related).toEqual([]); expect(first.groupSuggestions).toEqual([]);
    expect(first.warning).toContain("unavailable");
    valid = true; calls.length = 0;
    const second = await analyze();
    expect(judgments(calls)).toEqual(["category:c"]);
    expect(second.evaluatedCategoryIds).toEqual(["a", "b", "c"]);
    expect(second.warning).toBeUndefined();
  });

  test("a failed miss preserves cached results and remains retryable", async () => {
    let failing = false;
    const { analyze, calls } = harness({ evaluate: (request) => { if (failing) throw new Error("provider private diagnostic"); return answer(request); } });
    await analyze(); calls.length = 0;
    const payload = workspace({ items: [item("a"), item("b"), item("c", "Edited content")] });
    failing = true;
    const partial = await analyze(payload);
    expect(partial.available).toBe(true);
    expect(partial.categories.map((value: any) => value.id)).toEqual(["a", "b"]);
    expect(partial.related.map((value: any) => value.id)).toEqual(["b"]);
    expect(partial.warning).toContain("temporarily unavailable");
    expect(JSON.stringify(partial)).not.toContain("private diagnostic");
    failing = false; calls.length = 0;
    const recovered = await analyze(payload);
    expect(recovered.categories).toHaveLength(3);
    expect(judgments(calls)).toEqual(["category:c", "group:c", "related:c"]);
  });

  test("account isolation and expiry require fresh judgments", async () => {
    let clock = 1_000;
    const { analyze, calls } = harness({ now: () => clock });
    await analyze(); await analyze(workspace(), "account-b");
    expect(calls).toHaveLength(2);
    clock += 299_999; await analyze(); expect(calls).toHaveLength(2);
    clock += 2; await analyze(); expect(calls).toHaveLength(3);
  });

  test("the judgment cache is bounded and recent entries survive LRU eviction", async () => {
    const { analyze, calls } = harness();
    const payload = (id: string) => workspace({ items: [item(id)], current: item(id), groups: [], related: false });
    for (let index = 0; index < 2048; index++) await analyze(payload(`n${index}`));
    await analyze(payload("n0"));
    await analyze(payload("n2048"));
    calls.length = 0;
    await analyze(payload("n0")); expect(calls).toHaveLength(0);
    await analyze(payload("n1")); expect(calls).toHaveLength(1);
  });

  test("adaptive batches respect UTF-8 and escaped-byte budgets, run at most two at once, and merge in original order", async () => {
    let active = 0, maximum = 0;
    const { analyze, calls } = harness({ evaluate: async (request, count) => {
      active++; maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, count % 2 ? 5 : 0));
      active--;
      return answer(request);
    } });
    const payload = workspace({
      items: Array.from({ length: 40 }, (_, index) => ({ ...item(`i${index}`, "\u0000語🚀".repeat(1000)), title: "界".repeat(200) })),
      current: item("focused", "語".repeat(4000)),
      groups: Array.from({ length: 20 }, (_, index) => ({ id: `g${index}`, name: "界".repeat(80), memberTitles: ["界".repeat(80), "\u0000".repeat(80)] })),
    });
    const result = await analyze(payload);
    expect(calls.length).toBeGreaterThan(2);
    expect(maximum).toBe(2);
    expect(calls.every((request) => fitsEvaluationBudget({ model: "jev-1.13.0", ...request }))).toBe(true);
    expect(judgments(calls)).toHaveLength(120);
    expect(result.categories.map((value: any) => value.id)).toEqual(payload.items.map((value) => value.id));
    expect(result.related.map((value: any) => value.id)).toEqual(["i0", "i1", "i2", "i3", "i4"]);
    expect(result.groupSuggestions).toHaveLength(40);
  });

  test("cancellation rejects even an abort-ignoring transport and cannot publish a late cache entry", async () => {
    let release: (() => void) | undefined;
    let hold = true;
    const { analyze, calls } = harness({ evaluate: async (request) => {
      if (hold) await new Promise<void>((resolve) => { release = resolve; });
      return answer(request);
    } });
    const controller = new AbortController();
    const pending = analyze(workspace(), "account-a", controller.signal);
    controller.abort(); release!();
    await expect(pending).rejects.toThrow();
    hold = false;
    await analyze(); expect(calls).toHaveLength(2);
    await analyze(); expect(calls).toHaveLength(2);
  });

  test("selected category IDs avoid aggregate reclassification and question instructions carry their own meaning", async () => {
    const { analyze, calls } = harness();
    const result = await analyze(workspace({ groups: [], related: false, categoryIds: ["b"] }));
    expect(judgments(calls)).toEqual(["category:b"]);
    expect(result.evaluatedCategoryIds).toEqual(["b"]);
    expect(calls[0].state).not.toHaveProperty("current");
    expect(calls[0].state).not.toHaveProperty("groups");
    expect(Object.values(calls[0].questions)[0].instructions).toContain("items[0]");
    expect(Object.values(calls[0].questions)[0].instructions).toContain("primary purpose");
    for (const categoryIds of [["missing"], ["a", "a"], "a"]) expect(() => validateWorkspaceAnalysis(workspace({ categoryIds }))).toThrow("Category ids");
    calls.length = 0;
    await analyze(workspace({ groups: [], related: false, categoryIds: [] }));
    expect(calls).toHaveLength(0);
  });

  test("excerpts preserve small-workspace quality and the aggregate allowance; unavailable work never dispatches", async () => {
    const long = item("a", "語".repeat(1600));
    const small = validateWorkspaceAnalysis(workspace({ items: [long] }));
    const large = validateWorkspaceAnalysis(workspace({ items: [long, ...Array.from({ length: 39 }, (_, index) => item(`i${index}`, "語".repeat(1600)))] }));
    expect(small.items[0].content).toHaveLength(1600);
    expect(large.items[0].content).toHaveLength(400);
    expect(large.items.reduce((sum: number, value: any) => sum + value.content.length, 0)).toBe(16_000);
    const unconfigured = harness({ configured: false });
    expect((await unconfigured.analyze()).available).toBe(false); expect(unconfigured.calls).toHaveLength(0);
    const anonymous = harness();
    expect((await anonymous.analyze(workspace(), "")).available).toBe(false); expect(anonymous.calls).toHaveLength(0);
  });
});
