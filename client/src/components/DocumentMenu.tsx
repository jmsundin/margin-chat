import { useContext, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Conversation, ConversationGroup } from "../types";
import { getConversationGroupId } from "../lib/conversationGroups";
import { useOutsideDismiss } from "../lib/useOutsideDismiss";
import { ConversationGroupPickerContext } from "./ConversationGroupControls";
import GroupPickerModal from "./GroupPickerModal";
import "./DocumentMenu.css";

export interface DocumentMenuProps {
  conversation: Conversation;
  pinned?: boolean;
  familyPinned?: boolean;
  minimized?: boolean;
  onTogglePin?: (id: string) => void;
  onTogglePinScope?: (id: string) => void;
  onMinimize?: (id: string) => void;
  onClose?: (id: string) => void;
  onRestore?: (id: string) => void;
  onNewMarginNote?: (id: string) => void;
  onRename?: (id: string, title: string) => void;
  groups?: Record<string, ConversationGroup>;
  onAssignGroup?: (conversationId: string, groupId: string | null) => void;
  className?: string;
  onFocusFallback?: () => void;
}

/** The same document actions are available from its tab and its reading pane. */
export default function DocumentMenu({ conversation, pinned = false, familyPinned = false, minimized = false,
  onTogglePin, onTogglePinScope, onMinimize, onClose, onRestore, onNewMarginNote, onRename, groups = {}, onAssignGroup, className = "", onFocusFallback }: DocumentMenuProps) {
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameTitle, setRenameTitle] = useState("");
  const renameDialog = useRef<HTMLFormElement>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const renameInputId = useId();
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

  useEffect(() => { if (!open) returnedFocus.current = false; }, [open]);
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
      {onTogglePin ? <button type="button" role="menuitem" onClick={() => action(onTogglePin)}>
        {pinned ? "Unpin document" : "Pin document"}
      </button> : null}
      {onRename ? <button type="button" role="menuitem" aria-haspopup="dialog" onClick={() => {
        close(true); setRenameTitle(conversation.title); setRenameOpen(true);
      }}>Rename document</button> : null}
      {onNewMarginNote ? <button type="button" role="menuitem" onClick={() => action(onNewMarginNote)}>New margin note</button> : null}
      {pinned ? <button type="button" role="menuitemcheckbox" aria-checked={!familyPinned} disabled={!onTogglePinScope}
        title="When off, show this pane only with this main document and its side documents."
        onClick={() => action(onTogglePinScope)}>
        <span className="document-menu-check" aria-hidden="true">{familyPinned ? "" : "✓"}</span>
        <span>Keep visible across documents</span>
      </button> : null}
      {!minimized && onMinimize
        ? <button type="button" role="menuitem" onClick={() => action(onMinimize)}>Minimize document</button> : null}
      {minimized && onRestore ? <button type="button" role="menuitem" onClick={() => action(onRestore)}>Restore document</button> : null}
      {onClose ? <button type="button" role="menuitem" aria-label="Close document" onClick={() => action(onClose)}><span aria-hidden="true">×</span> Close document</button> : null}
      {onAssignGroup ? <button type="button" role="menuitem" className="document-menu-group-setting"
        aria-label={`Group for ${title}: ${groupName}`} aria-haspopup="dialog"
        onClick={() => { close(true); setGroupOpen(true); }}>
        <span>Group</span><span className="document-menu-group-name" title={groupName}>{groupName}</span><span aria-hidden="true">›</span>
      </button> : null}
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
          onChange={(event) => setRenameTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); rename(); }
          }} />
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
