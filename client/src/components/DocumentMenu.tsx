import { useContext, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Conversation, ConversationGroup } from "../types";
import { getConversationGroupId } from "../lib/conversationGroups";
import { useOutsideDismiss } from "../lib/useOutsideDismiss";
import { useSuggestedDocumentTitle } from "../lib/documentTitleSuggestion";
import { ConversationGroupPickerContext } from "./ConversationGroupControls";
import GroupPickerModal from "./GroupPickerModal";
import { SpaceMenuContext } from "./Spaces";
import "./DocumentMenu.css";

export interface DocumentMenuProps {
  conversation: Conversation;
  pinned?: boolean;
  familyPinned?: boolean;
  minimized?: boolean;
  /** Not open in the workspace; Open replaces Restore. */
  closed?: boolean;
  onTogglePin?: (id: string) => void;
  onTogglePinScope?: (id: string) => void;
  onMinimize?: (id: string) => void;
  onClose?: (id: string) => void;
  onRestore?: (id: string) => void;
  onNewMarginNote?: (id: string) => void;
  /** Opens the Ask about this note chat beside the document. */
  onAskAboutNote?: (id: string) => void;
  /** Turns a margin note into a side document of its own. */
  onMoveToSideDocument?: (id: string) => void;
  onMoveToMargin?: (id: string) => void;
  /** Keep this document out of every AI request and connected app, or let AI read it again. */
  onToggleHiddenFromAI?: (id: string) => void;
  /**
   * What connected apps may edit here (spec §3): null for only lines you didn't
   * write, "locked" for nothing (they can still add to the end), "open" for any
   * line. Only settable here, never by an app.
   */
  onSetAgentEdit?: (id: string, policy: "locked" | "open" | null) => void;
  /** Draw this document as a roadmap of stages and steps, or as a plain document again. */
  onToggleRoadmap?: (id: string) => void;
  /** Cards written in this document and its notes; the menu offers a review when there are any. */
  flashcardCount?: number;
  onReviewFlashcards?: (id: string) => void;
  /** Have the AI suggest flashcards from this document. */
  onMakeFlashcards?: (id: string) => void;
  /** Open the claims view, where the document's claims are checked against the vault (Ratchet). */
  onCheckClaims?: (id: string) => void;
  maximized?: boolean;
  onToggleMaximize?: (id: string) => void;
  onRename?: (id: string, title: string) => void;
  /** Desktop app with its own vault folder: show this document's file in Finder or Explorer. */
  onRevealInFolder?: (id: string) => void;
  /** Opens Version history: earlier versions of this document to compare and restore. */
  onVersionHistory?: (id: string) => void;
  /** What that's called here: Finder, Explorer or Files. */
  fileManager?: string;
  groups?: Record<string, ConversationGroup>;
  onAssignGroup?: (conversationId: string, groupId: string | null) => void;
  className?: string;
  onFocusFallback?: () => void;
}

const AGENT_EDIT_OPTIONS: Array<{ policy: "locked" | "open" | null; label: string; short: string; title: string }> = [
  { policy: null, label: "Only what I didn't write", short: "Not my lines", title: "Apps may change lines an AI, an app or an import wrote, never yours." },
  { policy: "locked", label: "Locked", short: "Locked", title: "Apps may only add to the end of this document." },
  { policy: "open", label: "Open", short: "Open", title: "Apps may change any line here, including yours." },
];

