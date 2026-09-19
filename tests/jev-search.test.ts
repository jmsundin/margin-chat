import { describe, expect, test } from "bun:test";
import { createEmptyState, createStandaloneNoteConversation } from "../client/src/initialState";
import { buildSearchExploration } from "../client/src/lib/searchExploration";
import { applyJevSearchRanking, buildJevSearchSnapshot, parseJevSearchResult } from "../client/src/lib/jevSearch";
import { createSemanticService } from "../server/semantic/index.mjs";
import { validateSearchAnalysis } from "../server/semantic/search.mjs";

function fixture() {
  const state = createEmptyState();
  const chat = state.conversations[state.rootId];
  chat.title = "Reading project";
  chat.messages = [
    { id: "reply", role: "assistant", content: "We decided to build a reading app.\n\nAn alternative is a simple library.", createdAt: chat.createdAt },
    { id: "system", role: "system", content: "PRIVATE SYSTEM", createdAt: chat.createdAt },
    { id: "standalone-note-context-old", role: "user", content: "PRIVATE OLD CONTEXT", createdAt: chat.createdAt },
  ];
  const note = createStandaloneNoteConversation({ id: "note", noteId: "body" });
  note.notes![0].content = "Reading evidence suggests a weekly reflection.";
  chat.notes = [{ ...note.notes![0], id: "margin", kind: "comment", content: "PRIVATE MARGIN reading" }];
  note.notes!.push({ ...note.notes![0], id: "side", kind: "side-chat", content: "PRIVATE SIDE reading" });
  state.conversations.note = note;
  return { state, chat, note };
}
function payload() {
  return { enabled: true, query: "reading decisions", items: [
    { id: "first", title: "First", sourceKind: "message", role: "assistant", content: "A reading decision" },
    { id: "second", title: "Second", sourceKind: "standalone-note", content: "Reading evidence" },
  ], facets: [{ id: "purpose:decision", label: "Decisions", itemIds: ["first"] }] };
}

describe("Jev search shortlist boundaries", () => {
  test("rebuilds exact primary passages and excludes private, stale, synthetic and system sources", () => {
    const { state, chat } = fixture();
    const search = buildSearchExploration({ conversations: state.conversations, query: "reading" });
    const message = search.results.find((result) => result.evidence.sourceKind === "message")!;
    const attempts = [
      { ...message, id: "forged-system", evidence: { ...message.evidence, messageId: "system", quote: "PRIVATE SYSTEM", startOffset: 0, endOffset: 14 } },
      { ...message, id: "forged-context", evidence: { ...message.evidence, messageId: "standalone-note-context-old", quote: "PRIVATE OLD CONTEXT", startOffset: 0, endOffset: 19 } },
      { ...message, id: "stale", evidence: { ...message.evidence, quote: "STALE" } },
      { ...message, id: "tampered-preview", passage: "PRIVATE PREVIEW", preview: "PRIVATE PREVIEW" },
    ];
    const snapshot = buildJevSearchSnapshot({ conversations: state.conversations, query: "reading", results: [...attempts, ...search.results], facets: search.facets, currentConversationId: chat.id })!;
    const sent = JSON.stringify(snapshot);
    expect(sent).not.toContain("PRIVATE");
    expect(sent).not.toContain("STALE");
    expect(snapshot.items.some((item) => item.id === "tampered-preview" && item.content.includes("reading"))).toBe(true);
    expect(snapshot.items.some((item) => item.sourceKind === "standalone-note")).toBe(true);
    expect(snapshot.facets.every((facet) => facet.itemIds.length > 0 && facet.itemIds.every((id) => snapshot.items.some((item) => item.id === id)))).toBe(true);
    expect(snapshot.facets.some((facet) => facet.id === "type:annotation")).toBe(false);
  });

  test("shortlists twenty eligible passages while preserving complete local counts and results", () => {
    const { state } = fixture();
    for (let i = 0; i < 60; i++) {
      const note = createStandaloneNoteConversation({ id: `more-${i}`, noteId: `body-${i}` });
      note.notes![0].content = `Reading evidence number ${i}`;
      state.conversations[note.id] = note;
    }
    const search = buildSearchExploration({ conversations: state.conversations, query: "reading" });
    const before = JSON.stringify(search);
    const snapshot = buildJevSearchSnapshot({ conversations: state.conversations, query: "reading", ...search })!;
    expect(snapshot.items).toHaveLength(20);
    expect(search.totalCount).toBeGreaterThan(60);
    expect(JSON.stringify(search)).toBe(before);
    expect(buildJevSearchSnapshot({ conversations: state.conversations, query: "", ...search })).toBeNull();
  });

  test("accepts only grounded valid scores/facets and ranks reviewed slots without removing results", () => {
    const snapshot = { query: "reading", items: payload().items as any, facets: payload().facets };
    const parsed = parseJevSearchResult({ available: true, scores: [
      { id: "first", score: 0.1, confidence: 0.9 }, { id: "second", score: 0.9, confidence: 0.9 },
      { id: "invented", score: 1, confidence: 1 }, { id: "first", score: 99, confidence: 1 },
    ], suggestedFacetIds: ["purpose:decision", "invented", "purpose:decision"] }, snapshot);
    expect(parsed.scores).toHaveLength(2);
    expect(parsed.suggestedFacetIds).toEqual(["purpose:decision"]);
    const results = [{ id: "first" }, { id: "private", localOnly: true }, { id: "unknown" }, { id: "second" }];
    const ranked = applyJevSearchRanking(results, { first: 0.1, second: 0.9, private: 1 });
    expect(ranked.map((item) => item.id)).toEqual(["second", "private", "unknown", "first"]);
    expect(results.map((item) => item.id)).toEqual(["first", "private", "unknown", "second"]);
    expect(parseJevSearchResult({ available: false, scores: parsed.scores, suggestedFacetIds: parsed.suggestedFacetIds }, snapshot).scores).toEqual([]);
  });
});

