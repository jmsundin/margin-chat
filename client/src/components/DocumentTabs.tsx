import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { Conversation, ConversationGroup } from "../types";
import DocumentMenu from "./DocumentMenu";
import "./DocumentTabs.css";

export interface DocumentTabsProps {
  documents: Conversation[];
  activeDocumentId: string;
  minimizedDocumentIds: string[];
  onSelect: (id: string) => void;
  onMinimize: (id: string) => void;
  onReorder: (draggedId: string, targetId: string) => void;
  canReorder?: (draggedId: string, targetId: string) => boolean;
  onNewSideDocument: () => void;
  pinnedDocumentIds?: string[];
  onTogglePin?: (id: string) => void;
  familyPinnedDocumentIds?: string[];
  onTogglePinScope?: (id: string) => void;
  groups?: Record<string, ConversationGroup>;
  onAssignGroup?: (conversationId: string, groupId: string | null) => void;
}

export default function DocumentTabs({ documents, activeDocumentId, minimizedDocumentIds, onSelect, onMinimize, onReorder, canReorder = () => true, onNewSideDocument, pinnedDocumentIds = [], onTogglePin, familyPinnedDocumentIds = [], onTogglePinScope, groups = {}, onAssignGroup }: DocumentTabsProps) {
  const instructionsId = useId();
  const tabs = useRef(new Map<string, HTMLButtonElement>());
  const tablist = useRef<HTMLDivElement>(null);
  const draggedId = useRef<string | null>(null);
  const pointerDrag = useRef<{ cancel: () => void } | null>(null);
  const suppressPointerClick = useRef(false);
  const [focusedId, setFocusedId] = useState(activeDocumentId);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const activeDocumentRef = useRef(activeDocumentId);
  activeDocumentRef.current = activeDocumentId;
  const tabStopId = documents.some((document) => document.id === focusedId)
    ? focusedId : documents.find((document) => document.id === activeDocumentId)?.id ?? documents[0]?.id;

  useEffect(() => {
    setFocusedId(activeDocumentId);
    tabs.current.get(activeDocumentId)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeDocumentId]);

  useEffect(() => () => pointerDrag.current?.cancel(), []);

  function reorder(id: string, targetId: string) {
    if (id === targetId || !canReorder(id, targetId)) return;
    const document = documents.find((item) => item.id === id);
    const targetIndex = documents.findIndex((item) => item.id === targetId);
    if (!document || targetIndex < 0) return;
    onReorder(id, targetId);
    setAnnouncement(`${document.title || "Untitled document"} moved to position ${targetIndex + 1} of ${documents.length}.`);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, id: string) {
    suppressPointerClick.current = false;
    const index = documents.findIndex((document) => document.id === id);
    const direction = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (event.altKey && direction) {
      event.preventDefault();
      const target = documents[index + direction];
      if (target) reorder(id, target.id);
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? documents.length - 1
      : direction ? (index + direction + documents.length) % documents.length : -1;
    if (nextIndex < 0) return;
    event.preventDefault();
    tabs.current.get(documents[nextIndex].id)?.focus();
  }

  function endDrag() {
    draggedId.current = null;
    setDraggingId(null);
    setDropTargetId(null);
  }

  function startPointerDrag(event: ReactPointerEvent<HTMLDivElement>, id: string) {
    suppressPointerClick.current = false;
    if (event.button !== 0 || event.isPrimary === false || pointerDrag.current
      || !event.currentTarget.contains(event.target as Node)
      || (event.target as Element).closest(".document-menu-trigger")) return;
    const element = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    let moved = false;

    function targetAt(clientX: number, clientY: number) {
      const strip = tablist.current;
      if (!strip) return null;
      const bounds = strip.getBoundingClientRect();
      if (clientY < bounds.top - 40 || clientY > bounds.bottom + 40) return null;
      let closest: { id: string; distance: number } | null = null;
      for (const document of documents) {
        const bounds = tabs.current.get(document.id)?.parentElement?.getBoundingClientRect();
        if (!bounds) continue;
        const distance = Math.abs(clientX - (bounds.left + bounds.width / 2));
        if (!closest || distance < closest.distance) closest = { id: document.id, distance };
      }
      return closest?.id ?? null;
    }

    function move(pointer: PointerEvent) {
      if (pointer.pointerId !== pointerId) return;
      if (!moved && Math.hypot(pointer.clientX - startX, pointer.clientY - startY) < 6) return;
      if (!moved) {
        moved = true;
        suppressPointerClick.current = true;
        setDraggingId(id);
        // Window listeners also cover browsers and synthetic gestures without capture support.
        try { element.setPointerCapture?.(pointerId); } catch { /* The pointer may already have ended. */ }
      }
      pointer.preventDefault();
      const strip = tablist.current;
      if (strip) {
        const bounds = strip.getBoundingClientRect();
        if (pointer.clientY >= bounds.top - 40 && pointer.clientY <= bounds.bottom + 40) {
          const direction = pointer.clientX < bounds.left + 28 ? -1 : pointer.clientX > bounds.right - 28 ? 1 : 0;
          if (direction) strip.scrollLeft = Math.max(0, Math.min(strip.scrollLeft + direction * 24, strip.scrollWidth - strip.clientWidth));
        }
      }
      const targetId = targetAt(pointer.clientX, pointer.clientY);
      setDropTargetId(targetId === id || (targetId && !canReorder(id, targetId)) ? null : targetId);
    }

    function finish(pointer?: PointerEvent) {
      if (pointer && pointer.pointerId !== pointerId) return;
      const targetId = pointer && moved ? targetAt(pointer.clientX, pointer.clientY) : null;
      cleanup();
      if (moved) {
        pointer?.preventDefault();
        suppressPointerClick.current = true;
        if (targetId) reorder(id, targetId);
      }
      endDrag();
    }
    function cancel(pointer?: PointerEvent) {
      if (pointer && pointer.pointerId !== pointerId) return;
      finish();
    }
    function blur() { finish(); }
    function escape(key: globalThis.KeyboardEvent) { if (key.key === "Escape") { key.preventDefault(); finish(); } }
    function cleanup() {
      pointerDrag.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", blur);
      window.removeEventListener("keydown", escape);
      element.removeEventListener("lostpointercapture", cancel);
      if (element.hasPointerCapture?.(pointerId)) element.releasePointerCapture(pointerId);
    }
    pointerDrag.current = { cancel: () => finish() };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", blur);
    window.addEventListener("keydown", escape);
    element.addEventListener("lostpointercapture", cancel);
  }

  return <div className="document-tabs-container">
    <p id={instructionsId} className="document-tabs-instructions">
      Select a tab to focus or restore its document. Pin documents from their menu to keep them in the fixed pane area.
      Use Left and Right arrows to move between tabs, Enter to select, and Alt plus Left or Right to reorder.
      Drag tabs to change document positions. Minimize hides a side document without deleting it.
    </p>
    <div ref={tablist} className={`document-tabs${draggingId ? " is-reordering" : ""}`}>
      <div className="document-tabs-list" role="tablist" aria-label="Document tabs" aria-orientation="horizontal" aria-describedby={instructionsId}>
      {documents.map((document, index) => {
        const title = document.title || "Untitled document";
        const minimized = minimizedDocumentIds.includes(document.id);
        const active = document.id === activeDocumentId;
        const pinned = pinnedDocumentIds.includes(document.id);
        return <div key={document.id} role="presentation" draggable
          style={{ order: index * 2 }}
          data-document-tab-id={document.id}
          className={`document-tab${active ? " is-active" : ""}${pinned ? " is-pinned" : ""}${minimized ? " is-minimized" : ""}${draggingId === document.id ? " is-dragging" : ""}${dropTargetId === document.id ? " is-drop-target" : ""}${dropTargetId === document.id && documents.findIndex((item) => item.id === draggingId) < documents.indexOf(document) ? " is-drop-after" : ""}`}
          onPointerDown={(event) => startPointerDrag(event, document.id)}
          onClickCapture={(event) => {
            if (suppressPointerClick.current && event.detail !== 0) {
              suppressPointerClick.current = false;
              event.preventDefault();
              event.stopPropagation();
            }
          }}
          onDragStart={(event) => {
            if ((event.target as Element).closest(".document-menu-trigger")) { event.preventDefault(); return; }
            // Pointer dragging works consistently on buttons and touch screens. Native
            // HTML drag events remain a fallback, but must never run the same gesture twice.
            if (pointerDrag.current) { event.preventDefault(); return; }
            draggedId.current = document.id;
            setDraggingId(document.id);
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("application/x-margin-document", document.id);
          }}
          onDragOver={(event) => {
            if (!draggedId.current) return;
            if (!canReorder(draggedId.current, document.id)) { setDropTargetId(null); return; }
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setDropTargetId(document.id === draggedId.current ? null : document.id);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTargetId(null);
          }}
          onDrop={(event) => {
            if (!draggedId.current) return;
            event.preventDefault();
            reorder(draggedId.current, document.id);
            endDrag();
          }}
          onDragEnd={() => { if (!pointerDrag.current) endDrag(); }}>
          <button type="button" role="tab" className="document-tab-select"
            ref={(element) => { if (element) tabs.current.set(document.id, element); else tabs.current.delete(document.id); }}
            aria-selected={active} aria-label={`${title}${pinned ? ", pinned" : ""}${minimized ? ", minimized. Restore document" : ""}`}
            aria-describedby={instructionsId} tabIndex={tabStopId === document.id ? 0 : -1}
            title={`${title}${minimized ? " — minimized; click to restore" : ""}`}
            onFocus={() => setFocusedId(document.id)}
            onKeyDown={(event) => handleKeyDown(event, document.id)}
            onClick={() => onSelect(document.id)}>
            <svg className="document-tab-icon" viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M11.5 2.5H5A1.5 1.5 0 0 0 3.5 4v12A1.5 1.5 0 0 0 5 17.5h10a1.5 1.5 0 0 0 1.5-1.5V7.5Z"/><path d="M11.5 2.5v5h5M7 11h6M7 14h4"/>
            </svg>
            <span className="document-tab-title">{title}</span>
            {pinned ? <svg className="document-tab-pin" viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m7 2 6 0-1 5 3 3v2H5v-2l3-3-1-5ZM10 12v6"/></svg> : null}
            {minimized ? <span className="document-tab-minimized-label" aria-hidden="true">Minimized</span> : null}
          </button>
          <DocumentMenu conversation={document} pinned={pinned} familyPinned={familyPinnedDocumentIds.includes(document.id)}
            minimized={minimized} onTogglePin={onTogglePin} onTogglePinScope={onTogglePinScope}
            onMinimize={onMinimize} onRestore={onSelect} groups={groups} onAssignGroup={onAssignGroup}
            className="document-tab-menu-trigger"
            onFocusFallback={() => (tabs.current.get(activeDocumentRef.current) ?? tabs.current.values().next().value)?.focus()} />
        </div>;
      })}
      </div>
      <button type="button" className="document-tab-create" onClick={onNewSideDocument}
        style={{ order: Math.max(0, documents.findIndex((document) => document.id === activeDocumentId)) * 2 + 1 }}
        aria-label="New side document" title="Create a side document linked to the focused document">
        <span aria-hidden="true">+</span>
      </button>
    </div>
    <span className="document-tabs-instructions" role="status" aria-live="polite">{announcement}</span>
  </div>;
}
