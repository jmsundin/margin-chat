import { describe, expect, test } from "bun:test";
import { createChildConversation, createMainConversation } from "../client/src/initialState";
import { countConnections, describeLensFilter, lensTimeline, mapDocumentType, matchMapLens, newLensFilter, readMapLens, type MapLensContext } from "../client/src/lib/mapLens";
import type { Conversation } from "../client/src/types";

const DAY = 86_400_000;
function vault() {
  const conversations: Record<string, Conversation> = {};
  const add = (conversation: Conversation, patch: Partial<Conversation> = {}) => (conversations[conversation.id] = { ...conversation, ...patch });
  const plan = add(createMainConversation({ id: "plan", createdAt: "2026-01-05T00:00:00Z" }), { title: "Postgres migration plan", updatedAt: "2026-09-20T00:00:00Z", tags: ["db", "launch"], nodeType: "plan" });
  add(createChildConversation({ id: "branch", parentConversation: plan, createdAt: "2026-02-01T00:00:00Z" }), {
    title: "Index changes", updatedAt: "2026-02-01T00:00:00Z", branchAnchor: { messageId: "m", startOffset: 0, endOffset: 1, quote: "x" } as Conversation["branchAnchor"] });
  plan.childIds.push("branch");
  add(createMainConversation({ id: "reading", createdAt: "2025-06-01T00:00:00Z" }), { title: "Reading list", updatedAt: "2025-06-02T00:00:00Z", tags: ["books"] });
  add(createMainConversation({ id: "lone", createdAt: "2026-10-01T00:00:00Z" }), { title: "Loose idea", updatedAt: "2026-10-01T00:00:00Z" });
  conversations.plan = plan;
  return conversations;
}
const context = (conversations: Record<string, Conversation>): MapLensContext => ({
  conversations, groups: { g: { id: "g", name: "Work", color: "#f00", collapsed: false, conversationIds: ["reading"] } },
  connectionCounts: countConnections([{ sourceId: "plan", targetId: "branch" }, { sourceId: "plan", targetId: "reading" }]),
});

describe("map lens", () => {
  test("no filters means nothing is greyed", () => {
    const conversations = vault();
    expect(matchMapLens(Object.keys(conversations), { filters: [] }, context(conversations))).toBeNull();
  });

  test("every filter must match, and values within a filter are alternatives", () => {
    const conversations = vault();
    const ids = Object.keys(conversations);
    const match = (...filters: Parameters<typeof matchMapLens>[1]["filters"]) => [...matchMapLens(ids, { filters }, context(conversations))!].sort();
    expect(match({ id: "1", kind: "edited", from: Date.parse("2026-09-01T00:00:00Z"), to: null })).toEqual(["lone", "plan"]);
    expect(match({ id: "1", kind: "created", from: null, to: Date.parse("2026-01-01T00:00:00Z") })).toEqual(["reading"]);
    expect(match({ id: "1", kind: "tag", values: ["books", "db"] })).toEqual(["plan", "reading"]);
    expect(match({ id: "1", kind: "tag", values: ["books", "db"] }, { id: "2", kind: "connections", min: 2, max: null })).toEqual(["plan"]);
    expect(match({ id: "1", kind: "connections", min: 0, max: 0 })).toEqual(["lone"]);
    expect(match({ id: "1", kind: "type", values: ["branch"] })).toEqual(["branch"]);
    expect(match({ id: "1", kind: "nodeType", values: ["plan"] })).toEqual(["plan"]);
    expect(match({ id: "1", kind: "group", values: ["g"] })).toEqual(["reading"]);
    expect(match({ id: "1", kind: "has", value: "children" })).toEqual(["plan"]);
    expect(match({ id: "1", kind: "text", query: "postgres PLAN" })).toEqual(["plan"]);
    expect(match({ id: "1", kind: "words", min: 0, max: 0 })).toEqual(["branch", "lone", "plan", "reading"]);
  });

  test("document kinds follow the peer and child model", () => {
    const conversations = vault();
    expect(mapDocumentType(conversations.plan)).toBe("document");
    expect(mapDocumentType(conversations.branch)).toBe("branch");
  });

  test("the timeline bins dates and counts matches", () => {
    const conversations = vault();
    const ids = Object.keys(conversations);
    const bins = lensTimeline(ids, conversations, "created", new Set(["plan"]), 10);
    expect(bins.reduce((sum, bin) => sum + bin.total, 0)).toBe(4);
    expect(bins.reduce((sum, bin) => sum + bin.matched, 0)).toBe(1);
    expect(bins[0].start).toBeLessThanOrEqual(Date.parse("2025-06-01T00:00:00Z"));
    expect(bins.at(-1)!.end).toBeGreaterThan(Date.parse("2026-10-01T00:00:00Z"));
    for (const bin of bins) expect((bin.end - bin.start) % DAY).toBe(0);
  });

  test("new filters describe themselves, and stored lenses drop unknown filters", () => {
    for (const kind of ["edited", "created", "connections", "type", "tag", "nodeType", "group", "has", "text", "words"] as const)
      expect(describeLensFilter(newLensFilter(kind)).length).toBeGreaterThan(0);
    expect(readMapLens({ filters: [{ id: "a", kind: "tag", values: [] }, { id: "b", kind: "bogus" }, null] }).filters.map((filter) => filter.id)).toEqual(["a"]);
    expect(readMapLens("nope").filters).toEqual([]);
  });
});
