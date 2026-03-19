import { useEffect, useRef, useState } from "react";
import { setMainThreadDragData } from "../lib/pinnedThreads";
import type { ThreadSummary } from "../types";

type MainViewMode = "chat" | "tiles";
type ThemeMode = "light" | "dark";
type ThreadActionTarget = Pick<ThreadSummary, "id" | "title">;

const THREAD_MENU_WIDTH = 176;
const THREAD_MENU_HEIGHT = 108;
const THREAD_MENU_GAP = 8;
const THREAD_MENU_VIEWPORT_MARGIN = 12;

interface ThreadSidebarProps {
  activeThreadId: string;
  collapsed: boolean;
  mainViewMode: MainViewMode;
  onDeleteThread: (conversationId: string) => void;
  onMainThreadDragEnd: () => void;
  onMainThreadDragStart: () => void;
  onNewChat: () => void;
  onOpenSettings: () => void;
  onOpenSearch: () => void;
  onRenameThread: (conversationId: string, title: string) => void;
  onSelectThread: (conversationId: string) => void;
  onToggleCollapse: () => void;
  onToggleMainViewMode: () => void;
  onToggleTheme: () => void;
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
  activeThreadId,
  collapsed,
  mainViewMode,
  onDeleteThread,
  onMainThreadDragEnd,
  onMainThreadDragStart,
  onNewChat,
  onOpenSettings,
  onOpenSearch,
  onRenameThread,
  onSelectThread,
  onToggleCollapse,
  onToggleMainViewMode,
  onToggleTheme,
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
    setExpandedThreadIds((current) => ({
      ...current,
      [threadId]: !current[threadId],
    }));
  }

  function handleThreadDragStart(
    event: React.DragEvent<HTMLButtonElement>,
    threadId: string,
  ) {
    onMainThreadDragStart();
    setMainThreadDragData(event.dataTransfer, threadId);
  }

  return (
    <aside className={collapsed ? "thread-sidebar is-collapsed" : "thread-sidebar"}>
      <div className="thread-sidebar-head">
        <div className="thread-sidebar-title-row">
          <button
            aria-label={
              mainViewMode === "tiles"
                ? "Switch back to chat view"
                : "Switch to tile view"
            }
            className="thread-view-toggle"
            onClick={onToggleMainViewMode}
            title={mainViewMode === "tiles" ? "Switch to chat view" : "Switch to tile view"}
            type="button"
          >
            {mainViewMode === "tiles" ? <ChatViewIcon /> : <TileViewIcon />}
          </button>
          <h2>Margin Chat</h2>
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

        <button
          aria-label="Search chats"
          className="sidebar-action"
          onClick={onOpenSearch}
          title="Search chats"
          type="button"
        >
          <SearchIcon />
          <span>Search chats</span>
        </button>
      </div>

      {collapsed ? (
        <div className="thread-sidebar-mini-list">
          {threads.map((thread) => {
            const branchCount = Math.max(thread.conversationCount - 1, 0);

            return (
              <button
                key={thread.id}
                aria-label={`Open chat ${thread.title}`}
                className={
                  thread.id === activeThreadId
                    ? "thread-sidebar-mini-item is-active"
                    : "thread-sidebar-mini-item"
                }
                onClick={() => {
                  setOpenMenuState(null);
                  onSelectThread(thread.id);
                }}
                title={thread.title}
                type="button"
              >
                <span className="thread-sidebar-mini-badge" aria-hidden="true">
                  {getCompactLabel(thread.title)}
                </span>
                <span className="thread-sidebar-mini-card" aria-hidden="true">
                  <span className="thread-sidebar-mini-title">{thread.title}</span>
                  <span className="thread-sidebar-mini-meta">
                    {branchCount === 1 ? "1 branch" : `${branchCount} branches`}
                    <span aria-hidden="true">•</span>
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
          {threads.map((thread) => {
            const branchCount = Math.max(thread.conversationCount - 1, 0);
            const isExpanded = Boolean(expandedThreadIds[thread.id]);

            return (
              <div
                key={thread.id}
                className={
                  thread.id === activeThreadId ? "thread-item is-active" : "thread-item"
                }
              >
                <button
                  className="thread-item-main"
                  draggable
                  onClick={() => {
                    setOpenMenuState(null);
                    onSelectThread(thread.id);
                  }}
                  onDragEnd={onMainThreadDragEnd}
                  onDragStart={(event) => handleThreadDragStart(event, thread.id)}
                  type="button"
                >
                  <span className="thread-item-title">{thread.title}</span>
                  <span className="thread-item-meta">
                    {branchCount === 1 ? "1 branch" : `${branchCount} branches`}
                    <span aria-hidden="true">•</span>
                    {thread.updatedLabel}
                  </span>
                  {isExpanded ? (
                    <span className="thread-item-preview" id={`thread-preview-${thread.id}`}>
                      {thread.preview}
                    </span>
                  ) : null}
                </button>

                <button
                  aria-controls={`thread-preview-${thread.id}`}
                  aria-expanded={isExpanded}
                  aria-label={`${isExpanded ? "Collapse" : "Expand"} preview for ${thread.title}`}
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
              </div>
            );
          })}
        </div>
      )}

      <div className="thread-sidebar-footer">
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
                  onClick={() => handleOpenRename(thread)}
                  role="menuitem"
                  type="button"
                >
                  Rename
                </button>
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
