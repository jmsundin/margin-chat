import { describe, expect, test } from "bun:test";
import {
  aggregateGraphEdges,
  getCollapsedGraphGroupRect,
  getGraphConceptConversationIds,
  getGraphScopeConversationIds,
  getGraphWorldBounds,
  graphConceptStorageKey,
  normalizeGraphConcepts,
  readGraphConcepts,
  resolveGraphEvidence,
  searchGraphSources,
  writeGraphConcepts,
  type GraphConcept,
  type GraphEvidenceRef,
} from "../client/src/lib/graphExploration";
import type { Conversation, ConversationGroup, ThreadSummary } from "../client/src/types";
import type { ConversationGraphEdgePlacement, ConversationGraphGroupPlacement, ConversationGraphScene } from "../client/src/lib/conversationGraph";

const createdAt = "2026-09-01T00:00:00.000Z";
function conversation(id: string, overrides: Partial<Conversation> = {}): Conversation {
  return {
    id, title: id, parentId: null, childIds: [], branchAnchor: null,
    serviceId: "backend-services", modelId: "smart-routing", messages: [], notes: [],
    createdAt, updatedAt: createdAt, ...overrides,
  };
}
function sourceConversation(content: string): Record<string, Conversation> {
  return { root: conversation("root", { messages: [{ id: "message", role: "assistant", content, createdAt }] }) };
}
const messageSource: GraphEvidenceRef = { conversationId: "root", sourceKind: "message", messageId: "message", quote: "alpha", startOffset: 0, endOffset: 5 };
function group(id: string, conversationIds: string[]): ConversationGroup {
  return { id, conversationIds, name: id, collapsed: true, color: "#6f88ff" };
}

describe("graph exploration scopes", () => {
  const conversations = {
    root: conversation("root"),
    child: conversation("child", { parentId: "root" }),
    sibling: conversation("sibling", { parentId: "root" }),
    grandchild: conversation("grandchild", { parentId: "child" }),
    leaf: conversation("leaf", { parentId: "grandchild" }),
    other: conversation("other"),
  };
  const groups = { research: group("research", ["child", "other", "missing", "child"]) };
  test("group membership does not silently pull in descendants or unrelated ancestry", () => {
    expect([...getGraphScopeConversationIds({ scope: { kind: "group", groupId: "research" }, conversations, groups })]).toEqual(["child", "other"]);
    expect([...getGraphScopeConversationIds({ scope: { kind: "ungrouped" }, conversations, groups })]).toEqual(["root", "sibling", "grandchild", "leaf"]);
  });
  test("category scopes include whole root subtrees even when child lists are stale", () => {
    const threads = [{ id: "root", categoryId: "research" }, { id: "other", categoryId: "coding" }] as ThreadSummary[];
    expect(getGraphScopeConversationIds({ scope: { kind: "category", categoryId: "research" }, conversations, threads }))
      .toEqual(new Set(["root", "child", "sibling", "grandchild", "leaf"]));
  });
  test("focus keeps ancestry but expands only the requested local depth", () => {
    expect(getGraphScopeConversationIds({ scope: { kind: "focus", conversationId: "grandchild", depth: 0 }, conversations }))
      .toEqual(new Set(["grandchild", "child", "root"]));
    expect(getGraphScopeConversationIds({ scope: { kind: "focus", conversationId: "grandchild", depth: 1 }, conversations }))
      .toEqual(new Set(["grandchild", "leaf", "child", "root"]));
    expect(getGraphScopeConversationIds({ scope: { kind: "focus", conversationId: "grandchild", depth: 3 }, conversations }))
      .toEqual(new Set(["grandchild", "leaf", "child", "root", "sibling"]));
  });
  test("cycles and deleted focus targets terminate safely", () => {
    const cyclic = { a: conversation("a", { parentId: "b" }), b: conversation("b", { parentId: "a" }) };
    expect(getGraphScopeConversationIds({ scope: { kind: "focus", conversationId: "a", depth: 20 }, conversations: cyclic })).toEqual(new Set(["a", "b"]));
    expect(getGraphScopeConversationIds({ scope: { kind: "focus", conversationId: "gone", depth: 1 }, conversations })).toEqual(new Set());
  });
  test("concept memberships span conversations, allow overlap, and count a conversation once", () => {
    const shared: GraphEvidenceRef = { conversationId: "child", sourceKind: "conversation" };
    const concepts: GraphConcept[] = [
      { id: "a", label: "A", description: "", members: [shared, { ...shared, sourceKind: "message", messageId: "second" }, { conversationId: "other", sourceKind: "conversation" }] },
      { id: "b", label: "B", description: "", members: [shared, { conversationId: "deleted", sourceKind: "conversation" }] },
    ];
    expect(getGraphConceptConversationIds(concepts[0], conversations)).toEqual(new Set(["child", "other"]));
    expect(getGraphScopeConversationIds({ scope: { kind: "concept", conceptId: "b" }, conversations, concepts })).toEqual(new Set(["child"]));
  });
});

