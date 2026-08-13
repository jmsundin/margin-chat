import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "../client/node_modules/react-dom/server";
import ThreadSidebar from "../client/src/components/ThreadSidebar";
import type { ThreadSummary } from "../client/src/types";

function thread(id: string, title: string): ThreadSummary {
  return {
    categoryId: "other",
    categoryLabel: "Other",
    conversationCount: 1,
    id,
    preview: `${title} preview`,
    title,
    updatedAt: "2026-08-12T00:00:00.000Z",
    updatedLabel: "now",
  };
}

function renderSidebar(pinnedThreads: ThreadSummary[]) {
  const pinned = thread("pinned", "Pinned conversation");
  const recent = thread("recent", "Recent conversation");

  return renderToStaticMarkup(
    <ThreadSidebar
      activeOutlineItemId={null}
      activeThreadId={recent.id}
      collapsed={false}
      currentChatOutline={[]}
      currentChatTitle={recent.title}
      mainViewMode="chat"
      onDeleteThread={() => {}}
      onNewChat={() => {}}
      onOpenProfile={() => {}}
      onOpenSettings={() => {}}
      onOpenSearch={() => {}}
      onPinThread={() => {}}
      onRenameThread={() => {}}
      onSelectOutlineItem={() => {}}
      onSetMainViewMode={() => {}}
      onSelectThread={() => {}}
      onToggleCollapse={() => {}}
      onToggleTheme={() => {}}
      onUnpinThread={() => {}}
      pinnedThreads={pinnedThreads}
      theme="dark"
      threads={[recent, pinned]}
    />,
  );
}

describe("thread sidebar pinning", () => {
  test("moves pinned threads into a dedicated group without duplicating them", () => {
    const markup = renderSidebar([thread("pinned", "Pinned conversation")]);

    expect(markup).toContain(">Pinned</p>");
    expect(markup).toContain(">Chats</p>");
    expect(markup.indexOf("Pinned conversation")).toBeLessThan(
      markup.indexOf("Recent conversation"),
    );
    expect(markup.match(/class="thread-item is-pinned"/g)).toHaveLength(1);
    expect(markup).not.toContain('aria-label="Unpin Pinned conversation"');
    expect(markup).not.toContain('aria-label="Pin Recent conversation"');
  });

  test("does not reserve pinned-section space when nothing is pinned", () => {
    const markup = renderSidebar([]);

    expect(markup).not.toContain(">Pinned</p>");
    expect(markup).toContain(">Chats</p>");
  });
});