/** The same document actions are available from its tab and its reading pane. */
export default function DocumentMenu({ conversation, pinned = false, familyPinned = false, minimized = false, closed = false,
  onTogglePin, onTogglePinScope, onMinimize, onClose, onRestore, onNewMarginNote, onAskAboutNote, onMoveToSideDocument, onMoveToMargin, onToggleHiddenFromAI, onSetAgentEdit, onToggleRoadmap, flashcardCount = 0, onReviewFlashcards, onMakeFlashcards, onCheckClaims, maximized = false, onToggleMaximize, onRename, onRevealInFolder, onVersionHistory, fileManager = "Finder", groups = {}, onAssignGroup, className = "", onFocusFallback }: DocumentMenuProps) {
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  const [agentEditOpen, setAgentEditOpen] = useState(false);
  const [spacesOpen, setSpacesOpen] = useState(false);
  const spaceActions = useContext(SpaceMenuContext);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameTitle, setRenameTitle] = useState("");
  const renameDialog = useRef<HTMLFormElement>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const renameInputId = useId();
  const renameHintId = useId();
  const suggestedTitle = useSuggestedDocumentTitle({ conversationId: conversation.id, open: renameOpen && !!onRename,
    value: renameTitle, setValue: setRenameTitle, input: renameInput });
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const returnedFocus = useRef(false);
  const focusFallback = useRef(onFocusFallback);
  focusFallback.current = onFocusFallback;
  const groupPicker = useContext(ConversationGroupPickerContext);
  const title = conversation.title || "Untitled document";
  const groupId = getConversationGroupId(groups, conversation.id);
  const groupName = groupId ? groups[groupId].name : "Ungrouped";

  function close(restoreFocus = false) {
    returnedFocus.current = restoreFocus;
    if (restoreFocus) trigger.current?.focus();
    setOpen(false);
  }

  useEffect(() => {
    const element = trigger.current;
    return () => {
      // Pin visibility and minimize actions can remove the originating pane.
      // Run after React has attached the remaining controls for the new layout.
      if (returnedFocus.current) queueMicrotask(() => {
        if (!element?.isConnected) focusFallback.current?.();
      });
    };
  }, []);

  useEffect(() => { if (!open) { returnedFocus.current = false; setAgentEditOpen(false); setSpacesOpen(false); } }, [open]);
  useOutsideDismiss(open, () => close(), menu, trigger);

  useEffect(() => {
    if (!open) return;
    function positionMenu() {
      const bounds = trigger.current?.getBoundingClientRect();
      if (!bounds) return;
      const height = menu.current?.offsetHeight || 48;
      const width = menu.current?.offsetWidth || 224;
      setPosition({
        left: Math.max(8, Math.min(bounds.right - width, window.innerWidth - width - 8)),
        top: bounds.bottom + height + 8 <= window.innerHeight ? bounds.bottom + 6 : Math.max(8, bounds.top - height - 6),
      });
    }
    function escape(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close(true);
    }
    positionMenu();
    menu.current?.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')?.focus();
    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", positionMenu, true);
    document.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("scroll", positionMenu, true);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  useEffect(() => {
    if (!renameOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    renameInput.current?.focus();
    renameInput.current?.select();
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        setRenameOpen(false);
      } else if (event.key === "Tab") {
        const controls = [...(renameDialog.current?.querySelectorAll<HTMLElement>('input, button:not(:disabled)') ?? [])];
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    }
    function keepFocusInside(event: FocusEvent) {
      if (event.target instanceof Node && !renameDialog.current?.contains(event.target)) renameInput.current?.focus();
    }
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("focusin", keepFocusInside);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("focusin", keepFocusInside);
      document.body.style.overflow = previousOverflow;
      if (trigger.current?.isConnected) trigger.current.focus();
      else focusFallback.current?.();
    };
  }, [renameOpen]);

  function action(callback: ((id: string) => void) | undefined) {
    close(true);
    callback?.(conversation.id);
  }

  function rename() {
    const nextTitle = renameTitle.trim();
    if (!nextTitle) return;
    onRename?.(conversation.id, nextTitle);
    setRenameOpen(false);
  }

  return <>
    <button ref={trigger} type="button" className={`document-menu-trigger ${className}`.trim()} draggable={false}
      aria-label={`Options for ${title}`} title={`Options for ${title}`} aria-haspopup="menu" aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      onClick={(event) => { event.stopPropagation(); if (open) close(true); else setOpen(true); }}>
      <svg viewBox="0 0 20 20" aria-hidden="true" fill="currentColor"><circle cx="10" cy="4" r="1.6"/><circle cx="10" cy="10" r="1.6"/><circle cx="10" cy="16" r="1.6"/></svg>
    </button>
    {open ? createPortal(<div ref={menu} id={menuId} role="menu" className="document-menu"
      aria-label={`Options for ${title}`} style={{ left: position.left, top: position.top }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') ?? [])];
          const currentIndex = Math.max(0, items.findIndex((item) => item === document.activeElement));
          const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
            : (currentIndex + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
          items[nextIndex]?.focus();
        }
        if (event.key === "Tab") close(true);
      }}>
      {/* About the document, then making from it, then what AI may read, then its pane on screen. */}
      {onTogglePin || onRename || onAssignGroup || onRevealInFolder || onVersionHistory ? <div role="group" className="document-menu-section">
        {onTogglePin ? <button type="button" role="menuitem" onClick={() => action(onTogglePin)}>
          {pinned ? "Unpin document" : "Pin document"}
        </button> : null}
        {pinned ? <button type="button" role="menuitemcheckbox" aria-checked={!familyPinned} disabled={!onTogglePinScope}
          title="When off, show this pane only with this main document and its side documents."
          onClick={() => action(onTogglePinScope)}>
          <span>Keep visible across documents</span>
          <span className="document-menu-check" aria-hidden="true">{familyPinned ? "" : "✓"}</span>
        </button> : null}
        {onRename ? <button type="button" role="menuitem" aria-haspopup="dialog" onClick={() => {
          close(true); setRenameTitle(conversation.title); setRenameOpen(true);
        }}>Rename document</button> : null}
        {onAssignGroup ? <button type="button" role="menuitem" className="document-menu-group-setting"
          aria-label={`Group for ${title}: ${groupName}`} aria-haspopup="dialog"
          onClick={() => { close(true); setGroupOpen(true); }}>
          <span>Group</span><span className="document-menu-group-name" title={groupName}>{groupName}</span><span aria-hidden="true">›</span>
        </button> : null}
        {onRevealInFolder ? <button type="button" role="menuitem" title="Show this document's file in your vault folder."
          onClick={() => action(onRevealInFolder)}>{`Show in ${fileManager}`}</button> : null}
        {onVersionHistory ? <button type="button" role="menuitem" title="See earlier versions of this document and restore one."
          onClick={() => action(onVersionHistory)}>Version history</button> : null}
      </div> : null}
      {spaceActions ? <div role="group" className="document-menu-section">
        <button type="button" role="menuitem" className="document-menu-group-setting" aria-expanded={spacesOpen}
          title="Keep this document, with its side documents and notes, in a space you can come back to."
          onClick={() => setSpacesOpen((value) => !value)}>
          <span>Add to space</span>
          <span className="document-menu-group-name">{spaceActions.spaces.filter((space) => spaceActions.isIn(space.id, conversation.id)).map((space) => space.name).join(", ")}</span>
          <span aria-hidden="true">{spacesOpen ? "⌄" : "›"}</span>
        </button>
        {spacesOpen ? <div role="group" aria-label="Spaces" className="document-menu-choices">
          {spaceActions.spaces.map((space) => <button key={space.id} type="button" role="menuitemcheckbox"
            aria-checked={spaceActions.isIn(space.id, conversation.id)} onClick={() => { close(true); spaceActions.onToggle(space.id, conversation.id); }}>
            <span className="document-menu-space"><span className="document-menu-space-dot" style={{ background: space.color }} aria-hidden="true" />{space.name}</span>
            <span className="document-menu-check" aria-hidden="true">{spaceActions.isIn(space.id, conversation.id) ? "✓" : ""}</span>
          </button>)}
          <button type="button" role="menuitem" onClick={() => { close(true); spaceActions.onCreateWith(conversation.id); }}>New space with this</button>
        </div> : null}
      </div> : null}
      {onNewMarginNote || onAskAboutNote || onMoveToSideDocument || onMoveToMargin ? <div role="group" className="document-menu-section">
        {onNewMarginNote ? <button type="button" role="menuitem" onClick={() => action(onNewMarginNote)}>New margin note</button> : null}
        {onAskAboutNote ? <button type="button" role="menuitem" onClick={() => action(onAskAboutNote)}>Ask about this note</button> : null}
        {onMoveToSideDocument ? <button type="button" role="menuitem" title="Open this note as its own document beside the one it's on. It keeps its text and its link to the passage."
          onClick={() => action(onMoveToSideDocument)}>Move to side document</button> : null}
        {onMoveToMargin ? <button type="button" role="menuitem" title="Put this document back in the margin of the one it came from, beside its passage. It keeps its text."
          onClick={() => action(onMoveToMargin)}>Move to margin</button> : null}
      </div> : null}
      {onToggleHiddenFromAI || onToggleRoadmap || onSetAgentEdit || onMakeFlashcards || onCheckClaims ? <div role="group" className="document-menu-section">
        {onCheckClaims ? <button type="button" role="menuitem" title="Find the claims this document makes and check each against your other notes."
          onClick={() => action(onCheckClaims)}>Check claims…</button> : null}
        {onMakeFlashcards ? <button type="button" role="menuitem" title="The AI suggests flashcards from this document; you choose which to add."
          onClick={() => action(onMakeFlashcards)}>Make flashcards…</button> : null}
        {onReviewFlashcards && flashcardCount > 0 ? <button type="button" role="menuitem"
          title="Study the flashcards written in this document and its notes."
          onClick={() => action(onReviewFlashcards)}>
          <span>Review cards</span>
          <span className="document-menu-group-name">{flashcardCount}</span>
        </button> : null}
        {onToggleRoadmap ? <button type="button" role="menuitemcheckbox" aria-checked={conversation.nodeType === "roadmap"}
          title="Lay out steps from your documents in stages, and track what you've learned."
          onClick={() => action(onToggleRoadmap)}>
          <span>Roadmap</span>
          <span className="document-menu-check" aria-hidden="true">{conversation.nodeType === "roadmap" ? "✓" : ""}</span>
        </button> : null}
        {onToggleHiddenFromAI ? <button type="button" role="menuitemcheckbox" aria-checked={conversation.hiddenFromAI === true}
          title="AI and connected apps can't read a hidden document, even when you search your whole workspace."
          onClick={() => action(onToggleHiddenFromAI)}>
          <span>Hide from AI</span>
          <span className="document-menu-check" aria-hidden="true">{conversation.hiddenFromAI ? "✓" : ""}</span>
        </button> : null}
        {onSetAgentEdit ? <>
          <button type="button" role="menuitem" className="document-menu-group-setting" aria-expanded={agentEditOpen}
            aria-label={`Agent editing: ${AGENT_EDIT_OPTIONS.find((option) => option.policy === (conversation.agentEdit ?? null))!.label}`}
            title="What connected apps, such as Claude or ChatGPT, may change in this document."
            onClick={() => setAgentEditOpen((value) => !value)}>
            <span>Agent editing</span>
            <span className="document-menu-group-name">{AGENT_EDIT_OPTIONS.find((option) => option.policy === (conversation.agentEdit ?? null))!.short}</span>
            <span aria-hidden="true">{agentEditOpen ? "⌄" : "›"}</span>
          </button>
          {agentEditOpen ? <div role="group" aria-label="Agent editing" className="document-menu-choices">
            {AGENT_EDIT_OPTIONS.map((option) => <button key={option.short} type="button" role="menuitemradio"
              aria-checked={(conversation.agentEdit ?? null) === option.policy} title={option.title}
              onClick={() => { close(true); onSetAgentEdit(conversation.id, option.policy); }}>
              <span>{option.label}</span>
              <span className="document-menu-check" aria-hidden="true">{(conversation.agentEdit ?? null) === option.policy ? "✓" : ""}</span>
            </button>)}
          </div> : null}
        </> : null}
      </div> : null}
      {onToggleMaximize || onMinimize || onRestore || onClose ? <div role="group" className="document-menu-section">
        {onToggleMaximize ? <button type="button" role="menuitem" onClick={() => action(onToggleMaximize)}>
          {maximized ? "Restore document size" : "Maximize document"}
        </button> : null}
        {!minimized && onMinimize
          ? <button type="button" role="menuitem" onClick={() => action(onMinimize)}>Minimize document</button> : null}
        {minimized && onRestore ? <button type="button" role="menuitem" onClick={() => action(onRestore)}>Restore document</button> : null}
        {closed && onRestore ? <button type="button" role="menuitem" onClick={() => action(onRestore)}>Open document</button> : null}
        {onClose ? <button type="button" role="menuitem" onClick={() => action(onClose)}>Close document</button> : null}
      </div> : null}
    </div>, document.body) : null}
    {renameOpen && onRename ? createPortal(<div className="document-rename-backdrop"
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onClick={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) setRenameOpen(false); }}>
      <form ref={renameDialog} className="document-rename-dialog" role="dialog" aria-modal="true" aria-label="Rename document"
        onSubmit={(event) => { event.preventDefault(); rename(); }}>
        <h2>Rename document</h2>
        <label htmlFor={renameInputId}>Document name</label>
        <input ref={renameInput} id={renameInputId} aria-label="Document name" value={renameTitle} autoComplete="off"
          aria-describedby={suggestedTitle ? renameHintId : undefined}
          onChange={(event) => setRenameTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); rename(); }
          }} />
        {suggestedTitle ? <p id={renameHintId} className="document-rename-hint">Suggested from the document. Type to replace it.</p> : null}
        <div className="document-rename-actions">
          <button type="button" onClick={() => setRenameOpen(false)}>Cancel</button>
          <button type="submit" disabled={!renameTitle.trim()}>Save</button>
        </div>
      </form>
    </div>, document.body) : null}
    {groupOpen && onAssignGroup ? <GroupPickerModal isOpen groups={groups} currentGroupId={groupId}
      suggestion={groupPicker.getSuggestion?.(conversation.id)} isSuggesting={groupPicker.isSuggesting} status={groupPicker.status}
      onSelect={(id) => onAssignGroup(conversation.id, id)}
      onCreate={groupPicker.onCreateAndAssign ? (name) => groupPicker.onCreateAndAssign?.(conversation.id, name) : undefined}
      onClose={() => setGroupOpen(false)} /> : null}
  </>;
}