describe("complete graph source search", () => {
  test("finds old sources beyond forty items and old messages within a conversation", () => {
    const conversations = Object.fromEntries(Array.from({ length: 85 }, (_, index) => [`item-${index}`, conversation(`item-${index}`, {
      updatedAt: `2026-09-${String(28 - index % 28).padStart(2, "0")}T00:00:00.000Z`,
      messages: [{ id: `m-${index}`, role: "user", content: `Evidence needle ${index}`, createdAt }],
    })]));
    conversations["item-84"].messages.push({ id: "recent", content: "A recent unrelated message", role: "assistant", createdAt });
    const results = searchGraphSources(conversations, "needle");
    expect(results).toHaveLength(85);
    expect(results.some((result) => result.evidence.conversationId === "item-84" && result.evidence.messageId === "m-84")).toBe(true);
    for (const result of results) expect(resolveGraphEvidence(conversations, result.evidence).status).toBe("exact");
  });
  test("searches only the primary standalone note and excludes private notes and synthetic note messages", () => {
    const conversations = {
      chat: conversation("chat", { notes: [{ id: "margin", content: "private-needle", kind: "comment", sourceMessageId: null, startOffset: null, endOffset: null, quote: null, createdAt, updatedAt: createdAt }] }),
      note: conversation("note", {
        kind: "note",
        messages: [{ id: "context", role: "user", content: "synthetic-needle", createdAt }],
        notes: [
          { id: "primary", kind: "standalone", content: "public-needle", sourceMessageId: null, startOffset: null, endOffset: null, quote: null, createdAt, updatedAt: createdAt },
          { id: "side", kind: "side-chat", content: "private-needle", sourceMessageId: null, startOffset: null, endOffset: null, quote: null, createdAt, updatedAt: createdAt },
        ],
      }),
    };
    expect(searchGraphSources(conversations, "private-needle")).toEqual([]);
    expect(searchGraphSources(conversations, "synthetic-needle")).toEqual([]);
    expect(searchGraphSources(conversations, "public-needle")[0].evidence).toMatchObject({ sourceKind: "standalone-note", noteId: "primary", quote: "public-needle" });
    expect(resolveGraphEvidence(conversations, { conversationId: "note", sourceKind: "standalone-note", noteId: "side" }).status).toBe("missing");
    expect(resolveGraphEvidence(conversations, { conversationId: "chat", sourceKind: "standalone-note", noteId: "margin" }).status).toBe("missing");
  });
  test("treats search as literal text and preserves offsets after Unicode text", () => {
    const conversations = sourceConversation("İstanbul 🙂 [a+b] Needle");
    const result = searchGraphSources(conversations, "[a+b]")[0];
    expect(result.evidence).toMatchObject({ quote: "[a+b]", startOffset: 12, endOffset: 17 });
    expect(resolveGraphEvidence(conversations, result.evidence).highlight).toEqual({ startOffset: 12, endOffset: 17 });
    expect(searchGraphSources(conversations, "needle")[0].evidence.quote).toBe("Needle");
  });
  test("blank search gives one representative evidence source per conversation", () => {
    const conversations = { ...sourceConversation("Earlier alpha"), empty: conversation("empty") };
    conversations.root.messages.push({ id: "latest", role: "assistant", content: "Current summary", createdAt });
    const results = searchGraphSources(conversations, "  ");
    expect(results).toHaveLength(2);
    expect(results.find((result) => result.evidence.conversationId === "root")?.evidence.messageId).toBe("latest");
    expect(results.find((result) => result.evidence.conversationId === "empty")?.evidence.sourceKind).toBe("conversation");
  });
});

