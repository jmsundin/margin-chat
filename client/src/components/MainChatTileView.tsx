import { useDeferredValue, useEffect, useState } from "react";
import { setMainThreadDragData } from "../lib/pinnedThreads";
import {
  THREAD_CATEGORY_DEFINITIONS,
  categorizeThread,
  getThreadCategoryDescription,
  getThreadCategoryLabel,
} from "../lib/threadCategories";
import type { ThreadCategoryId, ThreadSummary } from "../types";

type ThreadSortMode =
  | "recent"
  | "oldest"
  | "title-asc"
  | "title-desc"
  | "panels-desc";
type ThreadCategoryFilter = "all" | ThreadCategoryId;

const SORT_OPTIONS: Array<{
  id: ThreadSortMode;
  label: string;
}> = [
  { id: "recent", label: "Most recent" },
  { id: "oldest", label: "Oldest" },
  { id: "title-asc", label: "A-Z" },
  { id: "title-desc", label: "Z-A" },
  { id: "panels-desc", label: "Most panels" },
];

function buildCategoryCounts(threads: ThreadSummary[]) {
  const counts = Object.fromEntries(
    THREAD_CATEGORY_DEFINITIONS.map((category) => [category.id, 0]),
  ) as Record<ThreadCategoryId, number>;

  for (const thread of threads) {
    counts[thread.categoryId] += 1;
  }

  return counts;
}

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

function OpenChatIcon() {
  return (
    <svg
      aria-hidden="true"
      className="thread-tile-open-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
    >
      <path d="M6 12h12" />
      <path d="m13 7 5 5-5 5" />
    </svg>
  );
}

function sortThreads(threads: ThreadSummary[], sortMode: ThreadSortMode) {
  return [...threads].sort((left, right) => {
    switch (sortMode) {
      case "oldest":
        return left.updatedAt.localeCompare(right.updatedAt);
      case "title-asc":
        return left.title.localeCompare(right.title, undefined, {
          sensitivity: "base",
        });
      case "title-desc":
        return right.title.localeCompare(left.title, undefined, {
          sensitivity: "base",
        });
      case "panels-desc":
        return (
          right.conversationCount - left.conversationCount ||
          right.updatedAt.localeCompare(left.updatedAt)
        );
      case "recent":
      default:
        return right.updatedAt.localeCompare(left.updatedAt);
    }
  });
}

interface ThreadTileCardProps {
  activeThreadId: string;
  onOpenThread: (conversationId: string) => void;
  thread: ThreadSummary;
}

function ThreadTileCard({
  activeThreadId,
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
      onDragStart={(event) => setMainThreadDragData(event.dataTransfer, thread.id)}
      type="button"
    >
      <div className="thread-tile-card-head">
        <span className="thread-tile-badge">
          {thread.conversationCount === 1
            ? "1 panel"
            : `${thread.conversationCount} panels`}
        </span>
        <span className="thread-tile-updated">{thread.updatedLabel}</span>
      </div>

      <div className="thread-tile-card-body">
        <span className="thread-tile-category">
          Auto category: {thread.categoryLabel}
        </span>
        <h4>{thread.title}</h4>
        <p>{thread.preview}</p>
      </div>

      <div className="thread-tile-card-foot">
        <span className="thread-tile-open-copy">
          {thread.id === activeThreadId ? "Open current chat" : "Open chat"}
        </span>
        <OpenChatIcon />
      </div>
    </button>
  );
}

