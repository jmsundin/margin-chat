import { useEffect, useRef, useState } from "react";
import {
  ConversationGroupSelect,
  NewConversationGroupForm,
} from "./ConversationGroupControls";
import type { ChatOutlineItem } from "../lib/chatOutline";
import {
  getSidebarThreadDropAction,
  sortThreadsByRecentActivity,
} from "../lib/sidebarThreads";
import type { ConversationGroup, MainViewMode, ThreadSummary } from "../types";

type ThemeMode = "light" | "dark";
type ThreadActionTarget = Pick<ThreadSummary, "id" | "title">;

const THREAD_MENU_WIDTH = 176;
const THREAD_MENU_HEIGHT = 212;
const THREAD_MENU_GAP = 8;
const THREAD_MENU_VIEWPORT_MARGIN = 12;

interface ThreadSidebarProps {
  activeOutlineItemId: string | null;
  activeThreadId: string;
  collapsed: boolean;
  currentChatOutline: ChatOutlineItem[];
  currentChatTitle: string;
  groups: Record<string, ConversationGroup>;
  mainViewMode: MainViewMode;
  onAssignGroup: (conversationId: string, groupId: string | null) => void;
  onCreateGroup: (name: string) => void;
  onDeleteThread: (conversationId: string) => void;
  onNewChat: () => void;
  onNewNote: () => void;
  onOpenProfile: () => void;
  onOpenSettings: () => void;
  onOpenSearch: () => void;
  onPinThread: (conversationId: string) => void;
  onRenameThread: (conversationId: string, title: string) => void;
  onSelectOutlineItem: (outlineItemId: string) => void;
  onSetMainViewMode: (viewMode: MainViewMode) => void;
  onSelectThread: (conversationId: string) => void;
  onToggleCollapse: () => void;
  onToggleGroup: (groupId: string) => void;
  onToggleTheme: () => void;
  onUnpinThread: (conversationId: string) => void;
  pinnedThreads: ThreadSummary[];
  streamingThreadIds: ReadonlySet<string>;
  theme: ThemeMode;
  threads: ThreadSummary[];
}

function getThreadMenuPosition(triggerRect: DOMRect) {
  if (typeof window === "undefined") {
    return {
      left: THREAD_MENU_VIEWPORT_MARGIN,
      top: THREAD_MENU_VIEWPORT_MARGIN,
    };
  }

  const openAbove =
    triggerRect.bottom + THREAD_MENU_GAP + THREAD_MENU_HEIGHT >
    window.innerHeight - THREAD_MENU_VIEWPORT_MARGIN;
  const top = openAbove
    ? Math.max(
        THREAD_MENU_VIEWPORT_MARGIN,
        triggerRect.top - THREAD_MENU_HEIGHT - THREAD_MENU_GAP,
      )
    : Math.min(
        window.innerHeight - THREAD_MENU_HEIGHT - THREAD_MENU_VIEWPORT_MARGIN,
        triggerRect.bottom + THREAD_MENU_GAP,
      );
  const left = Math.min(
    window.innerWidth - THREAD_MENU_WIDTH - THREAD_MENU_VIEWPORT_MARGIN,
    Math.max(
      THREAD_MENU_VIEWPORT_MARGIN,
      triggerRect.right - THREAD_MENU_WIDTH,
    ),
  );

  return {
    left,
    top,
  };
}

function getCompactLabel(title: string) {
  const words = title.match(/[A-Za-z0-9]+/g) ?? [];

  if (words.length >= 2) {
    const first = words[0] ?? "";
    const second = words[1] ?? "";

    return `${first.charAt(0)}${second.charAt(0)}`.toUpperCase();
  }

  if (words.length === 1) {
    return (words[0] ?? "").slice(0, 2).toUpperCase();
  }

  return title.trim().slice(0, 2).toUpperCase() || "?";
}

