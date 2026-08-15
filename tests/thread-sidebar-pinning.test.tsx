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

function renderSidebar(
  pinnedThreads: ThreadSummary[],
  streamingThreadIds: ReadonlySet<string> = new Set(),
) {
  const pinned = thread("pinned", "Pinned conversation");
  const recent = thread("recent", "Recent conversation");

  return renderToStaticMarkup(
    <ThreadSidebar
      activeOutlineItemId={null}
      activeThreadId={recent.id}
      collapsed={false}
      currentChatOutline={[]}
      currentChatTitle={recent.title}
      groups={{}}
      mainViewMode="chat"
      onAssignGroup={() => {}}
      onCreateGroup={() => {}}
      onDeleteThread={() => {}}
      onNewChat={() => {}}
      onNewNote={() => {}}
      onOpenProfile={() => {}}
      onOpenSettings={() => {}}
      onOpenSearch={() => {}}
      onPinThread={() => {}}
      onRenameThread={() => {}}
      onSelectOutlineItem={() => {}}
      onSetMainViewMode={() => {}}
      onSelectThread={() => {}}
      onToggleCollapse={() => {}}
      onToggleGroup={() => {}}
      onToggleTheme={() => {}}
      onUnpinThread={() => {}}
      pinnedThreads={pinnedThreads}
      streamingThreadIds={streamingThreadIds}
      theme="dark"
      threads={[recent, pinned]}
    />,
  );
}

describe("thread sidebar pinning", () => {
  test("moves pinned threads into a dedicated group without duplicating them", () => {
    const markup = renderSidebar([thread("pinned", "Pinned conversation")]);

    expect(markup).toContain("Ungrouped");
    expect(markup.indexOf("Pinned conversation")).toBeLessThan(
      markup.indexOf("Recent conversation"),
    );
    expect(markup.match(/class="thread-item is-pinned"/g)).toHaveLength(1);
    expect(markup).not.toContain('aria-label="Unpin Pinned conversation"');
    expect(markup).not.toContain('aria-label="Pin Recent conversation"');
  });

  test("does not reserve pinned-section space when nothing is pinned", () => {
    const markup = renderSidebar([]);

    expect(markup).toContain("Ungrouped");
  });

  test("marks a background thread while its response is streaming", () => {
    const markup = renderSidebar([], new Set(["pinned"]));

    expect(markup).toContain("thread-item is-streaming");
    expect(markup).toContain("Streaming");
  });

  test("shows standalone notes in the chat list with note-specific controls", () => {
    const noteThread = {
      ...thread("note", "Research scratchpad"),
      kind: "note" as const,
      preview: "A durable note in the workspace",
    };
    const markup = renderToStaticMarkup(
      <ThreadSidebar
        activeOutlineItemId={null}
        activeThreadId={noteThread.id}
        collapsed={false}
        currentChatOutline={[]}
        currentChatTitle={noteThread.title}
        groups={{}}
        mainViewMode="chat"
        onAssignGroup={() => {}}
        onCreateGroup={() => {}}
        onDeleteThread={() => {}}
        onNewChat={() => {}}
        onNewNote={() => {}}
        onOpenProfile={() => {}}
        onOpenSettings={() => {}}
        onOpenSearch={() => {}}
        onPinThread={() => {}}
        onRenameThread={() => {}}
        onSelectOutlineItem={() => {}}
        onSetMainViewMode={() => {}}
        onSelectThread={() => {}}
        onToggleCollapse={() => {}}
        onToggleGroup={() => {}}
        onToggleTheme={() => {}}
        onUnpinThread={() => {}}
        pinnedThreads={[]}
        streamingThreadIds={new Set()}
        theme="dark"
        threads={[noteThread]}
      />,
    );

    expect(markup).toContain('aria-label="New note"');
    expect(markup).toContain("Research scratchpad");
    expect(markup).toContain("thread-item is-active is-note");
    expect(markup).not.toContain("Expand outline for Research scratchpad");
  });
});
