import { describe, expect, test } from "bun:test";
import { getGraphAnalysisEdges } from "../client/src/lib/graphAnalysis";
import type { Conversation } from "../client/src/types";

const date = "2026-09-23T09:00:00.000Z";
const document = (id: string, overrides: Partial<Conversation> = {}): Conversation => ({
  id, title: id, parentId: null, branchAnchor: null, childIds: [], messages: [],
  createdAt: date, updatedAt: date, serviceId: "backend-services", modelId: "smart-routing", ...overrides,
});

describe("recorded graph relationships", () => {
  test("deduplicates each directed relation while preserving reciprocal links and relation kinds", () => {
    const conversations = {
      a: document("a", { linkedConversationIds: ["b", "b", "a", "gone", "toString"] }),
      b: document("b", { parentId: "a", linkedConversationIds: ["a"] }),
      c: document("c", { parentId: "gone" }),
    };
    const edges = getGraphAnalysisEdges(conversations);
    expect(edges).toHaveLength(3);
    expect(edges.map(({ sourceId, targetId, kind }) => ({ sourceId, targetId, kind }))).toEqual([
      { sourceId: "a", targetId: "b", kind: "branch" },
      { sourceId: "a", targetId: "b", kind: "link" },
      { sourceId: "b", targetId: "a", kind: "link" },
    ]);
    expect(new Set(edges.map((edge) => edge.id)).size).toBe(3);
  });
  test("retains cyclic recorded ancestry without traversing stale child lists", () => {
    const conversations = {
      a: document("a", { parentId: "b", childIds: ["gone", "fake"] }),
      b: document("b", { parentId: "a" }),
      fake: document("fake"),
      self: document("self", { parentId: "self" }),
    };
    expect(getGraphAnalysisEdges(conversations).map((edge) => [edge.sourceId, edge.targetId])).toEqual([["a", "b"], ["b", "a"]]);
  });
});
