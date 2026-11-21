import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useProgressiveList } from "../lib/useProgressiveList";
import { useSuggestedDocumentTitle } from "../lib/documentTitleSuggestion";
import { ConversationGroupPickerContext } from "./ConversationGroupControls";
import GroupPickerModal from "./GroupPickerModal";
import { SpaceMenuContext } from "./Spaces";
import { getConversationGroupId } from "../lib/conversationGroups";
import type { ChatOutlineItem } from "../lib/chatOutline";
import ChatOutline from "./ChatOutline";
import { sortDocumentsByCreation } from "../lib/sidebarThreads";
import type { ConversationGroup, MainViewMode, ThreadSummary } from "../types";
import { SIDEBAR_DOCUMENT_SORTS, groupByDate, type SidebarDateSection, type SidebarDocumentSort } from "../lib/sidebarDocumentOrder";
import type { SidebarDocumentOrder } from "../lib/useSidebarDocumentOrder";
import "./ThreadSidebar.css";

type ThemeMode = "light" | "dark";
type ThreadActionTarget = Pick<ThreadSummary, "id" | "title">;

const THREAD_MENU_WIDTH = 204;
const THREAD_MENU_HEIGHT = 212;
/** One more action row, such as Reveal in Finder. */
const THREAD_MENU_ITEM_HEIGHT = 42;
const THREAD_MENU_GAP = 8;
const THREAD_MENU_VIEWPORT_MARGIN = 12;

/** The left panel shows documents, or the open document's outline. Groups and Spaces live in Tile view. */
type SidebarContent = "documents" | "outline";

interface ThreadSidebarProps {
  header?: ReactNode;
  /** The open vault and a way to switch it, at the foot of the sidebar. */
  vaultSwitcher?: ReactNode;
  /** Order of the Documents list; without it, newest created first. */
  documentOrder?: SidebarDocumentOrder;
  documentSort?: SidebarDocumentSort;
  onDocumentSortChange?: (sort: SidebarDocumentSort) => void;
  /** Documents that are still only in the cloud vault, listed after this device's documents. */
  cloudIndex?: ReactNode;
  /** Shown above the document list while documents download. */
  fetchIndicator?: ReactNode;
  /** Documents that just streamed in from the cloud, briefly highlighted. */
  arrivingThreadIds?: ReadonlySet<string>;
  /** Groups (a feature): New group, and a Group section in each document's menu. */
  groupsEnabled?: boolean;
  /** Outline (a feature): the Outline tab and each document's outline arrow. */
  outlineEnabled?: boolean;
  mapExplorerRef?: (element: HTMLDivElement | null) => void;
  mapExplorerActive?: boolean;
  onSelectSidebarSection?: (section: "chats" | "explore") => void;
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
  onOpenInbox?: () => void;
  onImportChatHistory?: () => void;
  /** How many things an agent is waiting on the person for. */
  agentInboxCount?: number;
  /** Opens the agent inbox: questions, drafts to approve and runs that stopped early. */
  onOpenAgentInbox?: () => void;
  /** Start the guided tour from the beginning. */
  onTakeTour?: () => void;
  /** Opens Help: guides to using Margin Chat. */
  onOpenHelp?: () => void;
  /** Opens Settings → Features, where the tools beyond the essentials are switched on. */
  onMoreFeatures?: () => void;
  onOpenProfile: () => void;
  onOpenSearch: () => void;
  /** Cards to study now; null hides Review (no cards written yet). */
  flashcardsDue?: number | null;
  onOpenFlashcards?: () => void;
  /** Opens the language library: courses, mini stories and lessons. Only with Language learning on. */
  onOpenLanguages?: () => void;
  /** A new board document: one full-page canvas. */
  onNewBoard?: () => void;
  onPinThread: (conversationId: string) => void;
  onRenameThread: (conversationId: string, title: string) => void;
  /**
   * Desktop app with its own vault folder only: show a document's file in Finder or File Explorer.
   * `canReveal` leaves the item out for documents with no file in the folder yet.
   */
  revealInFolder?: { label: string; canReveal: (conversationId: string) => boolean; onReveal: (conversationId: string) => void };
  onSelectOutlineItem: (outlineItemId: string) => void;
  /** After the Outline moved the reader somewhere without an outline item, such as a PDF chapter. */
  onOutlineNavigated?: () => void;
  onSelectThread: (conversationId: string, options?: { keepSidebarOpen?: boolean }) => void;
  onToggleGroup: (groupId: string) => void;
  onToggleTheme: () => void;
  onUnpinThread: (conversationId: string) => void;
  pinnedThreads: ThreadSummary[];
  streamingThreadIds: ReadonlySet<string>;
  theme: ThemeMode;
  threads: ThreadSummary[];
}

