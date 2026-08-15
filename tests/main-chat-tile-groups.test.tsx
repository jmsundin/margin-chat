import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "../client/node_modules/react-dom/server";
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
      />,
    );

    expect(markup).toContain("Learning");
    expect(markup).toContain("Ungrouped");
    expect(markup).toContain("Research thread");
    expect(markup).toContain("Other thread");
    expect(markup).toContain('aria-label="Group for conversation root"');
    expect(markup).toContain("New group");
  });
});