describe("Jev search server", () => {
  test("requires consent, bounded unique candidates and filters grounded in supplied primary sources", () => {
    expect(() => validateSearchAnalysis({ ...payload(), enabled: false })).toThrow("Enable Jev");
    expect(() => validateSearchAnalysis({ ...payload(), items: Array(21).fill(payload().items[0]) })).toThrow("20");
    expect(() => validateSearchAnalysis({ ...payload(), items: [payload().items[0], payload().items[0]] })).toThrow("unique");
    for (const item of [ { ...payload().items[0], role: "system" }, { ...payload().items[0], sourceKind: "annotation" } ]) {
      expect(() => validateSearchAnalysis({ ...payload(), items: [item] })).toThrow("primary source");
    }
    expect(() => validateSearchAnalysis({ ...payload(), facets: [{ ...payload().facets[0], itemIds: ["invented"] }] })).toThrow("supplied passages");
  });

  test("makes one bounded judgment request, strips private extras and rejects uncertain or malformed answers", async () => {
    const calls: any[] = [];
    const service = createSemanticService({ env: { TYPESAFE_API_KEY: "test-key" }, onUsage: () => {}, fetchImpl: async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      return Response.json({ answers: {
        passage_0: { type: "score", score: 2.7, confidence: 0.9, secret: "PRIVATE" },
        passage_1: { type: "score", score: 2.9, confidence: 0.1 },
        facet_0: { type: "score", score: 2.8, confidence: 0.9 },
        facet_1: { type: "score", score: 999, confidence: 1 },
      } });
    } });
    const input = payload();
    (input.items[0] as any).notes = [{ content: "PRIVATE MARGIN" }];
    (input as any).system = "PRIVATE SYSTEM";
    const result = await service.analyzeSearch({ payload: input, userId: "owner" });
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0])).not.toContain("PRIVATE");
    expect(calls[0].state.items[0]).not.toHaveProperty("id");
    expect(result.scores).toEqual([{ id: "first", score: 0.9, confidence: 0.9 }]);
    expect(result.suggestedFacetIds).toEqual(["purpose:decision"]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    await service.analyzeSearch({ payload: input, userId: "owner" });
    expect(calls).toHaveLength(1);
    await service.analyzeSearch({ payload: input, userId: "other-account" });
    expect(calls).toHaveLength(2);
  });

  test("bounds multilingual text and keeps local fallback on unavailable or cancelled service", async () => {
    const calls: any[] = [];
    const service = createSemanticService({ env: { TYPESAFE_API_KEY: "test-key" }, onUsage: () => {}, fetchImpl: async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      return Response.json({ answers: {} });
    } });
    await service.analyzeSearch({ payload: { ...payload(), items: Array.from({ length: 20 }, (_, i) => ({ ...payload().items[0], id: String(i), title: "📚".repeat(200), content: "資料".repeat(1000) })), facets: [] }, userId: "owner" });
    expect(calls).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(calls[0].state))).toBeLessThan(28000);
    const fallback = createSemanticService({ env: {}, fetchImpl: () => { throw new Error("No network"); } });
    expect(await fallback.analyzeSearch({ payload: payload(), userId: "owner" })).toMatchObject({ available: false, scores: [], suggestedFacetIds: [] });
    const controller = new AbortController(); controller.abort();
    await expect(service.analyzeSearch({ payload: payload(), userId: "owner", signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});

test("search hook gates preference, debounces, caches and cancels stale/account work", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/jevSearchHarness.tsx"], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "Jev search hook checks passed\n", stderr: "" });
});