describe("graph evidence resolution", () => {
  test("validates offsets and recovers a uniquely moved quote", () => {
    expect(resolveGraphEvidence(sourceConversation("alpha beta"), messageSource)).toMatchObject({ status: "exact", highlight: { startOffset: 0, endOffset: 5 } });
    expect(resolveGraphEvidence(sourceConversation("new alpha beta"), messageSource)).toMatchObject({ status: "recovered", highlight: { startOffset: 4, endOffset: 9 }, evidence: { startOffset: 4, endOffset: 9 } });
  });
  test("does not highlight edited or ambiguously relocated passages", () => {
    expect(resolveGraphEvidence(sourceConversation("delta beta"), messageSource)).toMatchObject({ status: "stale", highlight: null });
    expect(resolveGraphEvidence(sourceConversation("new alpha then alpha"), messageSource)).toMatchObject({ status: "stale", highlight: null });
    // A valid original offset still disambiguates an unchanged repeated quote.
    expect(resolveGraphEvidence(sourceConversation("alpha then alpha"), messageSource).status).toBe("exact");
  });
  test("does not accept offsets without a quote, even if they are in range", () => {
    expect(resolveGraphEvidence(sourceConversation("alpha beta"), { ...messageSource, quote: undefined })).toMatchObject({ status: "stale", highlight: null });
    expect(resolveGraphEvidence(sourceConversation("alpha beta"), { ...messageSource, startOffset: -10, endOffset: Infinity })).toMatchObject({ status: "recovered", highlight: { startOffset: 0, endOffset: 5 } });
  });
  test("deleted items and sources never fall back to another source's coincidental text", () => {
    expect(resolveGraphEvidence({}, messageSource)).toMatchObject({ status: "missing", content: null, highlight: null });
    expect(resolveGraphEvidence(sourceConversation("alpha"), { ...messageSource, messageId: "deleted" })).toMatchObject({ status: "missing", highlight: null });
    expect(resolveGraphEvidence(sourceConversation("alpha"), { ...messageSource, sourceKind: "standalone-note", noteId: undefined })).toMatchObject({ status: "missing", highlight: null });
    expect(resolveGraphEvidence({}, { ...messageSource, conversationId: "toString" })).toMatchObject({ status: "missing", highlight: null });
  });
  test("conversation evidence opens the conversation without a misleading passage highlight", () => {
    expect(resolveGraphEvidence(sourceConversation("alpha"), { ...messageSource, sourceKind: "conversation" })).toMatchObject({ status: "exact", content: "root", highlight: null });
  });
});

describe("account-scoped concepts", () => {
  const concept: GraphConcept = { id: "concept", label: "Design", description: "Shared decisions", members: [messageSource] };
  test("validates membership and deduplicates locally without destroying overlap between concepts", () => {
    const normalized = normalizeGraphConcepts([
      { ...concept, members: [messageSource, messageSource, { conversationId: "root", sourceKind: "private-note" }, { sourceKind: "message", conversationId: "root" }] },
      { ...concept, id: "other" }, { ...concept, label: "Duplicate ID" }, null,
    ]);
    expect(normalized).toHaveLength(2);
    expect(normalized[0].members).toEqual([messageSource]);
    expect(normalized[1].members).toEqual([messageSource]);
  });
  test("keeps accounts separate and preserves stale IDs for explicit inspection", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    expect(writeGraphConcepts("alice", [concept], storage)).toBe(true);
    expect(readGraphConcepts("alice", storage)).toEqual([concept]);
    expect(readGraphConcepts("bob", storage)).toEqual([]);
    expect(graphConceptStorageKey("a:b")).not.toBe(graphConceptStorageKey("a%3Ab"));
    expect(writeGraphConcepts("", [concept], storage)).toBe(false);
    values.set(graphConceptStorageKey("alice"), "broken JSON");
    expect(readGraphConcepts("alice", storage)).toEqual([]);
    values.set(graphConceptStorageKey("alice"), JSON.stringify({ version: 99, concepts: [concept] }));
    expect(readGraphConcepts("alice", storage)).toEqual([]);
  });
  test("blocked browser storage is an explicit failure and never crashes", () => {
    const storage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("quota"); } };
    expect(readGraphConcepts("alice", storage)).toEqual([]);
    expect(writeGraphConcepts("alice", [concept], storage)).toBe(false);
  });
});

