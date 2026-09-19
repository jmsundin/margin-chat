import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "../client/node_modules/react-dom/server";
import ThreadSidebar from "../client/src/components/ThreadSidebar";
import {
  getSidebarThreadDropAction,
  sortThreadsByRecentActivity,
} from "../client/src/lib/sidebarThreads";
import type {
  ConversationGroup,
  ThreadSummary,
} from "../client/src/types";

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
  sidebarThreads?: ThreadSummary[],
  groups: Record<string, ConversationGroup> = {},
) {
  const pinned = thread("pinned", "Pinned conversation");
  const recent = thread("recent", "Recent conversation");
  const threads = sidebarThreads ?? [recent, pinned];
  const activeThread = threads[0] ?? recent;

  return renderToStaticMarkup(
    <ThreadSidebar
      activeOutlineItemId={null}
      activeThreadId={activeThread.id}
      collapsed={false}
      currentChatOutline={[]}
      currentChatTitle={activeThread.title}
      groups={groups}
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
      threads={threads}
    />,
  );
}

describe("thread sidebar pinning", () => {
  test("moves pinned threads into a dedicated group without duplicating them", () => {
    const markup = renderSidebar([thread("pinned", "Pinned conversation")]);

    expect(markup).toContain('aria-label="Pinned chats and notes"');
    expect(markup).toContain('data-thread-drop-target="pinned"');
    expect(markup).toContain("Ungrouped");
    expect(markup.indexOf("Pinned conversation")).toBeLessThan(
      markup.indexOf("Recent conversation"),
    );
    expect(markup.match(/class="thread-item is-pinned"/g)).toHaveLength(1);
    expect(markup).not.toContain('aria-label="Unpin Pinned conversation"');
    expect(markup).not.toContain('aria-label="Pin Recent conversation"');
  });

  test("keeps empty drop targets out of the sidebar until a drag starts", () => {
    const markup = renderSidebar([]);

    expect(markup).not.toContain("Drop here to pin");
    expect(markup).not.toContain('aria-label="Pinned chats and notes"');
    expect(markup).toContain("Ungrouped");

    const emptyMarkup = renderSidebar([], new Set(), []);
    expect(emptyMarkup).not.toContain('aria-label="Ungrouped chats and notes"');
    expect(emptyMarkup).not.toContain("Drop here to ungroup");
  });

  test("labels workspace views and search while keeping secondary actions tucked away", () => {
    const markup = renderSidebar([]);

    expect(markup).toContain("<span>Chat</span>");
    expect(markup).toContain("<span>Tiles</span>");
    expect(markup).toContain("<span>Map</span>");
    expect(markup).toContain("<span>Search chats</span>");
    expect(markup).toContain('aria-label="More workspace actions"');
    expect(markup).not.toContain('aria-label="New group"');
    expect(markup).not.toContain("<span>New note</span>");
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

    expect(markup).toContain('aria-label="More workspace actions"');
    expect(markup).toContain("Research scratchpad");
    expect(markup).toContain("thread-item is-active is-note");
    expect(markup).not.toContain("Expand outline for Research scratchpad");
  });

  test("orders chats and notes from most recently worked with to oldest", () => {
    const olderChat = {
      ...thread("older-chat", "Older chat"),
      updatedAt: "2026-08-12T08:00:00.000Z",
    };
    const recentChat = {
      ...thread("recent-chat", "Recent chat"),
      updatedAt: "2026-08-12T10:00:00.000Z",
    };
    const newestNote = {
      ...thread("newest-note", "Newest note"),
      kind: "note" as const,
      updatedAt: "2026-08-12T12:00:00.000Z",
    };

    expect(
      sortThreadsByRecentActivity([
        olderChat,
        newestNote,
        recentChat,
      ]).map((candidate) => candidate.id),
    ).toEqual(["newest-note", "recent-chat", "older-chat"]);
  });

  test("orders pinned chats by recent activity while keeping pins first", () => {
    const olderPinned = {
      ...thread("older-pinned", "Older pinned"),
      updatedAt: "2026-08-12T08:00:00.000Z",
    };
    const newerPinned = {
      ...thread("newer-pinned", "Newer pinned"),
      updatedAt: "2026-08-12T12:00:00.000Z",
    };
    const markup = renderSidebar(
      [olderPinned, newerPinned],
      new Set(),
      [olderPinned, newerPinned],
    );

    expect(markup.indexOf("Newer pinned")).toBeLessThan(
      markup.indexOf("Older pinned"),
    );
  });

  test("keeps grouped sections above ungrouped items", () => {
    const olderGrouped = {
      ...thread("older-grouped", "Older grouped chat"),
      groupId: "project",
      updatedAt: "2026-08-12T08:00:00.000Z",
    };
    const newestUngrouped = {
      ...thread("newest-ungrouped", "Newest ungrouped note"),
      kind: "note" as const,
      updatedAt: "2026-08-12T12:00:00.000Z",
    };
    const markup = renderSidebar(
      [],
      new Set(),
      [olderGrouped, newestUngrouped],
      {
        project: {
          collapsed: false,
          color: "#4fbf9f",
          conversationIds: [olderGrouped.id],
          id: "project",
          name: "Project",
        },
      },
    );

    expect(markup.indexOf("Older grouped chat")).toBeLessThan(
      markup.indexOf("Newest ungrouped note"),
    );
  });

  test("maps sidebar drops to pin, group, and ungroup actions", () => {
    expect(
      getSidebarThreadDropAction({
        isPinned: false,
        targetPinned: true,
      }),
    ).toEqual({
      assignGroup: false,
      groupId: null,
      pin: true,
      unpin: false,
    });
    expect(
      getSidebarThreadDropAction({
        isPinned: true,
        targetGroupId: "project",
      }),
    ).toEqual({
      assignGroup: true,
      groupId: "project",
      pin: false,
      unpin: true,
    });
    expect(
      getSidebarThreadDropAction({
        isPinned: false,
        targetGroupId: null,
      }),
    ).toEqual({
      assignGroup: true,
      groupId: null,
      pin: false,
      unpin: false,
    });
  });
});
