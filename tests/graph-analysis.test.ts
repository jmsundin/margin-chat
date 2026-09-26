import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getGraphAnalysisEdges, getGraphFlowSummary, getGraphTimelineEntries } from "../client/src/lib/graphAnalysis";
import GraphAnalysisViews from "../client/src/components/GraphAnalysisViews";
import type { Conversation, ConversationGroup } from "../client/src/types";

const date = "2026-09-23T09:00:00.000Z";
const document = (id: string, overrides: Partial<Conversation> = {}): Conversation => ({
  id, title: id, parentId: null, branchAnchor: null, childIds: [], messages: [],
  createdAt: date, updatedAt: date, serviceId: "backend-services", modelId: "smart-routing", ...overrides,
});
const group = (id: string, conversationIds: string[]): ConversationGroup => ({ id, name: id, conversationIds, color: "#123456", collapsed: false });

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

describe("document timeline", () => {
  test("sorts by the chosen actual timestamp and retains missing or invalid dates last", () => {
    const conversations = {
      first: document("first", { createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-09-24T00:00:00Z" }),
      second: document("second", { createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-09-20T00:00:00Z" }),
      bad: document("bad", { createdAt: "invalid", updatedAt: "" }),
    };
    expect(getGraphTimelineEntries(conversations, "created").map((entry) => entry.conversationId)).toEqual(["second", "first", "bad"]);
    expect(getGraphTimelineEntries(conversations, "updated").map((entry) => entry.conversationId)).toEqual(["first", "second", "bad"]);
    expect(getGraphTimelineEntries(conversations, "created")[2].timestamp).toBeNull();
    expect(getGraphTimelineEntries(conversations, "updated")[2].timestamp).toBeNull();
  });
  test("equal timestamps have stable ordering independent of insertion order", () => {
    expect(getGraphTimelineEntries({ z: document("z"), a: document("a") }, "created").map((entry) => entry.conversationId)).toEqual(["a", "z"]);
  });
});

describe("group relationship counts", () => {
  const conversations = {
    a: document("a", { linkedConversationIds: ["b", "c"] }),
    b: document("b", { parentId: "a", linkedConversationIds: ["a"] }),
    c: document("c"),
  };
  const groups = { research: group("research", ["a", "b", "a", "gone"]), design: group("design", ["a"]) };
  test("overlapping membership forms one combination, so weights never inflate", () => {
    const summary = getGraphFlowSummary(conversations, groups);
    expect(summary.totalCount).toBe(4);
    expect(summary.bands.reduce((total, band) => total + band.count, 0)).toBe(4);
    expect(summary.groups.map((item) => [item.label, item.conversationIds])).toEqual([
      ["design + research", ["a"]], ["research", ["b"]], ["Ungrouped", ["c"]],
    ]);
    const ab = summary.bands.find((band) => band.edges.some((edge) => edge.sourceId === "a" && edge.targetId === "b"))!;
    expect(ab).toMatchObject({ count: 2, branchCount: 1, linkCount: 1 });
    expect(ab.edges).toHaveLength(2);
    expect(summary.bands.find((band) => band.edges.some((edge) => edge.sourceId === "b"))!.count).toBe(1);
  });
  test("applies requested relation filters and keeps internal-group edges", () => {
    const edges = getGraphAnalysisEdges(conversations).filter((edge) => edge.kind === "branch");
    const summary = getGraphFlowSummary(conversations, { research: groups.research }, edges);
    expect(summary.totalCount).toBe(1);
    expect(summary.bands[0]).toMatchObject({ sourceGroupId: '["research"]', targetGroupId: '["research"]', count: 1, branchCount: 1, linkCount: 0 });
  });
  test("rejects stale, duplicate, or self edges passed to the aggregator", () => {
    const edges = getGraphAnalysisEdges(conversations);
    const summary = getGraphFlowSummary(conversations, groups, [
      ...edges, ...edges, { id: "stale", sourceId: "a", targetId: "missing", kind: "link" }, { id: "self", sourceId: "a", targetId: "a", kind: "link" },
    ]);
    expect(summary.totalCount).toBe(4);
  });
});

describe("analytical view affordances", () => {
  const conversations = Object.fromEntries(Array.from({ length: 24 }, (_, index) => {
    const id = `Document ${String(index + 1).padStart(2, "0")}`;
    return [id, document(id, { linkedConversationIds: index === 0 ? ["Document 02"] : [] })];
  }));
  const render = (mode: "timeline" | "matrix" | "flow", relationKinds?: ("branch" | "link")[]) => renderToStaticMarkup(createElement(GraphAnalysisViews, {
    mode, conversations, groups: {}, selectedConversationId: "Document 01", onOpenConversation: () => {}, relationKinds,
  }));
  test("matrix labels direction and types, exposes pagination on both axes and source actions", () => {
    const markup = render("matrix");
    expect(markup).toContain('aria-label="Next rows"');
    expect(markup).toContain('aria-label="Next columns"');
    expect(markup).toContain("1–16 of 24");
    expect(markup).toContain('aria-label="Document 01 to Document 02: authored link"');
    expect(markup).toContain("Find selected document");
    expect(markup).toContain('aria-current="true"');
    expect(markup).not.toContain("Document 24");
  });
  test("flow provides weighted visual, exact sources, and typed empty state", () => {
    const markup = render("flow");
    expect(markup).toContain("1 directed relationships");
    expect(markup).toContain("wider ribbons represent more relationships");
    expect(markup).toContain("Each relationship is counted once");
    expect(markup).toContain('aria-label="Selected flow sources"');
    expect(markup).toContain("Document 01");
    expect(markup).toContain("Document 02");
    expect(render("flow", ["branch"])).toContain("Connect documents or create branches");
  });
  test("timeline names document timestamps and can switch created vs last edited", () => {
    const markup = render("timeline");
    expect(markup).toContain('value="created"');
    expect(markup).toContain('value="updated"');
    expect(markup).toContain("These are document timestamps");
    expect(markup).toContain("Document 24");
    expect(markup).toContain("<time dateTime=");
  });
});

test("analytical view interactions preserve inspectable sources across pagination and filters", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/graphAnalysisHarness.tsx"], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 10000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  clearTimeout(timeout);
  if (code !== 0) throw new Error(`Graph analysis interaction failed:\n${stdout}\n${stderr}`);
  expect(JSON.parse(stdout.trim().split("\n").at(-1)!).checks).toHaveLength(4);
}, 15000);