describe("map geometry and collapsed structural links", () => {
  test("world bounds include negative coordinates and typed placement metadata", () => {
    const placement = { conversationId: "root", depth: 0, x: -900, y: -500, width: 200, height: 100 };
    expect(getGraphWorldBounds([placement, { x: 500, y: 300, width: 100, height: 100 }], 20)).toEqual({ left: -920, top: -520, right: 620, bottom: 420, width: 1540, height: 940 });
    expect(getGraphWorldBounds([{ x: NaN, y: 0, width: 20, height: 20 }])).toEqual({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
  });
  const groups: ConversationGraphGroupPlacement[] = [
    { groupId: "a", conversationIds: ["a1", "a2"], x: -400, y: -100, width: 400, height: 300 },
    { groupId: "b", conversationIds: ["b1", "b2"], x: 200, y: 0, width: 500, height: 400 },
  ];
  const makeEdge = (parentConversationId: string, childConversationId: string, isSelectedPath = false): ConversationGraphEdgePlacement => ({ parentConversationId, childConversationId, startX: 10, startY: 20, endX: 30, endY: 40, isSelectedPath });
  const scene: ConversationGraphScene = {
    width: 1200, height: 800, groups,
    nodes: ["a1", "a2", "b1", "b2", "outside"].map((conversationId, index) => ({ conversationId, depth: 0, x: index * 250, y: 50, width: 200, height: 100 })),
    edges: [makeEdge("a1", "a2"), makeEdge("a1", "b1"), makeEdge("a2", "b2", true), makeEdge("b1", "outside"), makeEdge("outside", "a1")],
  };
  test("retains external group links, counts original members, and omits internal collapsed links", () => {
    const edges = aggregateGraphEdges(scene, groups);
    expect(edges).toHaveLength(3);
    const between = edges.find((edge) => edge.source.id === "a" && edge.target.id === "b")!;
    expect(between.count).toBe(2);
    expect(between.memberEdgeIds).toEqual(['["a1","b1"]', '["a2","b2"]']);
    expect(between.isSelectedPath).toBe(true);
    expect(edges.some((edge) => edge.source.id === "b" && edge.target.kind === "conversation" && edge.target.id === "outside")).toBe(true);
    expect(edges.some((edge) => edge.source.id === "outside" && edge.target.id === "a")).toBe(true);
    const card = getCollapsedGraphGroupRect(groups[0]);
    expect(between.startX).toBe(card.x + card.width);
    expect(between.startY).toBe(card.y + card.height / 2);
  });
  test("expanding one group retains external node links and both-group expansion restores original geometry", () => {
    const partiallyExpanded = aggregateGraphEdges(scene, [groups[1]]);
    expect(partiallyExpanded).toHaveLength(5);
    expect(partiallyExpanded.filter((edge) => edge.target.id === "b")).toHaveLength(2);
    const expanded = aggregateGraphEdges(scene, []);
    expect(expanded).toHaveLength(5);
    expect(expanded[0]).toMatchObject({ startX: 10, startY: 20, endX: 30, endY: 40, count: 1 });
  });
  test("duplicate source edges do not inflate the aggregate count", () => {
    const edges = aggregateGraphEdges({ ...scene, edges: [...scene.edges, scene.edges[1]] }, groups);
    expect(edges.find((edge) => edge.source.id === "a" && edge.target.id === "b")?.count).toBe(2);
  });
});
