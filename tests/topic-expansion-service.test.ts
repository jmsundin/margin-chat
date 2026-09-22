import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { createTopicExpansionService, validateGeneratedTopicExpansion, validateTopicExpansionRequest } from "../server/topicExpansion/index.mjs";
import { createApiHandler } from "../server/routes/api.mjs";
import { isTopicExpansion } from "../client/src/lib/topicExpansion";

const payload = {
  topic: { id: "Q1340474", label: "Systems thinking", description: "An approach to understanding complex systems", wikidataUrl: "https://www.wikidata.org/wiki/Q1340474" },
  noteContent: "How do feedback loops affect a system?", existingTitles: ["Existing idea"], serviceId: "backend-services",
};
const draft = () => ({ nodes: [
  { id: "n1", parentId: null, title: "Feedback loops", content: "A change can reinforce or counteract itself through feedback." },
  { id: "n2", parentId: "n1", title: "Balancing feedback", content: "Balancing feedback can move a system toward a target." },
] });
const user = { id: "owner", billing: { hasAccess: true } };
const invalidMessage = "The AI returned an invalid topic expansion. Try again.";

describe("bounded topic expansion", () => {
  test("passes only selected context through authenticated provider execution", async () => {
    const calls: any[] = [], progress: string[] = [];
    const expand = createTopicExpansionService({ executeChatReply: async (args: any) => { calls.push(args); return { reply: JSON.stringify(draft()) }; } });
    const result = await expand({ payload: { ...payload, workspaceContext: "PRIVATE UNRELATED NOTE", ai: { mode: "fast", contextScope: "workspace", selectedConversationIds: ["private"], allowedProviders: ["openai"] } }, user, onProgress: (message: string) => progress.push(message) });
    expect(result).toEqual(draft()); expect(isTopicExpansion(result)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].user).toBe(user);
    expect(calls[0].operation).toBe("topic-expansion");
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
    expect(calls[0].payload.ai).toEqual({ mode: "fast", contextScope: "conversation", selectedConversationIds: [], allowedProviders: ["openai"] });
    expect(JSON.stringify(calls[0].payload)).not.toContain("PRIVATE UNRELATED NOTE");
    expect(JSON.stringify(calls[0].payload)).not.toContain(payload.topic.wikidataUrl);
    expect(calls[0].payload.messages[0].content).toContain("NOT verified");
    expect(JSON.parse(calls[0].payload.messages[1].content).noteContent).toBe(payload.noteContent);
    expect(progress).toHaveLength(2);
  });

  test("rejects invalid input and provider selection before generation", async () => {
    let calls = 0;
    const expand = createTopicExpansionService({ executeChatReply: async () => { calls++; return { reply: JSON.stringify(draft()) }; } });
    for (const bad of [
      { ...payload, noteContent: "x".repeat(6001) },
      { ...payload, existingTitles: Array(41).fill("title") },
      { ...payload, existingTitles: ["x".repeat(201)] },
      { ...payload, topic: { ...payload.topic, wikidataUrl: "https://example.com/wiki/Q1" } },
      { ...payload, topic: { ...payload.topic, description: "x".repeat(2001) } },
      { ...payload, modelId: "nonexistent-model" },
      { ...payload, serviceId: "nonexistent-provider" },
    ]) await expect(expand({ payload: bad, user })).rejects.toMatchObject({ statusCode: 400 });
    expect(calls).toBe(0);
    expect(validateTopicExpansionRequest({ ...payload, topic: { ...payload.topic, wikidataUrl: undefined } }).topic.wikidataUrl).toBeUndefined();
  });

  test("validates forward parent references and strips unrelated output fields", () => {
    const value = draft(); value.nodes.reverse();
    const result = validateGeneratedTopicExpansion(JSON.stringify({ ...value, source: "https://invented.example", nodes: value.nodes.map((node) => ({ ...node, url: "https://invented.example" })) }), payload);
    expect(result).toEqual(value);
    expect(isTopicExpansion(result)).toBe(true);
  });

  test("rejects cycles, missing parents, excessive depth, duplicates and excess output atomically", () => {
    const mutations: Array<(value: any) => void> = [
      (value) => { value.nodes[0].parentId = "n2"; },
      (value) => { value.nodes[0].parentId = "missing"; },
      (value) => { value.nodes[1].parentId = "n2"; },
      (value) => { value.nodes.push({ id: "n3", parentId: "n2", title: "Too deep", content: "Third level" }); },
      (value) => { value.nodes[1].id = "n1"; },
      (value) => { value.nodes[1].title = "  FEEDBACK   LOOPS "; },
      (value) => { value.nodes[1].content = "x".repeat(901); },
      (value) => { value.nodes[1].title = "x".repeat(101); },
      (value) => { value.nodes[1].parentId = ["n1", null]; },
      (value) => { value.nodes = Array.from({ length: 7 }, (_, i) => ({ id: `n${i}`, parentId: null, title: `Title ${i}`, content: "Draft" })); },
      (value) => { value.nodes = Array.from({ length: 6 }, (_, i) => ({ id: `n${i}`, parentId: null, title: `Title ${i}`, content: "x".repeat(900) })); },
      (value) => { value.nodes.pop(); },
    ];
    for (const mutate of mutations) {
      const value = draft(); mutate(value);
      expect(() => validateGeneratedTopicExpansion(JSON.stringify(value), payload)).toThrow(invalidMessage);
      expect(isTopicExpansion(value)).toBe(false);
    }
    for (const title of [payload.topic.label, payload.existingTitles[0]]) {
      const value = draft(); value.nodes[0].title = title;
      expect(() => validateGeneratedTopicExpansion(JSON.stringify(value), payload)).toThrow(invalidMessage);
    }
    for (const reply of ["not json", "null", JSON.stringify(draft()).slice(0, -1), " ".repeat(18001)]) {
      expect(() => validateGeneratedTopicExpansion(reply, payload)).toThrow(invalidMessage);
    }
  });

  test("rejects fabricated links, HTML and executable-format content", () => {
    for (const content of ["See https://example.com", "See www.example.com", "[source](relative/path)", "[source][ref]", "[ref]: /citation", "<script>alert(1)</script>", "javascript:alert(1)", "data:text/html;base64,AA", "`run this`", "~~~python\nprint(1)\n~~~"]) {
      const value = draft(); value.nodes[0].content = content;
      expect(() => validateGeneratedTopicExpansion(JSON.stringify(value), payload)).toThrow(invalidMessage);
      expect(isTopicExpansion(value)).toBe(false);
    }
  });

  test("permits one active request per account and releases the gate after success", async () => {
    let finish!: (value: any) => void;
    let calls = 0;
    const expand = createTopicExpansionService({ executeChatReply: () => { calls++; return new Promise((resolve) => { finish = resolve; }); } });
    const pending = expand({ payload, user });
    await Promise.resolve();
    await expect(expand({ payload, user })).rejects.toMatchObject({ statusCode: 429 });
    expect(calls).toBe(1);
    finish({ reply: JSON.stringify(draft()) }); await pending;
    const next = expand({ payload, user }); await Promise.resolve();
    finish({ reply: JSON.stringify(draft()) }); await next;
    expect(calls).toBe(2);
  });

  test("cancellation stops waiting and keeps singleflight until the provider settles", async () => {
    const controller = new AbortController();
    let finish!: (value: any) => void, providerSignal!: AbortSignal;
    const expand = createTopicExpansionService({ executeChatReply: ({ signal }: any) => { providerSignal = signal; return new Promise((resolve) => { finish = resolve; }); } });
    const pending = expand({ payload, user, signal: controller.signal }); await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(providerSignal.aborted).toBe(true);
    await expect(expand({ payload, user })).rejects.toMatchObject({ statusCode: 429 });
    finish({ reply: JSON.stringify(draft()) }); await Promise.resolve();
  });

  test("deadline aborts a stalled provider and pre-cancellation never invokes it", async () => {
    let calls = 0, providerSignal!: AbortSignal, finish!: (value: any) => void;
    const expand = createTopicExpansionService({ deadlineMs: 10, executeChatReply: ({ signal }: any) => { calls++; providerSignal = signal; return new Promise((resolve) => { finish = resolve; }); } });
    const cancelled = new AbortController(); cancelled.abort();
    await expect(expand({ payload, user, signal: cancelled.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(0);
    await expect(expand({ payload, user })).rejects.toMatchObject({ statusCode: 504 });
    expect(providerSignal.aborted).toBe(true);
    finish({ reply: JSON.stringify(draft()) });
  });

  test("limits generated deltas and retains clear billing/provider failures", async () => {
    const expand = createTopicExpansionService({ executeChatReply: async ({ handlers, signal }: any) => {
      expect(signal.aborted).toBe(false); handlers.onDelta("x".repeat(18001)); return { reply: JSON.stringify(draft()) };
    } });
    await expect(expand({ payload, user })).rejects.toMatchObject({ statusCode: 502, message: invalidMessage });
    const failure = Object.assign(new Error("Usage limit reached."), { statusCode: 402 });
    const denied = createTopicExpansionService({ executeChatReply: async () => { throw failure; } });
    await expect(denied({ payload, user })).rejects.toBe(failure);
  });
});

describe("topic expansion API", () => {
  let server: ReturnType<typeof createServer>, origin: string;
  const calls: any[] = [];
  const headers = { "Content-Type": "application/json", "X-Test-Signed-In": "1", "X-Margin-Vault-User": "owner" };
  beforeAll(async () => {
    server = createServer(createApiHandler({
      runtimeConfig: { host: "127.0.0.1", port: 0 },
      authService: { getAuthContext: async (request: any) => ({ user: request.headers["x-test-signed-in"] ? user : null }) },
      topicExpansionService: async (args: any) => {
        calls.push(args);
        if (args.payload.fail) { args.onProgress("Drafting…"); throw Object.assign(new Error("Provider unavailable."), { statusCode: 503 }); }
        return draft();
      },
    }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });

  test("rejects signed-out, stale-account and cross-site requests before generation", async () => {
    const before = calls.length;
    for (const [overrides, status] of [
      [{ "X-Test-Signed-In": "" }, 401], [{ "X-Margin-Vault-User": "other" }, 409],
      [{ "Sec-Fetch-Site": "cross-site" }, 403], [{ "Content-Type": "text/plain" }, 403],
    ] as const) {
      const response = await fetch(`${origin}/api/graph/topic`, { method: "POST", headers: { ...headers, ...overrides }, body: JSON.stringify(payload) });
      expect(response.status).toBe(status);
    }
    expect(calls).toHaveLength(before);
  });

  test("bounds request bytes before generation", async () => {
    const before = calls.length;
    const response = await fetch(`${origin}/api/graph/topic`, { method: "POST", headers, body: JSON.stringify({ noteContent: "x".repeat(66000) }) });
    expect(response.status).toBe(413); expect(calls).toHaveLength(before);
  });

  test("streams a completed draft with account identity and private response headers", async () => {
    const response = await fetch(`${origin}/api/graph/topic`, { method: "POST", headers, body: JSON.stringify({ ...payload, user: { id: "attacker" } }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect(response.headers.get("cache-control")).toContain("private, no-store");
    expect(JSON.parse((await response.text()).trim())).toEqual({ type: "done", expansion: draft() });
    expect(calls.at(-1).user).toBe(user); expect(calls.at(-1).signal).toBeInstanceOf(AbortSignal);
  });

  test("streamed failure never sends a partial done event", async () => {
    const response = await fetch(`${origin}/api/graph/topic`, { method: "POST", headers, body: JSON.stringify({ fail: true }) });
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(events).toEqual([{ type: "progress", message: "Drafting…" }, { type: "error", error: "Provider unavailable.", statusCode: 503 }]);
  });
});
