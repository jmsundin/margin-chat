import { useDeferredValue, useState } from "react";
import { setMainThreadDragData } from "../lib/pinnedThreads";
import {
  categorizeThread,
  getThreadCategoryLabel,
} from "../lib/threadCategories";
import type { ThreadSummary } from "../types";

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
  onMainThreadDragEnd: () => void;
  onMainThreadDragStart: () => void;
  onOpenThread: (conversationId: string) => void;
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
  onMainThreadDragEnd: () => void;
  onMainThreadDragStart: () => void;
  onOpenThread: (conversationId: string) => void;
  thread: ThreadSummary;
}

function ThreadTileCard({
  activeThreadId,
  onMainThreadDragEnd,
  onMainThreadDragStart,
  onOpenThread,
  thread,
}: ThreadTileCardProps) {
  return (
    <button
      className={
        thread.id === activeThreadId
          ? "thread-tile-card is-active"
          : "thread-tile-card"
      }
      draggable
      onClick={() => onOpenThread(thread.id)}
      onDragEnd={onMainThreadDragEnd}
      onDragStart={(event) => {
        onMainThreadDragStart();
        setMainThreadDragData(event.dataTransfer, thread.id);
      }}
      type="button"
    >
      <div className="thread-tile-card-body">
        <span className="thread-tile-category">{thread.categoryLabel}</span>
        <h4>{thread.title}</h4>
        <p>{thread.preview}</p>
      </div>

      <div className="thread-tile-card-head">
        <span className="thread-tile-updated">{thread.updatedLabel}</span>
        <span className="thread-tile-badge">
          {thread.conversationCount === 1
            ? "1 panel"
            : `${thread.conversationCount} panels`}
        </span>
      </div>
    </button>
  );
}

export default function MainChatTileView({
  activeThreadId,
  onMainThreadDragEnd,
  onMainThreadDragStart,
  onOpenThread,
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

  return (
    <section className="thread-tile-view">
      <div className="thread-tile-toolbar">
        <label className="thread-tile-search" htmlFor="thread-tile-search">
          <SearchIcon />
          <input
            id="thread-tile-search"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search main chat threads"
            type="search"
            value={query}
          />
        </label>

      </div>

      {filteredThreads.length ? (
        <div className="thread-tile-grid">
          {filteredThreads.map((thread) => (
            <ThreadTileCard
              key={thread.id}
              activeThreadId={activeThreadId}
              onMainThreadDragEnd={onMainThreadDragEnd}
              onMainThreadDragStart={onMainThreadDragStart}
              onOpenThread={onOpenThread}
              thread={thread}
            />
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