export default function MainChatTileView({
  activeThreadId,
  onOpenThread,
  threads,
}: MainChatTileViewProps) {
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState<ThreadSortMode>("recent");
  const [categoryFilter, setCategoryFilter] =
    useState<ThreadCategoryFilter>("all");
  const deferredQuery = useDeferredValue(query);
  const normalizedQuery = deferredQuery.trim().toLowerCase();
  const normalizedThreads = normalizeThreads(threads);
  const threadsMatchingSearch = normalizedThreads.filter((thread) => {
    if (!normalizedQuery) {
      return true;
    }

    return (
      thread.title.toLowerCase().includes(normalizedQuery) ||
      thread.preview.toLowerCase().includes(normalizedQuery)
    );
  });
  const filteredThreads = sortThreads(
    threadsMatchingSearch.filter((thread) =>
      categoryFilter === "all" ? true : thread.categoryId === categoryFilter,
    ),
    sortMode,
  );
  const categoryTotals = buildCategoryCounts(normalizedThreads);
  const categoryMatchCounts = buildCategoryCounts(threadsMatchingSearch);
  const availableCategories = THREAD_CATEGORY_DEFINITIONS.filter(
    (category) => categoryTotals[category.id] > 0,
  );
  const displayedCategoryCounts = normalizedQuery
    ? categoryMatchCounts
    : categoryTotals;
  const selectedCategoryLabel =
    categoryFilter === "all"
      ? "All categories"
      : getThreadCategoryLabel(categoryFilter);
  const resultCopy = normalizedQuery
    ? `${filteredThreads.length} matching ${
        categoryFilter === "all" ? "" : `${selectedCategoryLabel.toLowerCase()} `
      }thread${filteredThreads.length === 1 ? "" : "s"}`
    : categoryFilter === "all"
      ? `${normalizedThreads.length} main thread${
          normalizedThreads.length === 1 ? "" : "s"
        }`
      : `${filteredThreads.length} ${selectedCategoryLabel.toLowerCase()} thread${
          filteredThreads.length === 1 ? "" : "s"
        }`;
  const emptyState =
    categoryFilter !== "all" && !normalizedQuery
      ? {
          body: "Switch to another auto category or start a new main chat.",
          title: `No threads are in ${selectedCategoryLabel} yet.`,
        }
      : normalizedQuery
        ? {
            body: "Try a different keyword, or switch to another auto category.",
            title: "No threads matched that search.",
          }
        : {
            body: "Start a new main chat and it will appear here.",
            title: "No threads yet.",
          };

  useEffect(() => {
    if (categoryFilter === "all") {
      return;
    }

    if (!normalizedThreads.some((thread) => thread.categoryId === categoryFilter)) {
      setCategoryFilter("all");
    }
  }, [categoryFilter, normalizedThreads]);

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

        <div
          aria-label="Sort threads"
          className="thread-tile-filters"
          role="toolbar"
        >
          {SORT_OPTIONS.map((option) => (
            <button
              key={option.id}
              aria-pressed={sortMode === option.id}
              className={
                sortMode === option.id
                  ? "thread-tile-filter is-active"
                  : "thread-tile-filter"
              }
              onClick={() => setSortMode(option.id)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="thread-tile-category-panel">
          <div className="thread-tile-category-meta">
            <div>
              <p className="thread-tile-category-label">
                Browse by auto category
              </p>
              <p className="thread-tile-category-copy">
                Use category filters without losing the full tile grid.
              </p>
            </div>
          </div>

          <div
            aria-label="Filter threads by category"
            className="thread-tile-filters"
            role="toolbar"
          >
            <button
              aria-pressed={categoryFilter === "all"}
              className={
                categoryFilter === "all"
                  ? "thread-tile-filter is-active"
                  : "thread-tile-filter"
              }
              onClick={() => setCategoryFilter("all")}
              type="button"
            >
              All
              <span className="thread-tile-filter-count">
                {normalizedQuery
                  ? threadsMatchingSearch.length
                  : normalizedThreads.length}
              </span>
            </button>

            {availableCategories.map((category) => (
              <button
                key={category.id}
                aria-pressed={categoryFilter === category.id}
                className={
                  categoryFilter === category.id
                    ? "thread-tile-filter is-active"
                    : "thread-tile-filter"
                }
                onClick={() => setCategoryFilter(category.id)}
                title={getThreadCategoryDescription(category.id)}
                type="button"
              >
                {category.label}
                <span className="thread-tile-filter-count">
                  {displayedCategoryCounts[category.id]}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="thread-tile-results-meta">
        <p className="thread-tile-results-copy">{resultCopy}</p>
        <p className="thread-tile-results-hint">
          Each tile shows the app&apos;s current best-fit category guess.
        </p>
      </div>

      {filteredThreads.length ? (
        <div className="thread-tile-grid">
          {filteredThreads.map((thread) => (
            <ThreadTileCard
              key={thread.id}
              activeThreadId={activeThreadId}
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