function getThreadMenuPosition(triggerRect: DOMRect, extraHeight = 0) {
  const menuHeight = THREAD_MENU_HEIGHT + extraHeight;
  if (typeof window === "undefined") {
    return {
      left: THREAD_MENU_VIEWPORT_MARGIN,
      top: THREAD_MENU_VIEWPORT_MARGIN,
    };
  }

  const openAbove =
    triggerRect.bottom + THREAD_MENU_GAP + menuHeight >
    window.innerHeight - THREAD_MENU_VIEWPORT_MARGIN;
  const top = openAbove
    ? Math.max(
        THREAD_MENU_VIEWPORT_MARGIN,
        triggerRect.top - menuHeight - THREAD_MENU_GAP,
      )
    : Math.min(
        window.innerHeight - menuHeight - THREAD_MENU_VIEWPORT_MARGIN,
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

function BoardIcon() {
  return (
    <svg aria-hidden="true" className="sidebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8">
      {/* A whiteboard on its stand, with a line drawn on it. */}
      <rect x="3" y="4" width="18" height="12.5" rx="1.5" />
      <path d="M7 12.5l3-3 2.5 2.5L17 7.5" />
      <path d="M9 20.5l3-4 3 4" />
    </svg>
  );
}

function LanguagesIcon() {
  return (
    <svg aria-hidden="true" className="sidebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8">
      {/* An open book with a speech mark: reading to learn a language. */}
      <path d="M3 5.5c2.6-1 5.4-1 8 .6v13c-2.6-1.6-5.4-1.6-8-.6z" />
      <path d="M21 5.5c-2.6-1-5.4-1-8 .6v13c2.6-1.6 5.4-1.6 8-.6z" />
    </svg>
  );
}

function CardsIcon() {
  return (
    <svg aria-hidden="true" className="sidebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8">
      {/* A study card, wider than tall, with a question on it: reads as a flashcard, not as "copy". */}
      <rect x="2.5" y="5.5" width="19" height="13" rx="2" />
      <path d="M10 10.2a2 2 0 1 1 2.8 1.8c-.5.3-.8.7-.8 1.2v.3" />
      <path d="M12 15.9h.01" />
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

function DocumentIcon() {
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

function SortIcon() {
  return (
    <svg aria-hidden="true" className="sidebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8">
      <path d="M7 4v16M3.5 16.5 7 20l3.5-3.5M13 6h8M13 11h6M13 16h4" />
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

export default function ThreadSidebar({
  header,
  vaultSwitcher,
  documentOrder,
  documentSort = "recent",
  onDocumentSortChange,
  mapExplorerRef,
  mapExplorerActive = false,
  onSelectSidebarSection,
  activeOutlineItemId,
  activeThreadId,
  collapsed,
  currentChatOutline,
  currentChatTitle,
  groups,
  mainViewMode,
  onAssignGroup,
  onCreateGroup,
  groupsEnabled = true,
  outlineEnabled = true,
  onDeleteThread,
  onNewChat,
  onNewNote,
  onOpenInbox,
  onImportChatHistory,
  agentInboxCount = 0,
  onOpenAgentInbox,
  onTakeTour,
  onOpenHelp,
  onMoreFeatures,
  onOpenProfile,
  onOpenSearch,
  flashcardsDue = null,
  onOpenFlashcards,
  onOpenLanguages,
  onNewBoard,
  onPinThread,
  onRenameThread,
  revealInFolder,
  onSelectOutlineItem,
  onOutlineNavigated,
  onSelectThread,
  onToggleGroup,
  onToggleTheme,
  onUnpinThread,
  pinnedThreads,
  streamingThreadIds,
  theme,
  threads,
  cloudIndex,
  fetchIndicator,
  arrivingThreadIds,
}: ThreadSidebarProps) {
  const [openMenuState, setOpenMenuState] = useState<{
    left: number;
    threadId: string;
    top: number;
  } | null>(null);
  const [renameTarget, setRenameTarget] = useState<ThreadActionTarget | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ThreadActionTarget | null>(null);
  const [sidebarContent, setSidebarContent] = useState<SidebarContent>("documents");
  const [draggedThreadId, setDraggedThreadId] = useState<string | null>(null);
  /** The document whose group is being picked or made, in the group picker. */
  const [groupPickerFor, setGroupPickerFor] = useState<string | null>(null);
  const spaceActions = useContext(SpaceMenuContext);
  const groupPicker = useContext(ConversationGroupPickerContext);
  const [workspaceActionsOpen, setWorkspaceActionsOpen] = useState(false);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [collapsedCategories, setCollapsedCategories] = useState<ReadonlySet<string>>(() => new Set());
  const sortMenuRef = useRef<HTMLDivElement>(null);
  const sortTriggerRef = useRef<HTMLButtonElement>(null);
  const [newGroupName, setNewGroupName] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const workspaceActionsRef = useRef<HTMLDivElement>(null);
  const workspaceActionsTriggerRef = useRef<HTMLButtonElement>(null);
  const outlineTitleRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listScroll = useRef(0);

  function showSidebarContent(next: SidebarContent) {
    if (sidebarContent === "documents" && listRef.current) listScroll.current = listRef.current.scrollTop;
    setOpenMenuState(null);
    setSidebarContent(next);
  }

  // The Outline tab falls back to the list when Outline is switched off.
  useEffect(() => {
    if (sidebarContent === "outline" && !outlineEnabled) setSidebarContent("documents");
  }, [sidebarContent, outlineEnabled]);

  useLayoutEffect(() => {
    if (sidebarContent === "documents" && listRef.current) listRef.current.scrollTop = listScroll.current;
  }, [sidebarContent]);

  // The menu grows with its Spaces and Group sections: keep all of it on screen.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!openMenuState || !menu) return;
    const bottom = window.innerHeight - THREAD_MENU_VIEWPORT_MARGIN;
    const rect = menu.getBoundingClientRect();
    if (rect.bottom <= bottom) return;
    const top = Math.max(THREAD_MENU_VIEWPORT_MARGIN, bottom - rect.height);
    if (top !== openMenuState.top) setOpenMenuState((current) => current ? { ...current, top } : current);
  }, [openMenuState]);


  useEffect(() => {
    if (sidebarContent === "outline") outlineTitleRef.current?.focus();
  }, [sidebarContent]);

  function closeWorkspaceActions() {
    setWorkspaceActionsOpen(false);
    workspaceActionsTriggerRef.current?.focus();
  }

  useEffect(() => {
    if (!workspaceActionsOpen) return;

    workspaceActionsRef.current?.querySelector<HTMLButtonElement>("button")?.focus();

    function handleOutside(event: Event) {
      if (
        event.target instanceof Node &&
        !workspaceActionsRef.current?.contains(event.target) &&
        !workspaceActionsTriggerRef.current?.contains(event.target)
      ) {
        setWorkspaceActionsOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeWorkspaceActions();
      }
    }

    document.addEventListener("pointerdown", handleOutside, true);
    document.addEventListener("focusin", handleOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handleOutside, true);
      document.removeEventListener("focusin", handleOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [workspaceActionsOpen]);

  useEffect(() => {
    if (!sortMenuOpen) return;
    sortMenuRef.current?.querySelector<HTMLButtonElement>("[aria-checked='true']:not(:disabled), button:not(:disabled)")?.focus();
    const outside = (event: Event) => {
      if (event.target instanceof Node && !sortMenuRef.current?.contains(event.target) && !sortTriggerRef.current?.contains(event.target)) setSortMenuOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setSortMenuOpen(false);
      sortTriggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", key); };
  }, [sortMenuOpen]);

  useEffect(() => {
    if (!renameTarget) {
      return;
    }

    setRenameValue(renameTarget.title);
  }, [renameTarget]);

  const renameInputRef = useRef<HTMLInputElement>(null);
  const suggestedRenameTitle = useSuggestedDocumentTitle({ conversationId: renameTarget?.id ?? null, open: !!renameTarget,
    value: renameValue, setValue: setRenameValue, input: renameInputRef });

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

    function handleViewportChange(event: Event) {
      if (event.target instanceof Element && event.target.closest(".group-picker-dialog")) return;
      setOpenMenuState(null);
    }

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
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
    setWorkspaceActionsOpen(false);
    setSortMenuOpen(false);
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
  }, [deleteTarget, openMenuState, renameTarget, threads]);

  function handleOpenMenu(event: React.MouseEvent<HTMLButtonElement>, thread: ThreadSummary) {
    const triggerRect = event.currentTarget.getBoundingClientRect();
    const nextPosition = getThreadMenuPosition(triggerRect, revealInFolder?.canReveal(thread.id) ? THREAD_MENU_ITEM_HEIGHT : 0);

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

  function handleOpenOutline(threadId: string) {
    if (threadId !== activeThreadId) onSelectThread(threadId, { keepSidebarOpen: true });
    showSidebarContent("outline");
  }

  function handleThreadDragStart(
    event: React.DragEvent<HTMLElement>,
    threadId: string,
  ) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", threadId);
    // Lets a space's button in the header take the document.
    event.dataTransfer.setData("application/x-margin-document", threadId);
    setDraggedThreadId(threadId);
    setOpenMenuState(null);
    setWorkspaceActionsOpen(false);
  }

  function handleThreadDragEnd() {
    setDraggedThreadId(null);
  }

  const pinnedThreadIds = new Set(pinnedThreads.map((thread) => thread.id));
  const createdThreads = sortDocumentsByCreation(threads);
  // Thousands of documents render a page at a time, always including the open one.
  const listedThreads = documentOrder?.threads ?? createdThreads;
  const documentPages = useProgressiveList(listedThreads.length, { include: listedThreads.findIndex((thread) => thread.id === activeThreadId) });
  const orderedThreads = listedThreads;
  const sortLabel = SIDEBAR_DOCUMENT_SORTS.find((sort) => sort.id === documentSort)?.label ?? "Recently viewed";

  function renderDocumentList() {
    const categories = documentOrder?.categories;
    const dateSections: SidebarDateSection[] | null = categories ? null : documentOrder
      ? documentOrder.dateSections ?? null
      : groupByDate(createdThreads, (thread) => Date.parse(thread.createdAt ?? thread.updatedAt) || 0);
    if (dateSections) {
      // Headings page with the list: a section shows the documents within the first `shown`.
      let offset = 0;
      return <>
        {dateSections.map((section) => {
          const start = offset;
          offset += section.threads.length;
          if (start >= documentPages.shown) return null;
          return (
            <section aria-label={section.label} className="thread-sidebar-section is-date" key={section.id}>
              <h3 className="thread-date-heading">{section.label}</h3>
              {section.threads.slice(0, documentPages.shown - start).map(renderThreadItem)}
            </section>
          );
        })}
        {documentPages.more ? <div aria-hidden="true" className="thread-list-more" ref={documentPages.sentinel} /> : null}
      </>;
    }
    if (!categories) {
      return <>
        {listedThreads.slice(0, documentPages.shown).map(renderThreadItem)}
        {documentPages.more ? <div aria-hidden="true" className="thread-list-more" ref={documentPages.sentinel} /> : null}
      </>;
    }
    // Sections page together: a category shows the documents within the first `shown` of the whole list.
    let offset = 0;
    return <>
      {categories.map((category) => {
        const start = offset;
        offset += category.threads.length;
        if (start >= documentPages.shown) return null;
        const collapsedCategory = collapsedCategories.has(category.id) && !category.threads.some((thread) => thread.id === activeThreadId);
        return (
          <section aria-label={`${category.label} category`} className="thread-sidebar-section is-category" key={category.id}>
            <div className="thread-group-section-header">
              <button aria-expanded={!collapsedCategory} type="button" onClick={() => setCollapsedCategories((current) => {
                const next = new Set(current);
                if (next.has(category.id)) next.delete(category.id); else next.add(category.id);
                return next;
              })}>
                <span>{category.label}</span>
                <span className="thread-section-count">{category.threads.length}</span>
                <span aria-hidden="true">{collapsedCategory ? "＋" : "−"}</span>
              </button>
            </div>
            {collapsedCategory ? null : category.threads.slice(0, Math.max(0, documentPages.shown - start)).map(renderThreadItem)}
          </section>
        );
      })}
      {documentPages.more ? <div aria-hidden="true" className="thread-list-more" ref={documentPages.sentinel} /> : null}
    </>;
  }

  function renderSortControl() {
    if (!onDocumentSortChange || sidebarContent !== "documents") return null;
    const unavailable = documentOrder?.meaningUnavailable ?? null;
    return (
      <div className="sidebar-sort">
        <button ref={sortTriggerRef} type="button" className="sidebar-sort-trigger" aria-haspopup="menu" aria-expanded={sortMenuOpen}
          aria-controls={sortMenuOpen ? "sidebar-sort-menu" : undefined} aria-label={`Sort documents: ${sortLabel}`}
          title={`Sort: ${sortLabel}`} onClick={() => { setOpenMenuState(null); setSortMenuOpen((value) => !value); }}>
          <SortIcon />
        </button>
        {sortMenuOpen ? (
          <div ref={sortMenuRef} id="sidebar-sort-menu" className="sidebar-sort-menu" role="menu" aria-label="Sort documents">
            {SIDEBAR_DOCUMENT_SORTS.map((sort) => {
              const needsMeaning = sort.id === "semantic" || sort.id === "category";
              const disabled = needsMeaning && !!unavailable;
              return (
                <button key={sort.id} type="button" role="menuitemradio" aria-checked={documentSort === sort.id} disabled={disabled}
                  className="sidebar-sort-option" onClick={() => {
                    onDocumentSortChange(sort.id);
                    setSortMenuOpen(false);
                    sortTriggerRef.current?.focus();
                  }}>
                  <span className="sidebar-sort-check" aria-hidden="true">{documentSort === sort.id ? "✓" : ""}</span>
                  <span className="sidebar-sort-text">
                    <span>{sort.label}</span>
                    <small>{disabled ? unavailable : sort.hint}</small>
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    );
  }

  function renderThreadItem(thread: ThreadSummary) {
    const isExpanded = sidebarContent === "outline" && thread.id === activeThreadId;
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
            arrivingThreadIds?.has(thread.id) ? "is-arriving" : "",
            draggedThreadId === thread.id ? "is-dragging" : "",
          ]
            .filter(Boolean)
            .join(" ")
        }
        data-sidebar-document-id={thread.id}
        key={thread.id}
      >
        <span className="thread-item-drag-handle" title="Drag onto the space button to add it to the space you're in">
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
            {thread.fileKind ? <span className="thread-item-file-kind" title={{ pdf: "PDF", html: "HTML page", image: "Image" }[thread.fileKind]}>{{ pdf: "PDF", html: "HTML", image: "IMG" }[thread.fileKind]}</span> : null}
            <span>{thread.title}</span>
          </span>
          {isStreaming ? (
            <span className="thread-item-meta">
              <span className="thread-streaming-status" role="status" title="Response streaming">
                <span aria-hidden="true" className="thread-streaming-dot" />
                <span className="thread-streaming-label">Streaming</span>
              </span>
            </span>
          ) : null}
        </button>

        {outlineEnabled ? <button
          aria-controls={`chat-outline-${thread.id}`}
          aria-expanded={isExpanded}
          aria-label={`${isExpanded ? "Collapse" : "Expand"} outline for ${thread.title}`}
          className={
            isExpanded
              ? "thread-item-expand-trigger is-expanded"
              : "thread-item-expand-trigger"
          }
          onClick={() => handleOpenOutline(thread.id)}
          type="button"
        >
          <ExpandIcon />
        </button> : null}

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
  }

  return (
    <aside className={`thread-sidebar is-simplified${collapsed ? " is-collapsed" : ""}${mainViewMode === "graph" && mapExplorerActive ? " is-exploring-map" : ""}`}>
      {header}

      {mainViewMode === "graph" && !collapsed && onSelectSidebarSection ? <div className="map-sidebar-tabs" role="group" aria-label="Workspace browsing">
        <button type="button" aria-pressed={!mapExplorerActive} onClick={() => onSelectSidebarSection("chats")}>Documents</button>
        <button type="button" aria-pressed={mapExplorerActive} onClick={() => onSelectSidebarSection("explore")}>Explore</button>
      </div> : null}

      <div className="thread-sidebar-actions">
        <div className="sidebar-secondary-row">
          <button
            aria-label="Search documents"
            aria-keyshortcuts="Meta+K Control+K"
            className="sidebar-search-button"
            onClick={onOpenSearch}
            title="Search your vault (⌘K / Ctrl+K). Open or create a document by title: ⌘O / Ctrl+O"
            type="button"
          >
            <SearchIcon />
            <span>Search</span>
          </button>
          <button
            aria-label="New document"
            className="sidebar-new-button"
            onClick={onNewChat}
            title="New document"
            type="button"
          >
            <PlusIcon />
          </button>
          <button
            aria-controls={workspaceActionsOpen ? "sidebar-workspace-actions" : undefined}
            aria-expanded={workspaceActionsOpen}
            aria-haspopup="dialog"
            aria-label="More workspace actions"
            className="sidebar-more-button"
            onClick={() => {
              setOpenMenuState(null);
              setNewGroupName(null);
              setWorkspaceActionsOpen((current) => !current);
            }}
            ref={workspaceActionsTriggerRef}
            title={agentInboxCount ? `More actions. ${agentInboxCount} waiting in the agent inbox` : "More actions"}
            type="button"
          >
            <MoreIcon />
            {agentInboxCount ? <span className="sidebar-more-badge" aria-hidden="true">{agentInboxCount > 9 ? "9+" : agentInboxCount}</span> : null}
          </button>
          {workspaceActionsOpen ? (
            <div
              aria-label="More workspace actions"
              className="sidebar-workspace-actions"
              id="sidebar-workspace-actions"
              ref={workspaceActionsRef}
              role="dialog"
            >
              {onNewBoard ? (
                <button
                  className="sidebar-workspace-action"
                  onClick={() => { closeWorkspaceActions(); onNewBoard(); }}
                  title="A new board: one full-page canvas to draw and think on"
                  type="button"
                >
                  <BoardIcon />
                  <span>New board</span>
                </button>
              ) : null}
              {onOpenFlashcards ? (
                <button
                  className="sidebar-workspace-action"
                  onClick={() => { closeWorkspaceActions(); onOpenFlashcards(); }}
                  title="Study flashcards, or bring in an Anki deck"
                  type="button"
                >
                  <CardsIcon />
                  <span>Flashcards</span>
                </button>
              ) : null}
              {onOpenLanguages ? (
                <button
                  className="sidebar-workspace-action"
                  onClick={() => { closeWorkspaceActions(); onOpenLanguages(); }}
                  title="Courses, mini stories and lessons in the languages you're learning"
                  type="button"
                >
                  <LanguagesIcon />
                  <span>Languages</span>
                </button>
              ) : null}
              {!groupsEnabled ? null : newGroupName === null ? (
                <button
                  className="sidebar-workspace-action"
                  onClick={() => setNewGroupName("")}
                  type="button"
                >
                  <PlusIcon />
                  <span>New group</span>
                </button>
              ) : (
                <form
                  aria-label="Create a new group"
                  className="conversation-group-create-form is-compact"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!newGroupName.trim()) return;
                    onCreateGroup(newGroupName.trim());
                    closeWorkspaceActions();
                  }}
                >
                  <input
                    aria-label="Group name"
                    autoFocus
                    maxLength={48}
                    onChange={(event) => setNewGroupName(event.target.value)}
                    placeholder="Group name"
                    value={newGroupName}
                  />
                  <button disabled={!newGroupName.trim()} type="submit">Add</button>
                  <button
                    aria-label="Cancel creating group"
                    onClick={closeWorkspaceActions}
                    type="button"
                  >
                    ×
                  </button>
                </form>
              )}
              {onImportChatHistory ? <button type="button" className="sidebar-workspace-action" onClick={() => {
                closeWorkspaceActions(); onImportChatHistory();
              }}><span>Bring your chat history</span></button> : null}
              {onOpenAgentInbox ? <button type="button" className="sidebar-workspace-action" onClick={() => {
                closeWorkspaceActions(); onOpenAgentInbox();
              }}><span>Agent inbox{agentInboxCount ? ` (${agentInboxCount})` : ""}</span></button> : null}
              {onTakeTour ? <button type="button" className="sidebar-workspace-action" onClick={() => {
                closeWorkspaceActions(); onTakeTour();
              }}><span>Take the tour</span></button> : null}
              {onOpenHelp ? <button type="button" className="sidebar-workspace-action" aria-keyshortcuts="F1" onClick={() => {
                closeWorkspaceActions(); onOpenHelp();
              }}><span>Help and guides</span></button> : null}
              {onOpenInbox ? (
                <button
                  className="sidebar-workspace-action"
                  onClick={() => {
                    closeWorkspaceActions();
                    onOpenInbox();
                  }}
                  type="button"
                >
                  <svg aria-hidden="true" className="sidebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m4 5-2 10v5h20v-5L20 5H4Z"/><path d="M2 15h6l2 3h4l2-3h6M12 4v8m-3-3 3 3 3-3"/></svg>
                  <span>Cloud Inbox</span>
                </button>
              ) : null}
              {onMoreFeatures ? <button type="button" className="sidebar-workspace-action is-more-features" onClick={() => {
                closeWorkspaceActions(); onMoreFeatures();
              }}><span>More features…</span></button> : null}
            </div>
          ) : null}
        </div>
      </div>

      {mapExplorerRef ? <div ref={mapExplorerRef} className="map-sidebar-explorer" hidden={mainViewMode !== "graph" || !mapExplorerActive || collapsed} /> : null}
      {mainViewMode === "graph" && mapExplorerActive && !collapsed ? null : collapsed ? (
        <div className="thread-sidebar-mini-list">
          {orderedThreads.map((thread) => {
            const isPinned = pinnedThreadIds.has(thread.id);
            const isStreaming = streamingThreadIds.has(thread.id);

            return (
              <button
                key={thread.id}
                aria-label={`Open document ${thread.title}${isStreaming ? ", response streaming" : ""}`}
                className={
                  [
                    "thread-sidebar-mini-item",
                    thread.id === activeThreadId ? "is-active" : "",
                    isPinned ? "is-pinned" : "",
                    isStreaming ? "is-streaming" : "",
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
                  <DocumentIcon />
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
        <div className="sidebar-document-browser">
          <div className={`sidebar-content-switcher${outlineEnabled ? "" : " is-sort-only"}`} role="group" aria-label="Sidebar content">
            {/* With Outline off there is one list, so no tabs to switch between. Groups and Spaces are in Tile view. */}
            {outlineEnabled ? <button type="button" aria-label="Show documents" aria-pressed={sidebarContent === "documents"}
              aria-controls="sidebar-document-list" onClick={() => showSidebarContent("documents")}>Documents</button> : null}
            {outlineEnabled ? <button type="button" aria-label="Show document outline" aria-pressed={sidebarContent === "outline"}
              aria-controls={`chat-outline-${activeThreadId}`} onClick={() => handleOpenOutline(activeThreadId)}>Outline</button> : null}
            {renderSortControl()}
          </div>
          {fetchIndicator}
          <div className="thread-list" ref={listRef} id="sidebar-document-list" hidden={sidebarContent === "outline"}>
            {documentOrder?.meaningLoading ? <p className="sidebar-sort-status" aria-live="polite">Sorting by meaning…</p>
              : documentOrder?.note ? <p className="sidebar-sort-status">{documentOrder.note}</p> : null}
            {renderDocumentList()}
            {cloudIndex}
          </div>
          <nav aria-label={`Outline for ${currentChatTitle}`} className="chat-outline is-expanded-panel"
            id={`chat-outline-${activeThreadId}`} hidden={sidebarContent !== "outline"}>
            <h2 className="sidebar-outline-title" ref={outlineTitleRef} tabIndex={-1} title={currentChatTitle}>
              <DocumentIcon /><span>{currentChatTitle || "Untitled document"}</span>
            </h2>
            <ChatOutline key={activeThreadId} items={currentChatOutline} activeItemId={activeOutlineItemId} onSelect={onSelectOutlineItem}
              conversationId={activeThreadId} onNavigated={onOutlineNavigated} />
          </nav>
        </div>
      )}

      <div className={`thread-sidebar-footer${vaultSwitcher ? " has-vault-switcher" : ""}`}>
        {vaultSwitcher}
        {flashcardsDue !== null && onOpenFlashcards ? (
          <button
            aria-label={flashcardsDue ? `Review flashcards, ${flashcardsDue} to study` : "Review flashcards"}
            className="sidebar-utility-button sidebar-review-button"
            onClick={onOpenFlashcards}
            title={flashcardsDue ? `${flashcardsDue} card${flashcardsDue === 1 ? "" : "s"} to study` : "Review flashcards: nothing due"}
            type="button"
          >
            <CardsIcon />
            {flashcardsDue ? <span className="sidebar-review-count">{flashcardsDue > 99 ? "99+" : flashcardsDue}</span> : null}
          </button>
        ) : null}
        <button
          aria-label="Open profile"
          className="sidebar-utility-button"
          onClick={onOpenProfile}
          title="Profile and settings"
          type="button"
        >
          <ProfileIcon />
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

      {/* The menu and dialogs render at the page level: inside the sidebar's layer, the Map or a
          roadmap beside it would cover them. */}
      {openMenuState ? createPortal(
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
                {revealInFolder?.canReveal(thread.id) ? (
                  <button
                    className="thread-item-menu-action"
                    onClick={() => {
                      revealInFolder.onReveal(thread.id);
                      setOpenMenuState(null);
                    }}
                    role="menuitem"
                    title="Show this document's file in your vault folder."
                    type="button"
                  >
                    {revealInFolder.label}
                  </button>
                ) : null}
                {spaceActions ? <div className="thread-item-menu-section" role="group" aria-label={`Spaces for ${thread.title}`}>
                  <span className="thread-item-menu-heading" title="A space is a workspace you're actively in: its documents open as tabs when you switch to it.">Spaces</span>
                  {spaceActions.spaces.map((space) => {
                    const inSpace = spaceActions.isIn(space.id, thread.id);
                    return <button key={space.id} type="button" role="menuitemcheckbox" aria-checked={inSpace}
                      className="thread-item-menu-action thread-item-menu-choice" onClick={() => spaceActions.onToggle(space.id, thread.id)}>
                      <span className="thread-item-menu-swatch" style={{ background: space.color }} aria-hidden="true" />
                      <span className="thread-item-menu-choice-name">{space.name}</span>
                      <span className="thread-item-menu-check" aria-hidden="true">{inSpace ? "✓" : ""}</span>
                    </button>;
                  })}
                  <button type="button" role="menuitem" className="thread-item-menu-action thread-item-menu-choice is-new"
                    onClick={() => { setOpenMenuState(null); spaceActions.onCreateWith(thread.id); }}>
                    <span aria-hidden="true" className="thread-item-menu-plus">＋</span><span>New space with this</span>
                  </button>
                </div> : null}
                {groupsEnabled ? (() => {
                  const groupId = getConversationGroupId(groups, thread.id);
                  const choices = [{ id: null as string | null, name: "No group", color: "" }, ...Object.values(groups).map((group) => ({ id: group.id as string | null, name: group.name, color: group.color }))];
                  return <div className="thread-item-menu-section" role="group" aria-label={`Group for ${thread.title}`}>
                    <span className="thread-item-menu-heading" title="A group is a label, like a tag. Each document sits in one group.">Group</span>
                    {choices.map((choice) => <button key={choice.id ?? "none"} type="button" role="menuitemradio" aria-checked={groupId === choice.id}
                      className="thread-item-menu-action thread-item-menu-choice" onClick={() => { onAssignGroup(thread.id, choice.id); setOpenMenuState(null); }}>
                      <span className={`thread-item-menu-swatch is-group${choice.id ? "" : " is-none"}`} style={choice.color ? { background: choice.color } : undefined} aria-hidden="true" />
                      <span className="thread-item-menu-choice-name">{choice.name}</span>
                      <span className="thread-item-menu-check" aria-hidden="true">{groupId === choice.id ? "✓" : ""}</span>
                    </button>)}
                    <button type="button" role="menuitem" className="thread-item-menu-action thread-item-menu-choice is-new"
                      aria-haspopup="dialog" onClick={() => { setOpenMenuState(null); setGroupPickerFor(thread.id); }}>
                      <span aria-hidden="true" className="thread-item-menu-plus">＋</span><span>New group…</span>
                    </button>
                  </div>;
                })() : null}
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
      , document.body) : null}

      {groupPickerFor ? <GroupPickerModal isOpen groups={groups} currentGroupId={getConversationGroupId(groups, groupPickerFor)}
        suggestion={groupPicker.getSuggestion?.(groupPickerFor) ?? null} isSuggesting={groupPicker.isSuggesting} status={groupPicker.status}
        onSelect={(groupId) => onAssignGroup(groupPickerFor, groupId)}
        onCreate={groupPicker.onCreateAndAssign ? (name) => groupPicker.onCreateAndAssign?.(groupPickerFor, name) : undefined}
        onClose={() => setGroupPickerFor(null)} /> : null}

      {renameTarget ? createPortal(
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
                  <p className="eyebrow">Document settings</p>
                  <h2 id="thread-rename-title">Rename document</h2>
                </div>
              </div>

              <label className="thread-dialog-field">
                <span className="thread-dialog-label">Document title</span>
                <input
                  aria-describedby={suggestedRenameTitle ? "thread-rename-hint" : undefined}
                  autoFocus
                  className="thread-dialog-input"
                  maxLength={120}
                  onChange={(event) => setRenameValue(event.target.value)}
                  placeholder="Enter a new document title"
                  ref={renameInputRef}
                  type="text"
                  value={renameValue}
                />
              </label>
              {suggestedRenameTitle ? (
                <p className="thread-dialog-hint" id="thread-rename-hint">
                  Suggested from the document. Type to replace it.
                </p>
              ) : null}

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
      , document.body) : null}

      {deleteTarget ? createPortal(
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
                <p className="eyebrow">Document settings</p>
                <h2 id="thread-delete-title">Delete document?</h2>
              </div>
            </div>

            <p className="thread-dialog-copy">
              This will delete <strong>{deleteTarget.title}</strong> and every branch
              inside this document.
            </p>

            <p className="thread-dialog-warning">
              You can cancel to keep the document, or confirm to remove it entirely.
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
      , document.body) : null}
    </aside>
  );
}
