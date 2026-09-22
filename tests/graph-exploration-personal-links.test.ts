import { describe, expect, test } from "bun:test";
import { createStandaloneNoteConversation } from "../client/src/initialState";
import { getGraphScopeConversationIds, type GraphConcept } from "../client/src/lib/graphExploration";
import type { Conversation, ConversationGroup, ThreadSummary } from "../client/src/types";

function note(id: string, overrides: Partial<Conversation> = {}): Conversation {
  return {
    ...createStandaloneNoteConversation({ id, noteId: `${id}-body`, createdAt: "2026-09-20T12:00:00.000Z" }),
    ...overrides,
  };
}

function focus(conversations: Record<string, Conversation>, conversationId: string, depth: number) {
  return getGraphScopeConversationIds({ conversations, scope: { kind: "focus", conversationId, depth } });
}

describe("focused exploration of personal links", () => {
  test("expands connected standalone roots from either endpoint without altering ancestry", () => {
    const conversations = { a: note("a", { linkedConversationIds: ["b"] }), b: note("b"), unrelated: note("unrelated") };
    const before = structuredClone(conversations);
    expect(focus(conversations, "a", 0)).toEqual(new Set(["a"]));
    expect(focus(conversations, "a", 1)).toEqual(new Set(["a", "b"]));
    expect(focus(conversations, "b", 1)).toEqual(new Set(["a", "b"]));
    expect(conversations).toEqual(before);
  });

  test("each personal link consumes one depth step, including incoming links", () => {
    const conversations = {
      a: note("a", { linkedConversationIds: ["b"] }), b: note("b"),
      c: note("c", { linkedConversationIds: ["b", "d"] }), d: note("d"),
    };
    expect(focus(conversations, "a", 1)).toEqual(new Set(["a", "b"]));
    expect(focus(conversations, "a", 2)).toEqual(new Set(["a", "b", "c"]));
    expect(focus(conversations, "a", 3)).toEqual(new Set(["a", "b", "c", "d"]));
    expect(focus(conversations, "d", 2)).toEqual(new Set(["d", "c", "b"]));
    expect(focus(conversations, "a", 1.9)).toEqual(new Set(["a", "b"]));
    expect(focus(conversations, "a", -1)).toEqual(new Set(["a"]));
  });

  test("combines personal links and authoritative parent pointers at the same depth", () => {
    const conversations = {
      root: note("root", { childIds: [] }),
      branch: note("branch", { parentId: "root", linkedConversationIds: ["linked-root"] }),
      "linked-root": note("linked-root", { childIds: [] }),
      "linked-child": note("linked-child", { parentId: "linked-root" }),
    };
    expect(focus(conversations, "root", 1)).toEqual(new Set(["root", "branch"]));
    expect(focus(conversations, "root", 2)).toEqual(new Set(["root", "branch", "linked-root"]));
    expect(focus(conversations, "root", 3)).toEqual(new Set(["root", "branch", "linked-root", "linked-child"]));
    expect(focus(conversations, "linked-root", 1)).toEqual(new Set(["linked-root", "linked-child", "branch"]));
  });

  test("breadcrumb ancestors do not give their personal neighbors free expansion steps", () => {
    const conversations = {
      root: note("root", { linkedConversationIds: ["distant"] }),
      child: note("child", { parentId: "root" }),
      leaf: note("leaf", { parentId: "child", linkedConversationIds: ["nearby"] }),
      nearby: note("nearby"), distant: note("distant"),
    };
    expect(focus(conversations, "leaf", 0)).toEqual(new Set(["leaf", "child", "root"]));
    expect(focus(conversations, "leaf", 1)).toEqual(new Set(["leaf", "child", "root", "nearby"]));
    expect(focus(conversations, "leaf", 2)).toEqual(new Set(["leaf", "child", "root", "nearby"]));
    expect(focus(conversations, "leaf", 3)).toEqual(new Set(["leaf", "child", "root", "nearby", "distant"]));
  });

  test("cycles, reciprocal links, duplicates, self links and dangling IDs terminate without phantom nodes", () => {
    const conversations = {
      a: note("a", { linkedConversationIds: ["a", "b", "b", "missing", "toString"] }),
      b: note("b", { linkedConversationIds: ["a", "c"] }),
      c: note("c", { linkedConversationIds: ["a"] }),
    };
    expect(focus(conversations, "a", 1000)).toEqual(new Set(["a", "b", "c"]));
    expect(focus(conversations, "missing", 1000)).toEqual(new Set());
    expect(focus(conversations, "toString", 1)).toEqual(new Set());
  });

  test("personal connections do not widen category, group, ungrouped or concept scopes", () => {
    const conversations = {
      root: note("root", { linkedConversationIds: ["outside"] }),
      child: note("child", { parentId: "root" }), outside: note("outside"),
    };
    const groups: Record<string, ConversationGroup> = {
      group: { id: "group", name: "Group", color: "blue", collapsed: false, conversationIds: ["root"] },
    };
    const threads = [{ id: "root", categoryId: "research" }, { id: "outside", categoryId: "coding" }] as ThreadSummary[];
    const concepts: GraphConcept[] = [{ id: "concept", label: "Concept", description: "", members: [{ conversationId: "root", sourceKind: "conversation" }] }];
    const context = { conversations, groups, threads, concepts };
    expect(getGraphScopeConversationIds({ ...context, scope: { kind: "category", categoryId: "research" } })).toEqual(new Set(["root", "child"]));
    expect(getGraphScopeConversationIds({ ...context, scope: { kind: "group", groupId: "group" } })).toEqual(new Set(["root"]));
    expect(getGraphScopeConversationIds({ ...context, scope: { kind: "concept", conceptId: "concept" } })).toEqual(new Set(["root"]));
    expect(getGraphScopeConversationIds({ ...context, scope: { kind: "ungrouped" } })).toEqual(new Set(["child", "outside"]));
  });
});
