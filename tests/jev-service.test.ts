import { describe, expect, test } from "bun:test";
import { createSemanticService, validateWorkspaceAnalysis } from "../server/semantic/index.mjs";
import { normalizeAISettings } from "@margin-chat/workspace-contracts";
import { validateAIOptions } from "../server/chat/validation.mjs";

function chat(overrides: any = {}) {
  return { ai: { jevEnabled: true, mode: "balanced", contextScope: "workspace", selectedConversationIds: [] },
    conversation: { id: "current", title: "Current", ancestorContext: [] },
    messages: [{ role: "user", content: "Which approach did we choose?" }], serviceId: "backend-services",
    workspaceContext: [
      { id: "first", title: "First", messages: [{ role: "user", content: "Background" }] },
      { id: "second", title: "Second", content: "A useful decision", messages: [] },
    ], ...overrides };
}
function workspace(overrides: any = {}) {
  return { enabled: true, current: { id: "current", title: "Current", content: "Designing a plan" },
    items: [
      { id: "current", title: "Current", kind: "chat", content: "Designing a plan" },
      { id: "note", title: "Decisions", kind: "note", content: "The prior plan" },
    ], ...overrides };
}
function harness(editAnswers?: (answers: any, request: any) => void, options: any = {}) {
  const calls: any[] = [], logs: any[] = [];
  const service = createSemanticService({ env: { TYPESAFE_API_KEY: "test-key", ...options.env }, onUsage: (event: any) => logs.push(event),
    fetchImpl: async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); calls.push({ url, init, body });
      const answers: any = Object.fromEntries(Object.entries(body.questions).map(([id, definition]: any) => [id,
        definition.type === "choice" ? { type: "choice", choice: Object.keys(definition.criteria)[0], confidence: 0.9 }
          : definition.type === "noul" ? { type: "noul", noul: 0.1 }
          : { type: "score", score: 2.7, confidence: 0.9 }]));
      editAnswers?.(answers, body);
      return Response.json({ model: "jev-1.13.0", answers, usage: { input_tokens: 1000, output_tokens: 10 } });
    }, ...options });
  return { service, calls, logs };
}

