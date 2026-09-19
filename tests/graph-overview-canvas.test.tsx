import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "../client/node_modules/react-dom/server";
import GraphOverviewCanvas, { getGraphOverviewConnections } from "../client/src/components/GraphOverviewCanvas";
import type { GraphExplorationOverviewItem } from "../client/src/components/GraphExplorationPanel";
import type { Conversation } from "../client/src/types";

const createdAt = "2026-09-19T00:00:00Z";
const makeConversation = (id: string, parentId: string | null = null): Conversation => ({
  id, parentId, childIds: [], title: id, messages: [], branchAnchor: null, createdAt, updatedAt: createdAt,
  serviceId: "backend-services", modelId: "smart-routing",
});
const items: GraphExplorationOverviewItem[] = [
  { id: "privacy", label: "Privacy choices", kind: "Concept", count: 3, examples: ["Local index"] },
  { id: "search", label: "Finding ideas", kind: "Group", count: 2, description: "Search and navigation", examples: [] },
  { id: "other", label: "Other work", kind: "Group", count: 1, examples: [] },
];
const conversations = {
  shared: makeConversation("shared"),
  parent: makeConversation("parent"),
  child: makeConversation("child", "parent"),
  internal: makeConversation("internal", "parent"),
  separate: makeConversation("separate"),
};
const memberships = { privacy: ["shared", "parent", "internal", "shared", "deleted"], search: ["shared", "child"], other: ["separate"] };

describe("readable graph overview", () => {
  test("distinguishes shared membership from directed ancestry, with exact underlying IDs", () => {
    expect(getGraphOverviewConnections("privacy", items, memberships, conversations)).toEqual([{
      targetId: "search", sharedConversationIds: ["shared"],
      outgoingBranches: [{ parentConversationId: "parent", childConversationId: "child" }], incomingBranches: [],
    }]);
    expect(getGraphOverviewConnections("search", items, memberships, conversations)).toEqual([{
      targetId: "privacy", sharedConversationIds: ["shared"], outgoingBranches: [],
      incomingBranches: [{ parentConversationId: "parent", childConversationId: "child" }],
    }]);
  });
  test("does not turn internal branches, missing parents, or shared membership into cross-topic ancestry", () => {
    const overlapping = { privacy: ["shared", "parent", "child"], search: ["parent", "child"] };
    const connections = getGraphOverviewConnections("privacy", items, overlapping, {
      ...conversations, orphan: makeConversation("orphan", "deleted"),
    });
    expect(connections[0].sharedConversationIds).toEqual(["parent", "child"]);
    expect(connections[0].outgoingBranches).toEqual([]);
    expect(connections[0].incomingBranches).toEqual([]);
  });
  test("renders readable topics, explicit exploration, and inspectable labeled connections", () => {
    const markup = renderToStaticMarkup(<GraphOverviewCanvas items={items} memberships={memberships}
      conversations={conversations} onOpen={() => {}} onInspectConnection={() => {}} />);
    expect(markup).toContain("Your ideas, connected");
    expect(markup).toContain('aria-label="Explore Privacy choices"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain("1 shared source");
    expect(markup).toContain("1 branch to this topic");
    expect(markup).toContain('aria-label="Inspect 1 branch from Privacy choices to Finding ideas"');
    expect(markup).toContain("is-connected");
    expect(markup).toContain("5 sources");
  });
  test("uses named concepts and groups before categories, while preserving category-only workspaces", () => {
    const category: GraphExplorationOverviewItem = { id: "coding", label: "Broad coding category", kind: "Category", count: 1, examples: [] };
    const render = (candidateItems: GraphExplorationOverviewItem[]) => renderToStaticMarkup(<GraphOverviewCanvas items={candidateItems}
      memberships={memberships} conversations={conversations} onOpen={() => {}} onInspectConnection={() => {}} />);
    expect(render([...items, category])).not.toContain(category.label);
    expect(render([category])).toContain(category.label);
    expect(render([])).toContain("Create a group or concept");
  });
  test("restores a controlled topic selection when returning to the overview", () => {
    const render = (selectedTopicId: string | null) => renderToStaticMarkup(<GraphOverviewCanvas items={items}
      memberships={memberships} conversations={conversations} selectedTopicId={selectedTopicId}
      onSelectTopic={() => {}} onOpen={() => {}} onInspectConnection={() => {}} />);
    expect(render("search")).toContain("<h3>Finding ideas</h3>");
    expect(render("search")).toContain("1 branch from this topic");
    expect(render("deleted-topic")).toContain("<h3>Privacy choices</h3>");
    expect(render(null)).toContain("<h3>Privacy choices</h3>");
  });
});
