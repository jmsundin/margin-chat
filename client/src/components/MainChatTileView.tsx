import { useDeferredValue, useState, type ReactNode } from "react";
import {
  ConversationGroupSelect,
  NewConversationGroupForm,
} from "./ConversationGroupControls";
import {
  categorizeThread,
  getThreadCategoryLabel,
} from "../lib/threadCategories";
import type { ConversationGroup, ThreadSummary } from "../types";
import RoadmapTiles, { type RoadmapTile } from "./RoadmapTiles";

/**
 * Tile view's tabs. Documents and Roadmaps are what you made; Groups and Spaces are two different
 * ways of keeping documents together: a group is a label, like a tag, and a space is a workspace
 * you're actively working in, with its own tabs to come back to.
 */
export type TileTab = "documents" | "roadmaps" | "groups" | "spaces";
const TILE_TABS: readonly TileTab[] = ["documents", "roadmaps", "groups", "spaces"];
const TAB_KEY = "margin-chat:tile-tab";
/** The tab Tile view last showed on this device. */
export function readTileTab(): TileTab {
  try {
    const saved = window.localStorage.getItem(TAB_KEY);
    return TILE_TABS.includes(saved as TileTab) ? saved as TileTab : "documents";
  } catch { return "documents"; }
}
export function rememberTileTab(tab: TileTab) {
  try { window.localStorage.setItem(TAB_KEY, tab); } catch { /* remembered for this visit only */ }
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
  groups: Record<string, ConversationGroup>;
  onAssignGroup: (conversationId: string, groupId: string | null) => void;
  onCreateGroup: (name: string) => void;
  onOpenThread: (conversationId: string) => void;
  onToggleGroup: (groupId: string) => void;
  threads: ThreadSummary[];
  /** The tab shown, when there is more than Documents to show. */
  tab?: TileTab;
  onTab?(tab: TileTab): void;
  /** With Roadmaps on, Tile view has a Roadmaps tab: every roadmap as a tile. */
  roadmaps?: {
    tiles: RoadmapTile[];
    onOpen(id: string): void;
    onDraft(goal: string): string | null;
  };
  /** With Groups on, a Groups tab: documents sorted under their group, and where groups are made. */
  groupsEnabled?: boolean;
  /** With Spaces on, a Spaces tab: every space as a tile. */
  spaces?: { count: number; content: ReactNode };
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
  /** Only on the Groups tab: the card's own Group picker. */
  onAssignGroup?: (conversationId: string, groupId: string | null) => void;
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
      {onAssignGroup ? <ConversationGroupSelect
        className="is-tile"
        conversationId={thread.id}
        groups={groups}
        onAssign={onAssignGroup}
      /> : null}
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
  roadmaps,
  groupsEnabled = false,
  spaces,
  tab: shownTab = "documents",
  onTab,
}: MainChatTileViewProps) {
  const [query, setQuery] = useState("");
  const available: { id: TileTab; label: string }[] = [
    { id: "documents", label: "Documents" },
    ...(roadmaps ? [{ id: "roadmaps" as const, label: `Roadmaps${roadmaps.tiles.length ? ` ${roadmaps.tiles.length}` : ""}` }] : []),
    ...(groupsEnabled ? [{ id: "groups" as const, label: `Groups${Object.keys(groups).length ? ` ${Object.keys(groups).length}` : ""}` }] : []),
    ...(spaces ? [{ id: "spaces" as const, label: `Spaces${spaces.count ? ` ${spaces.count}` : ""}` }] : []),
  ];
  // A tab whose feature is off shows Documents.
  const tab: TileTab = available.some((option) => option.id === shownTab) ? shownTab : "documents";
  const tabs = available.length > 1 ? <div className="thread-tile-tabs" role="tablist" aria-label="Show">
    {available.map((option) => <button key={option.id} type="button" role="tab" aria-selected={tab === option.id}
      onClick={() => onTab?.(option.id)}>{option.label}</button>)}
  </div> : null;
  const deferredQuery = useDeferredValue(query);
  if (roadmaps && tab === "roadmaps") {
    return <section className="thread-tile-view">
      <div className="thread-tile-toolbar">{tabs}</div>
      <RoadmapTiles roadmaps={roadmaps.tiles} onOpen={roadmaps.onOpen} onDraft={roadmaps.onDraft} />
    </section>;
  }
  if (spaces && tab === "spaces") {
    return <section className="thread-tile-view">
      <div className="thread-tile-toolbar">{tabs}</div>
      {spaces.content}
    </section>;
  }
  const byGroup = tab === "groups";
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
  const groupSections = !byGroup ? [{
    collapsed: false, color: "transparent", id: null as string | null, name: "", threads: filteredThreads,
  }] : [
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
        {tabs}
        <label className="thread-tile-search" htmlFor="thread-tile-search">
          <SearchIcon />
          <input
            id="thread-tile-search"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search documents"
            type="search"
            value={query}
          />
        </label>
        {byGroup ? <NewConversationGroupForm onCreate={onCreateGroup} /> : null}
      </div>

      {filteredThreads.length ? (
        <div className="thread-tile-groups">
          {groupSections.map((section) => (
            <section
              className="thread-tile-group"
              key={section.id ?? "ungrouped"}
            >
              {byGroup ? <header className="thread-tile-group-header">
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
              </header> : null}

              {!section.collapsed ? (
                section.threads.length ? (
                  <div className="thread-tile-grid">
                    {section.threads.map((thread) => (
                      <ThreadTileCard
                        key={thread.id}
                        activeThreadId={activeThreadId}
                        groups={groups}
                        onAssignGroup={byGroup ? onAssignGroup : undefined}
                        onOpenThread={onOpenThread}
                        thread={thread}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="thread-tile-group-empty">
                    Nothing in this group yet. Pick it from a document&apos;s Group menu.
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