describe("Jev assistance boundaries", () => {
  test("accepts the Jev-specific server key and retains the generic alias", async () => {
    const calls: string[] = [];
    for (const env of [{ TYPESAFE_AI_JEV_API_KEY: "jev-key", TYPESAFE_API_KEY: "alias-key" }, { TYPESAFE_API_KEY: "alias-key" }]) {
      const service = createSemanticService({ env, onUsage: () => {}, fetchImpl: async (_url: string, init: RequestInit) => {
        calls.push((init.headers as Record<string, string>).Authorization);
        return Response.json({ answers: {} });
      } });
      expect(service.configured).toBe(true);
      await service.analyzeChat({ chatRequest: chat(), userId: "owner" });
    }
    expect(calls).toEqual(["Bearer jev-key", "Bearer alias-key"]);
  });

  test("only explicit boolean consent survives normalization; disabled/unconfigured calls use no network", async () => {
    expect(normalizeAISettings({ jevEnabled: "true" })).not.toHaveProperty("jevEnabled");
    expect(normalizeAISettings({ jevEnabled: true }).jevEnabled).toBe(true);
    expect(() => validateAIOptions({ jevEnabled: "true" })).toThrow("boolean");
    expect(validateAIOptions({ jevEnabled: true }).jevEnabled).toBe(true);
    const { service, calls } = harness();
    expect(await service.analyzeChat({ chatRequest: chat({ ai: {} }), userId: "owner" })).toBeNull();
    expect(calls).toHaveLength(0);
    const disabled = createSemanticService({ env: {}, fetchImpl: () => { throw new Error("must not fetch"); } });
    expect((await disabled.analyzeChat({ chatRequest: chat(), userId: "owner" })).warnings[0]).toContain("not configured");
  });

  test("selected context excludes other notes, private annotations, system messages and receipts", async () => {
    const { service, calls } = harness();
    await service.analyzeChat({ userId: "owner", chatRequest: chat({
      ai: { jevEnabled: true, mode: "balanced", contextScope: "selected", selectedConversationIds: ["second"] },
      notes: [{ content: "PRIVATE ANNOTATION" }],
      messages: [{ role: "system", content: "PRIVATE SYSTEM" }, { role: "user", content: "Question", execution: { secret: "PRIVATE RECEIPT" } }],
      workspaceContext: [
        { id: "outside", title: "OUTSIDE", content: "OUTSIDE SECRET", messages: [] },
        { id: "second", title: "Selected", content: "ALLOWED CONTENT", messages: [], notes: [{ content: "PRIVATE MARGIN" }] },
      ],
    }) });
    const sent = JSON.stringify(calls[0].body);
    expect(sent).toContain("ALLOWED CONTENT");
    for (const secret of ["PRIVATE", "OUTSIDE"]) expect(sent).not.toContain(secret);
    expect(calls[0].url).toBe("https://api.typesafe.ai/v1/systemone");
  });

  test("ranks comparable candidate scores while uncertain candidates keep their slots", async () => {
    const { service } = harness((answers) => {
      answers.context_0.score = 0.3;
      answers.context_1.confidence = 0.1;
      answers.context_2.score = 2.9;
    });
    const request = chat(); request.workspaceContext.push({ id: "third", title: "Third", content: "Direct answer", messages: [] });
    const result = await service.analyzeChat({ chatRequest: request, userId: "owner" });
    expect(result.contextOrder).toEqual(["third", "second", "first"]);
  });

  test("rejects invented choices and invalid scores independently without exposing extra provider fields", async () => {
    const { service } = harness((answers) => {
      answers.task.choice = "invented";
      answers.route = { type: "choice", choice: "excluded:secret", confidence: 1 };
      answers.context_0.score = 999;
      answers.context_1.confidence = 2;
    });
    const result = await service.analyzeChat({ chatRequest: chat(), userId: "owner", routes: [{ key: "allowed:model", serviceId: "openai-api", model: "model", tasks: ["writing"], description: "Writing" }] });
    expect(result).not.toHaveProperty("task");
    expect(result).not.toHaveProperty("routeKey");
    expect(result.contextOrder).toEqual(["first", "second"]);
    expect(result.warnings[0]).toContain("unavailable");
  });

  test("manual models get context scoring without model-selection questions", async () => {
    const { service, calls } = harness();
    await service.analyzeChat({ chatRequest: chat({ serviceId: "openai-api" }), userId: "owner", routes: [{ key: "other:model" }] });
    expect(Object.keys(calls[0].body.questions)).toEqual(["context_0", "context_1"]);
    const noAnalysis = await service.analyzeChat({ chatRequest: chat({ serviceId: "openai-api", ai: { jevEnabled: true, contextScope: "conversation" } }), userId: "owner" });
    expect(noAnalysis).toEqual({ warnings: [] });
    expect(calls).toHaveLength(1);
  });

  test("caches judgments by account and content, records cost without text or credentials", async () => {
    const { service, calls, logs } = harness();
    const args = { chatRequest: chat(), userId: "one" };
    await service.analyzeChat(args); await service.analyzeChat(args);
    expect(calls).toHaveLength(1);
    await service.analyzeChat({ ...args, userId: "two" });
    expect(calls).toHaveLength(2);
    const changed = chat(); changed.messages[0].content = "Different request";
    await service.analyzeChat({ ...args, chatRequest: changed });
    expect(calls).toHaveLength(3);
    expect(logs[0].estimatedCostUsd).toBeCloseTo(0.000042);
    expect(JSON.stringify(logs)).not.toContain("test-key");
    expect(JSON.stringify(logs)).not.toContain("Which approach");
  });

  test("per-account rate limits fall back without extra vendor calls", async () => {
    const { service, calls } = harness(undefined, { env: { TYPESAFE_API_KEY: "test-key", TYPESAFE_REQUESTS_PER_MINUTE: 1 } });
    await service.analyzeChat({ chatRequest: chat(), userId: "one" });
    const changed = chat(); changed.messages[0].content = "Another request";
    const result = await service.analyzeChat({ chatRequest: changed, userId: "one" });
    expect(result.warnings[0]).toContain("busy"); expect(calls).toHaveLength(1);
  });

  test("vendor failure and deadline use a safe fallback; user cancellation remains cancellation", async () => {
    const fail = createSemanticService({ env: { TYPESAFE_API_KEY: "secret" }, fetchImpl: async () => Response.json({ error: "secret private body" }, { status: 429 }) });
    expect((await fail.analyzeChat({ chatRequest: chat(), userId: "owner" })).warnings).toEqual(["Jev assistance is temporarily unavailable. Standard behavior was used."]);
    const slow = createSemanticService({ env: { TYPESAFE_API_KEY: "key", TYPESAFE_TIMEOUT_MS: 100 },
      fetchImpl: (_url: string, { signal }: any) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })) });
    expect((await slow.analyzeChat({ chatRequest: chat(), userId: "owner" })).warnings[0]).toContain("temporarily unavailable");
    const controller = new AbortController(); controller.abort();
    await expect(slow.analyzeChat({ chatRequest: chat(), userId: "owner", signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  test("workspace analysis validates consent/IDs and excludes private or unrecognized fields", async () => {
    expect(() => validateWorkspaceAnalysis(workspace({ enabled: false }))).toThrow("Enable Jev");
    expect(() => validateWorkspaceAnalysis(workspace({ items: [workspace().items[0], workspace().items[0]] }))).toThrow("unique");
    const { service, calls } = harness();
    const payload = workspace(); (payload.items[1] as any).notes = [{ content: "PRIVATE" }];
    const result = await service.analyzeWorkspace({ payload, userId: "owner" });
    expect(result.available).toBe(true);
    expect(result.related).toEqual([{ id: "note", score: 0.9 }]);
    expect(result.categories).toHaveLength(2);
    expect(JSON.stringify(calls[0].body)).not.toContain("PRIVATE");
    expect(calls[0].body.questions).not.toHaveProperty("related_0");
  });

  test("matches existing groups with validated choices and falls back on uncertain or unmatched material", async () => {
    const groups = [{ id: "project-story", name: "Story project", memberTitles: ["Character outline"], notes: "PRIVATE" }];
    const { service, calls } = harness((answers) => {
      answers.group_0 = { type: "choice", choice: "g0", confidence: 0.9 };
      answers.group_1 = { type: "choice", choice: "none", confidence: 0.95 };
    });
    const result = await service.analyzeWorkspace({ payload: workspace({ groups }), userId: "owner" });
    expect(result.groupSuggestions).toEqual([{ id: "current", groupId: "project-story", confidence: 0.9 }]);
    expect(result.categories).toHaveLength(2);
    expect(calls[0].body.state.groups).toEqual([{ name: "Story project", memberTitles: ["Character outline"] }]);
    expect(JSON.stringify(calls[0].body)).not.toContain("PRIVATE");
    expect(calls[0].body.questions.group_0.criteria.none).toContain("No existing group");
    const uncertain = harness((answers) => {
      answers.group_0 = { type: "choice", choice: "g0", confidence: 0.74 };
      answers.group_1 = { type: "choice", choice: "invented", confidence: 1 };
    });
    expect((await uncertain.service.analyzeWorkspace({ payload: workspace({ groups }), userId: "owner" })).groupSuggestions).toEqual([]);
  });

  test("group choices validate bounds and invalidate cached judgments when names or member examples change", async () => {
    const group = { id: "project", name: "Project", memberTitles: ["Original member"] };
    expect(() => validateWorkspaceAnalysis(workspace({ groups: [group, group] }))).toThrow("unique");
    expect(() => validateWorkspaceAnalysis(workspace({ groups: [ { ...group, id: "" } ] }))).toThrow("Existing groups");
    expect(() => validateWorkspaceAnalysis(workspace({ groups: Array.from({ length: 21 }, (_, i) => ({ ...group, id: String(i) })) }))).toThrow("20");
    expect(() => validateWorkspaceAnalysis(workspace({ groups: [{ ...group, memberTitles: ["a", "b", "c"] }] }))).toThrow("two member");
    const { service, calls } = harness();
    const args = { payload: workspace({ groups: [group] }), userId: "owner" };
    await service.analyzeWorkspace(args); await service.analyzeWorkspace(args);
    expect(calls).toHaveLength(1);
    await service.analyzeWorkspace({ ...args, payload: workspace({ groups: [{ ...group, name: "Renamed" }] }) });
    await service.analyzeWorkspace({ ...args, payload: workspace({ groups: [{ ...group, memberTitles: ["New member"] }] }) });
    await service.analyzeWorkspace({ ...args, userId: "other-owner" });
    expect(calls).toHaveLength(4);
  });

  test("existing group matching remains bounded for a full workspace", async () => {
    const { service, calls } = harness();
    const groups = Array.from({ length: 20 }, (_, i) => ({ id: `group-${i}`, name: "n".repeat(80), memberTitles: ["a".repeat(80), "b".repeat(80)] }));
    const items = Array.from({ length: 40 }, (_, i) => ({ id: `item-${i}`, title: `Item ${i}`, kind: "note", content: "x".repeat(6000) }));
    const result = await service.analyzeWorkspace({ payload: workspace({ groups, items }), userId: "owner" });
    expect(result.available).toBe(true);
    expect(result.categories).toHaveLength(40);
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.length).toBeLessThan(40);
    for (const call of calls) {
      expect(Buffer.byteLength(JSON.stringify(call.body.state))).toBeLessThan(28000);
      expect(Buffer.byteLength(JSON.stringify(call.body))).toBeLessThanOrEqual(60000);
      for (const [id, question] of Object.entries(call.body.questions)) expect(Buffer.byteLength(JSON.stringify({ ...call.body, questions: { [id]: question } }))).toBeLessThanOrEqual(30000);
    }
  });

  test("forty workspace items use bounded batches and return only supplied related IDs", async () => {
    const { service, calls } = harness();
    const payload = workspace({ items: Array.from({ length: 40 }, (_, i) => ({ id: `item-${i}`, title: `Item ${i}`, kind: "note", content: "x".repeat(6000) })) });
    const result = await service.analyzeWorkspace({ payload, userId: "owner" });
    expect(result.available).toBe(true); expect(result.categories).toHaveLength(40);
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.length).toBeLessThan(40);
    for (const call of calls) {
      expect(Buffer.byteLength(JSON.stringify(call.body.state))).toBeLessThan(28000);
      expect(Buffer.byteLength(JSON.stringify(call.body))).toBeLessThanOrEqual(60000);
      for (const [id, question] of Object.entries(call.body.questions)) expect(Buffer.byteLength(JSON.stringify({ ...call.body, questions: { [id]: question } }))).toBeLessThanOrEqual(30000);
    }
    expect(result.related).toHaveLength(5);
    expect(result.related.every((item: any) => payload.items.some((candidate: any) => candidate.id === item.id))).toBe(true);
  });
});
