import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import MainChatTileView from "../client/src/components/MainChatTileView";
import type { ThreadSummary } from "../client/src/types";

const threads: ThreadSummary[] = [
  {
    categoryId: "research",
    categoryLabel: "Research",
    conversationCount: 3,
    groupId: "learning",
    id: "root",
    preview: "A grouped research discussion",
    title: "Research thread",
    updatedAt: "2026-08-14T00:00:00.000Z",
    updatedLabel: "now",
  },
  {
    categoryId: "general",
    categoryLabel: "General",
    conversationCount: 1,
    groupId: null,
    id: "other",
    preview: "An ungrouped discussion",
    title: "Other thread",
    updatedAt: "2026-08-13T00:00:00.000Z",
    updatedLabel: "1d ago",
  },
];

describe("main chat tile groups", () => {
  test("renders shared group sections and group assignment controls", () => {
    const markup = renderToStaticMarkup(
      <MainChatTileView
        activeThreadId="root"
        groups={{
          learning: {
            collapsed: false,
            color: "#4fbf9f",
            conversationIds: ["root"],
            id: "learning",
            name: "Learning",
          },
        }}
        onAssignGroup={() => {}}
        onCreateGroup={() => {}}
        onOpenThread={() => {}}
        onToggleGroup={() => {}}
        threads={threads}
        groupsEnabled
        tab="groups"
      />,
    );

    expect(markup).toContain("Learning");
    expect(markup).toContain("Ungrouped");
    expect(markup).toContain("Research thread");
    expect(markup).toContain("Other thread");
    expect(markup).toContain('aria-label="Group for conversation root: Learning"');
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain("New group");
  });

  const learning = { collapsed: false, color: "#4fbf9f", conversationIds: ["root"], id: "learning", name: "Learning" };
  function render(props: Partial<Parameters<typeof MainChatTileView>[0]> = {}) {
    return renderToStaticMarkup(<MainChatTileView activeThreadId="root" groups={{ learning }} onAssignGroup={() => {}}
      onCreateGroup={() => {}} onOpenThread={() => {}} onToggleGroup={() => {}} threads={threads} {...props} />);
  }

  test("the Documents tab is one plain list of documents, with no group controls", () => {
    const markup = render({ groupsEnabled: true, tab: "documents" });
    expect(markup).toContain("Research thread");
    expect(markup).toContain("Other thread");
    expect(markup).not.toContain("Ungrouped");
    expect(markup).not.toContain("New group");
    expect(markup).not.toContain("Group for conversation");
    expect(markup).toContain('role="tab"');
    expect(markup).toContain(">Groups 1<");
  });

  test("Groups and Spaces tabs show only when their features are on", () => {
    const plain = render();
    expect(plain).not.toContain('role="tablist"');
    const withSpaces = render({ spaces: { count: 2, content: <p>Space tiles</p> }, tab: "spaces" });
    expect(withSpaces).toContain(">Spaces 2<");
    expect(withSpaces).not.toContain(">Groups");
    expect(withSpaces).toContain("Space tiles");
    expect(withSpaces).not.toContain("Research thread");
    // A remembered tab whose feature is now off falls back to Documents.
    expect(render({ tab: "groups" })).not.toContain("New group");
    expect(render({ tab: "spaces" })).toContain("Research thread");
  });
});