function PlusIcon() {
  return (
    <svg
      aria-hidden="true"
      className="sidebar-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
    >
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg
      aria-hidden="true"
      className="sidebar-icon"
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

function NoteIcon() {
  return (
    <svg
      aria-hidden="true"
      className="sidebar-icon"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
    >
      <path d="M6 3.5h8.5L19 8v12.5H6z" />
      <path d="M14.5 3.5V8H19M9 12h7M9 15.5h5" />
    </svg>
  );
}

function TileViewIcon() {
  return (
    <svg
      aria-hidden="true"
      className="sidebar-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
    >
      <rect x="4" y="4" width="7" height="7" rx="1.4" />
      <rect x="13" y="4" width="7" height="7" rx="1.4" />
      <rect x="4" y="13" width="7" height="7" rx="1.4" />
      <rect x="13" y="13" width="7" height="7" rx="1.4" />
    </svg>
  );
}

function ChatViewIcon() {
  return (
    <svg
      aria-hidden="true"
      className="sidebar-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
    >
      <path d="M7 16.5H5a2 2 0 0 1-2-2V6.8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v7.7a2 2 0 0 1-2 2h-7l-4.6 3.7c-.4.3-1 .1-1-.5z" />
      <path d="M8 9h8" />
      <path d="M8 12.5h5" />
    </svg>
  );
}

function GraphViewIcon() {
  return (
    <svg
      aria-hidden="true"
      className="sidebar-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
    >
      <circle cx="5.5" cy="7" r="2.2" />
      <circle cx="18.5" cy="6" r="2.2" />
      <circle cx="10" cy="18" r="2.2" />
      <path d="M7.5 7.8 16.4 6.2" />
      <path d="M6.9 8.9 8.9 16" />
      <path d="m16.9 7.8-5.3 8.4" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg
      aria-hidden="true"
      className="sidebar-utility-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.9"
    >
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 15a1 1 0 0 0 .2 1.1l.1.1a1.9 1.9 0 0 1-2.7 2.7l-.1-.1a1 1 0 0 0-1.1-.2 1 1 0 0 0-.6.9V20a1.9 1.9 0 0 1-3.8 0v-.2a1 1 0 0 0-.6-.9 1 1 0 0 0-1.1.2l-.1.1a1.9 1.9 0 1 1-2.7-2.7l.1-.1a1 1 0 0 0 .2-1.1 1 1 0 0 0-.9-.6H4a1.9 1.9 0 0 1 0-3.8h.2a1 1 0 0 0 .9-.6 1 1 0 0 0-.2-1.1l-.1-.1a1.9 1.9 0 1 1 2.7-2.7l.1.1a1 1 0 0 0 1.1.2 1 1 0 0 0 .6-.9V4a1.9 1.9 0 0 1 3.8 0v.2a1 1 0 0 0 .6.9 1 1 0 0 0 1.1-.2l.1-.1a1.9 1.9 0 1 1 2.7 2.7l-.1.1a1 1 0 0 0-.2 1.1 1 1 0 0 0 .9.6h.2a1.9 1.9 0 1 1 0 3.8h-.2a1 1 0 0 0-.9.6Z" />
    </svg>
  );
}

function ProfileIcon() {
  return (
    <svg
      aria-hidden="true"
      className="sidebar-utility-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.9"
    >
      <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </svg>
  );
}

function ThemeToggleIcon({ theme }: { theme: ThemeMode }) {
  if (theme === "dark") {
    return (
      <svg
        aria-hidden="true"
        className="theme-toggle-glyph"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      >
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2.5v2.5" />
        <path d="M12 19v2.5" />
        <path d="m4.9 4.9 1.8 1.8" />
        <path d="m17.3 17.3 1.8 1.8" />
        <path d="M2.5 12H5" />
        <path d="M19 12h2.5" />
        <path d="m4.9 19.1 1.8-1.8" />
        <path d="m17.3 6.7 1.8-1.8" />
      </svg>
    );
  }

  return (
    <svg
      aria-hidden="true"
      className="theme-toggle-glyph"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
    >
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg
      aria-hidden="true"
      className="thread-item-menu-icon"
      viewBox="0 0 24 24"
      fill="currentColor"
    >
      <circle cx="6.5" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="17.5" cy="12" r="1.7" />
    </svg>
  );
}

function DragHandleIcon() {
  return (
    <svg
      aria-hidden="true"
      className="thread-item-drag-icon"
      fill="currentColor"
      viewBox="0 0 12 18"
    >
      <circle cx="3" cy="3" r="1.2" />
      <circle cx="9" cy="3" r="1.2" />
      <circle cx="3" cy="9" r="1.2" />
      <circle cx="9" cy="9" r="1.2" />
      <circle cx="3" cy="15" r="1.2" />
      <circle cx="9" cy="15" r="1.2" />
    </svg>
  );
}

function PinIcon({ filled = false }: { filled?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className="thread-item-pin-icon"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
    >
      <path d="m8 3 8 0-1.2 5.2 3.2 3.2v1.6H6v-1.6l3.2-3.2L8 3Z" />
      <path d="M12 13v8" fill="none" />
    </svg>
  );
}

function ExpandIcon() {
  return (
    <svg
      aria-hidden="true"
      className="thread-item-expand-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function SidebarCollapseIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className="sidebar-collapse-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
    >
      <path d="M18 5v14" />
      <path d={collapsed ? "m11 6 5 6-5 6" : "m13 6-5 6 5 6"} />
    </svg>
  );
}

export default function ThreadSidebar({
  activeOutlineItemId,
  activeThreadId,
  collapsed,
  currentChatOutline,
  currentChatTitle,
  groups,
  mainViewMode,
  onAssignGroup,
  onCreateGroup,
  onDeleteThread,
  onNewChat,
  onNewNote,
  onOpenProfile,
  onOpenSettings,
  onOpenSearch,
  onPinThread,
  onRenameThread,
  onSelectOutlineItem,
  onSetMainViewMode,
  onSelectThread,
  onToggleCollapse,
  onToggleGroup,
  onToggleTheme,
  onUnpinThread,
  pinnedThreads,
  streamingThreadIds,
  theme,
  threads,
}: ThreadSidebarProps) {
  const [openMenuState, setOpenMenuState] = useState<{
    left: number;
    threadId: string;
    top: number;
  } | null>(null);
  const [renameTarget, setRenameTarget] = useState<ThreadActionTarget | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ThreadActionTarget | null>(null);
  const [expandedThreadIds, setExpandedThreadIds] = useState<Record<string, boolean>>(
    {},
  );
  const [draggedThreadId, setDraggedThreadId] = useState<string | null>(null);
  const [dropTargetKey, setDropTargetKey] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!renameTarget) {
      return;
    }

    setRenameValue(renameTarget.title);
  }, [renameTarget]);

  useEffect(() => {
    if (!openMenuState) {
      return undefined;
    }

    function handlePointerDown(event: MouseEvent) {
      const target = event.target as HTMLElement;

      if (
        menuRef.current?.contains(target) ||
        target.closest("[data-thread-menu-trigger='true']")
      ) {
        return;
      }

      setOpenMenuState(null);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpenMenuState(null);
      }
    }

    function handleViewportChange() {
      setOpenMenuState(null);
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [openMenuState]);

  useEffect(() => {
    if (!renameTarget && !deleteTarget) {
      return undefined;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setRenameTarget(null);
        setDeleteTarget(null);
      }
    }

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [deleteTarget, renameTarget]);

  useEffect(() => {
    if (!collapsed) {
      return;
    }

    setOpenMenuState(null);
  }, [collapsed]);

  useEffect(() => {
    const threadIds = new Set(threads.map((thread) => thread.id));

    if (openMenuState && !threadIds.has(openMenuState.threadId)) {
      setOpenMenuState(null);
    }

    if (renameTarget && !threadIds.has(renameTarget.id)) {
      setRenameTarget(null);
    }

    if (deleteTarget && !threadIds.has(deleteTarget.id)) {
      setDeleteTarget(null);
    }

    setExpandedThreadIds((current) => {
      let changed = false;
      const next: Record<string, boolean> = {};

      for (const [threadId, expanded] of Object.entries(current)) {
        if (!threadIds.has(threadId)) {
          changed = true;
          continue;
        }

        next[threadId] = expanded;
      }

      return changed ? next : current;
    });
  }, [deleteTarget, openMenuState, renameTarget, threads]);

  function handleOpenMenu(event: React.MouseEvent<HTMLButtonElement>, thread: ThreadSummary) {
    const triggerRect = event.currentTarget.getBoundingClientRect();
    const nextPosition = getThreadMenuPosition(triggerRect);

    setOpenMenuState((current) =>
      current?.threadId === thread.id
        ? null
        : {
            threadId: thread.id,
            ...nextPosition,
          },
    );
  }

  function handleOpenRename(thread: ThreadSummary) {
    setOpenMenuState(null);
    setRenameTarget({
      id: thread.id,
      title: thread.title,
    });
  }

  function handleOpenDelete(thread: ThreadSummary) {
    setOpenMenuState(null);
    setDeleteTarget({
      id: thread.id,
      title: thread.title,
    });
  }

  function handleSubmitRename(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!renameTarget) {
      return;
    }

    const trimmedTitle = renameValue.trim();

    if (!trimmedTitle) {
      return;
    }

    onRenameThread(renameTarget.id, trimmedTitle);
    setRenameTarget(null);
  }

  function handleConfirmDelete() {
    if (!deleteTarget) {
      return;
    }

    onDeleteThread(deleteTarget.id);
    setDeleteTarget(null);
  }

  function handleToggleExpanded(threadId: string) {
    const willExpand = !expandedThreadIds[threadId];

    setExpandedThreadIds((current) => ({
      [threadId]: !current[threadId],
    }));

    if (willExpand && threadId !== activeThreadId) {
      setOpenMenuState(null);
      onSelectThread(threadId);
    }
  }

  function handleThreadDragStart(
    event: React.DragEvent<HTMLElement>,
    threadId: string,
  ) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", threadId);
    setDraggedThreadId(threadId);
    setOpenMenuState(null);
  }

  function handleThreadDragEnd() {
    setDraggedThreadId(null);
    setDropTargetKey(null);
  }

  function handleThreadDragOver(
    event: React.DragEvent<HTMLElement>,
    targetKey: string,
  ) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropTargetKey(targetKey);
  }

  function handleThreadDragLeave(
    event: React.DragEvent<HTMLElement>,
    targetKey: string,
  ) {
    const relatedTarget = event.relatedTarget;

    if (
      relatedTarget instanceof Node &&
      event.currentTarget.contains(relatedTarget)
    ) {
      return;
    }

    setDropTargetKey((current) => current === targetKey ? null : current);
  }

  function handleThreadDrop(
    event: React.DragEvent<HTMLElement>,
    target: { groupId?: string | null; pinned?: boolean },
  ) {
    event.preventDefault();
    const threadId =
      event.dataTransfer.getData("text/plain") || draggedThreadId;

    setDraggedThreadId(null);
    setDropTargetKey(null);

    if (!threadId || !threads.some((thread) => thread.id === threadId)) {
      return;
    }

    const action = getSidebarThreadDropAction({
      isPinned: pinnedThreadIds.has(threadId),
      targetGroupId: target.groupId,
      targetPinned: target.pinned,
    });

    if (action.assignGroup) {
      onAssignGroup(threadId, action.groupId);
    }

    if (action.pin) {
      onPinThread(threadId);
    }

    if (action.unpin) {
      onUnpinThread(threadId);
    }
  }

  const pinnedThreadIds = new Set(pinnedThreads.map((thread) => thread.id));
  const recentThreads = sortThreadsByRecentActivity(threads);
  const recentPinnedThreads = recentThreads.filter((thread) =>
    pinnedThreadIds.has(thread.id),
  );
  const unpinnedThreads = recentThreads.filter(
    (thread) => !pinnedThreadIds.has(thread.id),
  );
  const groupPriority = new Map<string, number>();

  unpinnedThreads.forEach((thread, index) => {
    if (thread.groupId && !groupPriority.has(thread.groupId)) {
      groupPriority.set(thread.groupId, index);
    }
  });

  const activityOrderedGroups = Object.values(groups).sort(
    (left, right) =>
      (groupPriority.get(left.id) ?? Number.POSITIVE_INFINITY) -
      (groupPriority.get(right.id) ?? Number.POSITIVE_INFINITY),
  );
  const groupedThreads = activityOrderedGroups.flatMap((group) =>
    unpinnedThreads.filter((thread) => thread.groupId === group.id),
  );
  const ungroupedThreads = unpinnedThreads.filter((thread) => !thread.groupId);
  const orderedThreads = [
    ...recentPinnedThreads,
    ...groupedThreads,
    ...ungroupedThreads,
  ];

  function renderThreadItem(thread: ThreadSummary) {
    const isExpanded = Boolean(expandedThreadIds[thread.id]);
    const isPinned = pinnedThreadIds.has(thread.id);
    const isStreaming = streamingThreadIds.has(thread.id);

    return (
      <div
        className={
          [
            "thread-item",
            thread.id === activeThreadId ? "is-active" : "",
            isPinned ? "is-pinned" : "",
            isStreaming ? "is-streaming" : "",
            thread.kind === "note" ? "is-note" : "",
            draggedThreadId === thread.id ? "is-dragging" : "",
          ]
            .filter(Boolean)
            .join(" ")
        }
        key={thread.id}
      >
        <span className="thread-item-drag-handle" title="Drag to pin or group">
          <DragHandleIcon />
        </span>
        <button
          className="thread-item-main"
          draggable
          onDragEnd={handleThreadDragEnd}
          onDragStart={(event) => handleThreadDragStart(event, thread.id)}
          onClick={() => {
            setOpenMenuState(null);
            onSelectThread(thread.id);
          }}
          title={thread.title}
          type="button"
        >
          <span className="thread-item-title">
            {thread.kind === "note" ? (
              <span aria-hidden="true" className="thread-item-kind-icon">
                <NoteIcon />
              </span>
            ) : null}
            <span>{thread.title}</span>
          </span>
          <span className="thread-item-meta">
            {isStreaming ? (
              <span className="thread-streaming-status" role="status" title="Response streaming">
                <span aria-hidden="true" className="thread-streaming-dot" />
                <span className="thread-streaming-label">Streaming</span>
              </span>
            ) : null}
            <span className="thread-item-date">{thread.updatedLabel}</span>
          </span>
        </button>

        {thread.kind !== "note" ? (
          <button
            aria-controls={`chat-outline-${thread.id}`}
            aria-expanded={isExpanded}
            aria-label={`${isExpanded ? "Collapse" : "Expand"} outline for ${thread.title}`}
            className={
              isExpanded
                ? "thread-item-expand-trigger is-expanded"
                : "thread-item-expand-trigger"
            }
            onClick={() => handleToggleExpanded(thread.id)}
            type="button"
          >
            <ExpandIcon />
          </button>
        ) : null}

        <button
          aria-controls={
            openMenuState?.threadId === thread.id
              ? `thread-menu-${thread.id}`
              : undefined
          }
          aria-expanded={openMenuState?.threadId === thread.id}
          aria-haspopup="menu"
          aria-label={`Open actions for ${thread.title}`}
          className="thread-item-menu-trigger"
          data-thread-menu-trigger="true"
          onClick={(event) => handleOpenMenu(event, thread)}
          type="button"
        >
          <MoreIcon />
        </button>

        {isExpanded && thread.id === activeThreadId ? (
          <nav
            aria-label={`Outline for ${currentChatTitle}`}
            className="chat-outline is-nested"
            id={`chat-outline-${thread.id}`}
          >
            {currentChatOutline.length ? (
              <ol className="chat-outline-list">
                {currentChatOutline.map((item) => (
                  <li
                    className={`chat-outline-level-${item.level}`}
                    key={item.id}
                  >
                    <button
                      aria-current={
                        item.id === activeOutlineItemId
                          ? "location"
                          : undefined
                      }
                      className={
                        item.id === activeOutlineItemId
                          ? "chat-outline-item is-active"
                          : "chat-outline-item"
                      }
                      onClick={() => onSelectOutlineItem(item.id)}
                      title={item.label}
                      type="button"
                    >
                      <span
                        aria-hidden="true"
                        className="chat-outline-marker"
                      />
                      <span className="chat-outline-label">{item.label}</span>
                    </button>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="chat-outline-empty">
                Send a message to start this outline.
              </p>
            )}
          </nav>
        ) : null}
      </div>
    );
  }

  return (
    <aside className={collapsed ? "thread-sidebar is-collapsed" : "thread-sidebar"}>
      <div className="thread-sidebar-head">
        <div className="thread-sidebar-title-row">
          <div aria-label="Main workspace view" className="thread-view-switcher" role="group">
            <button
              aria-label="Open chat panel view"
              aria-pressed={mainViewMode === "chat"}
              className={
                mainViewMode === "chat"
                  ? "thread-view-button is-active"
                  : "thread-view-button"
              }
              onClick={() => onSetMainViewMode("chat")}
              title="Open chat panel view"
              type="button"
            >
              <ChatViewIcon />
            </button>
            <button
              aria-label="Open tile view"
              aria-pressed={mainViewMode === "tiles"}
              className={
                mainViewMode === "tiles"
                  ? "thread-view-button is-active"
                  : "thread-view-button"
              }
              onClick={() => onSetMainViewMode("tiles")}
              title="Open tile view"
              type="button"
            >
              <TileViewIcon />
            </button>
            <button
              aria-label="Open graph view"
              aria-pressed={mainViewMode === "graph"}
              className={
                mainViewMode === "graph"
                  ? "thread-view-button is-active"
                  : "thread-view-button"
              }
              onClick={() => onSetMainViewMode("graph")}
              title="Open graph view"
              type="button"
            >
              <GraphViewIcon />
            </button>
          </div>
          <div aria-label="Workspace actions" className="thread-sidebar-tools" role="group">
            <button
              aria-label="New note"
              className="sidebar-tool-button"
              onClick={onNewNote}
              title="New note"
              type="button"
            >
              <NoteIcon />
            </button>
            <button
              aria-label="Search chats"
              className="sidebar-tool-button"
              onClick={onOpenSearch}
              title="Search chats"
              type="button"
            >
              <SearchIcon />
            </button>
            <NewConversationGroupForm compact iconOnly onCreate={onCreateGroup} />
          </div>
        </div>
        <button
          aria-label={collapsed ? "Expand left sidebar" : "Minimize left sidebar"}
          className="sidebar-utility-button sidebar-collapse-button"
          onClick={onToggleCollapse}
          title={collapsed ? "Expand left sidebar" : "Minimize left sidebar"}
          type="button"
        >
          <SidebarCollapseIcon collapsed={collapsed} />
        </button>
      </div>

      <div className="thread-sidebar-actions">
        <button
          aria-label="New chat"
          className="sidebar-action is-primary"
          onClick={onNewChat}
          title="New chat"
          type="button"
        >
          <PlusIcon />
          <span>New chat</span>
        </button>
      </div>

      {collapsed ? (
        <div className="thread-sidebar-mini-list">
          {orderedThreads.map((thread) => {
            const isPinned = pinnedThreadIds.has(thread.id);
            const isStreaming = streamingThreadIds.has(thread.id);

            return (
              <button
                key={thread.id}
                aria-label={`Open ${thread.kind === "note" ? "note" : "chat"} ${thread.title}${isStreaming ? ", response streaming" : ""}`}
                className={
                  [
                    "thread-sidebar-mini-item",
                    thread.id === activeThreadId ? "is-active" : "",
                    isPinned ? "is-pinned" : "",
                    isStreaming ? "is-streaming" : "",
                    thread.kind === "note" ? "is-note" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")
                }
                onClick={() => {
                  setOpenMenuState(null);
                  onSelectThread(thread.id);
                }}
                title={thread.title}
                type="button"
              >
                <span className="thread-sidebar-mini-badge" aria-hidden="true">
                  {thread.kind === "note" ? <NoteIcon /> : getCompactLabel(thread.title)}
                </span>
                {isPinned ? (
                  <span className="thread-sidebar-mini-pin" aria-hidden="true">
                    <PinIcon filled />
                  </span>
                ) : null}
                {isStreaming ? (
                  <span
                    aria-hidden="true"
                    className="thread-sidebar-mini-streaming"
                  />
                ) : null}
                <span className="thread-sidebar-mini-card" aria-hidden="true">
                  <span className="thread-sidebar-mini-title">{thread.title}</span>
                  <span className="thread-sidebar-mini-meta">
                    {isStreaming ? (
                      <>
                        <span className="thread-streaming-status">
                          <span className="thread-streaming-dot" />
                          Streaming
                        </span>
                        <span>•</span>
                      </>
                    ) : null}
                    {thread.updatedLabel}
                  </span>
                  <span className="thread-sidebar-mini-preview">{thread.preview}</span>
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="thread-list">
          <section
            aria-label="Pinned chats and notes"
            className={
              dropTargetKey === "pinned"
                ? "thread-sidebar-section is-pinned is-drop-target"
                : "thread-sidebar-section is-pinned"
            }
            data-thread-drop-target="pinned"
            onDragLeave={(event) => handleThreadDragLeave(event, "pinned")}
            onDragOver={(event) => handleThreadDragOver(event, "pinned")}
            onDrop={(event) =>
              handleThreadDrop(event, { pinned: true })
            }
          >
            <div className="thread-group-section-header is-pinned">
              <div className="thread-section-label">
                <span aria-hidden="true" className="thread-section-pin-icon">
                  <PinIcon filled />
                </span>
                <span>Pinned</span>
                <span className="thread-section-count">
                  {recentPinnedThreads.length}
                </span>
              </div>
            </div>
            {recentPinnedThreads.length ? (
              recentPinnedThreads.map(renderThreadItem)
            ) : (
              <p className="thread-section-drop-hint">Drop here to pin</p>
            )}
          </section>

          {activityOrderedGroups.map((group) => {
            const sectionThreads = groupedThreads.filter(
              (thread) => thread.groupId === group.id,
            );
            const targetKey = `group:${group.id}`;

            return (
              <section
                aria-label={`${group.name} group`}
                className={
                  dropTargetKey === targetKey
                    ? "thread-sidebar-section is-drop-target"
                    : "thread-sidebar-section"
                }
                data-thread-drop-target={targetKey}
                key={group.id}
                onDragLeave={(event) =>
                  handleThreadDragLeave(event, targetKey)
                }
                onDragOver={(event) =>
                  handleThreadDragOver(event, targetKey)
                }
                onDrop={(event) =>
                  handleThreadDrop(event, {
                    groupId: group.id,
                  })
                }
              >
                <div className="thread-group-section-header">
                  <button
                    aria-expanded={!group.collapsed}
                    onClick={() => onToggleGroup(group.id)}
                    type="button"
                  >
                    <span
                      aria-hidden="true"
                      className="conversation-group-color"
                      style={{ backgroundColor: group.color }}
                    />
                    <span>{group.name}</span>
                    <span className="thread-section-count">
                      {sectionThreads.length}
                    </span>
                    <span aria-hidden="true">
                      {group.collapsed ? "＋" : "−"}
                    </span>
                  </button>
                </div>
                {!group.collapsed ? (
                  sectionThreads.length ? (
                    sectionThreads.map(renderThreadItem)
                  ) : (
                    <p className="thread-section-drop-hint">Drop into group</p>
                  )
                ) : null}
              </section>
            );
          })}

          <section
            aria-label="Ungrouped chats and notes"
            className={
              dropTargetKey === "ungrouped"
                ? "thread-sidebar-section is-ungrouped is-drop-target"
                : "thread-sidebar-section is-ungrouped"
            }
            data-thread-drop-target="ungrouped"
            onDragLeave={(event) => handleThreadDragLeave(event, "ungrouped")}
            onDragOver={(event) => handleThreadDragOver(event, "ungrouped")}
            onDrop={(event) =>
              handleThreadDrop(event, { groupId: null })
            }
          >
            <div className="thread-group-section-header">
              <div className="thread-section-label">
                <span
                  aria-hidden="true"
                  className="conversation-group-color is-ungrouped"
                />
                <span>Ungrouped</span>
                <span className="thread-section-count">
                  {ungroupedThreads.length}
                </span>
              </div>
            </div>
            {ungroupedThreads.length ? (
              ungroupedThreads.map(renderThreadItem)
            ) : (
              <p className="thread-section-drop-hint">Drop here to ungroup</p>
            )}
          </section>
        </div>
      )}

      <div className="thread-sidebar-footer">
        <button
          aria-label="Open profile"
          className="sidebar-utility-button"
          onClick={onOpenProfile}
          title="Profile"
          type="button"
        >
          <ProfileIcon />
        </button>

        <button
          aria-label="Open settings"
          className="sidebar-utility-button"
          onClick={onOpenSettings}
          title="Settings"
          type="button"
        >
          <SettingsIcon />
        </button>

        <button
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          className="sidebar-utility-button is-theme-toggle"
          onClick={onToggleTheme}
          title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          type="button"
        >
          <ThemeToggleIcon theme={theme} />
        </button>
      </div>

      {openMenuState ? (
        <div
          aria-label="Thread actions"
          className="thread-item-menu"
          id={`thread-menu-${openMenuState.threadId}`}
          ref={menuRef}
          role="menu"
          style={{
            left: `${openMenuState.left}px`,
            top: `${openMenuState.top}px`,
          }}
        >
          {threads
            .filter((thread) => thread.id === openMenuState.threadId)
            .map((thread) => (
              <div key={thread.id} className="thread-item-menu-group" role="none">
                <button
                  className="thread-item-menu-action"
                  onClick={() => {
                    if (pinnedThreadIds.has(thread.id)) {
                      onUnpinThread(thread.id);
                    } else {
                      onPinThread(thread.id);
                    }

                    setOpenMenuState(null);
                  }}
                  role="menuitem"
                  type="button"
                >
                  <PinIcon filled={pinnedThreadIds.has(thread.id)} />
                  <span>{pinnedThreadIds.has(thread.id) ? "Unpin" : "Pin"}</span>
                </button>
                <button
                  className="thread-item-menu-action"
                  onClick={() => handleOpenRename(thread)}
                  role="menuitem"
                  type="button"
                >
                  Rename
                </button>
                <ConversationGroupSelect
                  className="is-menu"
                  conversationId={thread.id}
                  groups={groups}
                  onAssign={(conversationId, groupId) => {
                    onAssignGroup(conversationId, groupId);
                    setOpenMenuState(null);
                  }}
                />
                <button
                  className="thread-item-menu-action is-danger"
                  onClick={() => handleOpenDelete(thread)}
                  role="menuitem"
                  type="button"
                >
                  Delete
                </button>
              </div>
            ))}
        </div>
      ) : null}

      {renameTarget ? (
        <div
          className="thread-dialog-backdrop"
          onClick={() => setRenameTarget(null)}
          role="presentation"
        >
          <section
            aria-labelledby="thread-rename-title"
            aria-modal="true"
            className="thread-dialog"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
          >
            <form className="thread-dialog-form" onSubmit={handleSubmitRename}>
              <div className="thread-dialog-head">
                <div>
                  <p className="eyebrow">Thread settings</p>
                  <h2 id="thread-rename-title">Rename chat</h2>
                </div>
              </div>

              <label className="thread-dialog-field">
                <span className="thread-dialog-label">Chat title</span>
                <input
                  autoFocus
                  className="thread-dialog-input"
                  maxLength={120}
                  onChange={(event) => setRenameValue(event.target.value)}
                  placeholder="Enter a new chat title"
                  type="text"
                  value={renameValue}
                />
              </label>

              <div className="thread-dialog-actions">
                <button
                  className="thread-dialog-button"
                  onClick={() => setRenameTarget(null)}
                  type="button"
                >
                  Cancel
                </button>
                <button
                  className="thread-dialog-button is-primary"
                  disabled={!renameValue.trim()}
                  type="submit"
                >
                  Save
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {deleteTarget ? (
        <div
          className="thread-dialog-backdrop"
          onClick={() => setDeleteTarget(null)}
          role="presentation"
        >
          <section
            aria-labelledby="thread-delete-title"
            aria-modal="true"
            className="thread-dialog"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
          >
            <div className="thread-dialog-head">
              <div>
                <p className="eyebrow">Thread settings</p>
                <h2 id="thread-delete-title">Delete chat?</h2>
              </div>
            </div>

            <p className="thread-dialog-copy">
              This will delete <strong>{deleteTarget.title}</strong> and every branch
              inside this thread.
            </p>

            <p className="thread-dialog-warning">
              You can cancel to keep the chat, or confirm to remove it entirely.
            </p>

            <div className="thread-dialog-actions">
              <button
                className="thread-dialog-button"
                onClick={() => setDeleteTarget(null)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="thread-dialog-button is-danger"
                onClick={handleConfirmDelete}
                type="button"
              >
                Delete
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </aside>
  );
}
