import { useDeferredValue, useState } from "react";
import {
  ConversationGroupSelect,
  NewConversationGroupForm,
} from "./ConversationGroupControls";
import {
  categorizeThread,
  getThreadCategoryLabel,
} from "../lib/threadCategories";
import type { ConversationGroup, ThreadSummary } from "../types";

function normalizeThreads(threads: ThreadSummary[]): ThreadSummary[] {
  return threads.map((thread) => {
    const categoryId =
      thread.categoryId ??
      categorizeThread({
        context: `${thread.title} ${thread.preview}`,
        preview: thread.preview,
        title: thread.title,
      });

    return {
      ...thread,
      categoryId,
      categoryLabel: thread.categoryLabel ?? getThreadCategoryLabel(categoryId),
    };
  });
}

interface MainChatTileViewProps {
  activeThreadId: string;
  groups: Record<string, ConversationGroup>;
  onAssignGroup: (conversationId: string, groupId: string | null) => void;
  onCreateGroup: (name: string) => void;
  onOpenThread: (conversationId: string) => void;
  onToggleGroup: (groupId: string) => void;
  threads: ThreadSummary[];
}

function SearchIcon() {
  return (
    <svg
      aria-hidden="true"
      className="thread-tile-search-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

interface ThreadTileCardProps {
  activeThreadId: string;
  groups: Record<string, ConversationGroup>;
  onAssignGroup: (conversationId: string, groupId: string | null) => void;
  onOpenThread: (conversationId: string) => void;
  thread: ThreadSummary;
}

function ThreadTileCard({
  activeThreadId,
  groups,
  onAssignGroup,
  onOpenThread,
  thread,
}: ThreadTileCardProps) {
  return (
    <article
      className={`thread-tile-card-shell${thread.kind === "note" ? " is-note" : ""}`}
    >
      <button
        className={
          thread.id === activeThreadId
            ? "thread-tile-card is-active"
            : "thread-tile-card"
        }
        onClick={() => onOpenThread(thread.id)}
        type="button"
      >
        <div className="thread-tile-card-body">
          <span className="thread-tile-category">
            {thread.kind === "note" ? "Standalone note" : thread.categoryLabel}
          </span>
          <h4>{thread.title}</h4>
          <p>{thread.preview}</p>
        </div>

        <div className="thread-tile-card-head">
          <span className="thread-tile-updated">{thread.updatedLabel}</span>
          <span className="thread-tile-badge">
            {thread.kind === "note"
              ? "Note"
              : thread.conversationCount === 1
              ? "1 panel"
              : `${thread.conversationCount} panels`}
          </span>
        </div>
      </button>
      <ConversationGroupSelect
        className="is-tile"
        conversationId={thread.id}
        groups={groups}
        onAssign={onAssignGroup}
      />
    </article>
  );
}

export default function MainChatTileView({
  activeThreadId,
  groups,
  onAssignGroup,
  onCreateGroup,
  onOpenThread,
  onToggleGroup,
  threads,
}: MainChatTileViewProps) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const normalizedQuery = deferredQuery.trim().toLowerCase();
  const normalizedThreads = normalizeThreads(threads);
  const filteredThreads = normalizedThreads
    .filter(
      (thread) =>
        !normalizedQuery ||
        thread.title.toLowerCase().includes(normalizedQuery) ||
        thread.preview.toLowerCase().includes(normalizedQuery),
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const emptyState = normalizedQuery
    ? {
        body: "Try a different keyword.",
        title: "No threads matched that search.",
      }
    : {
        body: "Start a new main chat and it will appear here.",
        title: "No threads yet.",
      };
  const groupSections = [
    ...Object.values(groups).map((group) => ({
      collapsed: group.collapsed,
      color: group.color,
      id: group.id as string | null,
      name: group.name,
      threads: filteredThreads.filter((thread) => thread.groupId === group.id),
    })),
    {
      collapsed: false,
      color: "transparent",
      id: null,
      name: "Ungrouped",
      threads: filteredThreads.filter((thread) => !thread.groupId),
    },
  ].filter(
    (section) =>
      section.threads.length > 0 ||
      (!normalizedQuery && section.id !== null),
  );

  return (
    <section className="thread-tile-view">
      <div className="thread-tile-toolbar">
        <label className="thread-tile-search" htmlFor="thread-tile-search">
          <SearchIcon />
          <input
            id="thread-tile-search"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search chats and notes"
            type="search"
            value={query}
          />
        </label>
        <NewConversationGroupForm onCreate={onCreateGroup} />
      </div>

      {filteredThreads.length ? (
        <div className="thread-tile-groups">
          {groupSections.map((section) => (
            <section
              className="thread-tile-group"
              key={section.id ?? "ungrouped"}
            >
              <header className="thread-tile-group-header">
                <button
                  aria-expanded={!section.collapsed}
                  disabled={!section.id}
                  onClick={() => section.id && onToggleGroup(section.id)}
                  type="button"
                >
                  <span
                    aria-hidden="true"
                    className="conversation-group-color"
                    style={{ backgroundColor: section.color }}
                  />
                  <strong>{section.name}</strong>
                  <span>{section.threads.length}</span>
                  {section.id ? (
                    <span aria-hidden="true">
                      {section.collapsed ? "＋" : "−"}
                    </span>
                  ) : null}
                </button>
              </header>

              {!section.collapsed ? (
                section.threads.length ? (
                  <div className="thread-tile-grid">
                    {section.threads.map((thread) => (
                      <ThreadTileCard
                        key={thread.id}
                        activeThreadId={activeThreadId}
                        groups={groups}
                        onAssignGroup={onAssignGroup}
                        onOpenThread={onOpenThread}
                        thread={thread}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="thread-tile-group-empty">
                    Move a chat here to start this group.
                  </p>
                )
              ) : null}
            </section>
          ))}
        </div>
      ) : (
        <div className="thread-tile-empty">
          <strong>{emptyState.title}</strong>
          <p>{emptyState.body}</p>
        </div>
      )}
    </section>
  );
}
