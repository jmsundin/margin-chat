import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { DOCUMENT_MODE_HINTS, DOCUMENT_MODE_LABELS, type DocumentMode } from "../lib/documentModes";
import { useOutsideDismiss } from "../lib/useOutsideDismiss";
import "./DocumentModeSwitch.css";

export interface DocumentModeSwitchProps {
  title: string;
  mode: DocumentMode;
  /** Modes this document can switch to; Write and Read are always offered. */
  offered: { code: boolean; language: boolean; board: boolean };
  onPick: (mode: DocumentMode) => void;
  /** The map around this document, beside it. */
  onMap?: () => void;
  /** The roadmap this document is (or is a step of), as a course. */
  onLearn?: () => void;
  /** This document's flashcards, in their own full-screen review. */
  review?: { count: number; onOpen: () => void };
  /** Makes a new document to read in the language being learned. Offered with the Language learning feature. */
  onNewLesson?: () => void;
}

/**
 * The button at the top of a document that names its mode and switches it. Each mode is a
 * different interface for the same document, so it lives here instead of among the ⋯ menu's settings.
 */
export default function DocumentModeSwitch({ title, mode, offered, onPick, onMap, onLearn, review, onNewLesson }: DocumentModeSwitchProps) {
  const popupId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  useOutsideDismiss(open, () => setOpen(false), popup, trigger);

  function close(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }

  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const bounds = trigger.current?.getBoundingClientRect();
      if (!bounds) return;
      const width = popup.current?.offsetWidth || 280;
      const height = popup.current?.offsetHeight || 200;
      const below = bounds.bottom + 6;
      setPosition({
        left: Math.max(8, Math.min(bounds.right - width, window.innerWidth - width - 8)),
        top: Math.max(8, below + height <= window.innerHeight - 8 ? below : bounds.top - height - 6),
      });
    }
    place();
    popup.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);

  function onMenuKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.key === "Tab") { close(); return; }
    const items = [...(popup.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? (index + 1) % items.length : event.key === "ArrowUp" ? (index - 1 + items.length) % items.length
      : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    items[next]?.focus();
  }

  const modes: DocumentMode[] = ["write", "read", ...(offered.code || mode === "code" ? ["code" as const] : []), ...(offered.language || mode === "language" ? ["language" as const] : []), ...(offered.board || mode === "board" ? ["board" as const] : [])];

  return <div className="document-mode-switch">
    <button ref={trigger} type="button" className="document-mode-trigger" data-mode={mode}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? popupId : undefined}
      aria-label={`Mode: ${DOCUMENT_MODE_LABELS[mode]}. Change how ${title || "this document"} opens`}
      title="How this document opens"
      onClick={() => open ? close(true) : setOpen(true)}
      onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); } }}>
      <span className="document-mode-dot" aria-hidden="true" />
      <span>{DOCUMENT_MODE_LABELS[mode]}</span>
      <span aria-hidden="true" className="document-mode-caret">▾</span>
    </button>
    {open ? createPortal(<div ref={popup} id={popupId} role="menu" aria-label="Open this document in" tabIndex={-1}
      className="document-mode-menu" style={position} onKeyDown={onMenuKeyDown}>
      <div className="document-mode-heading" aria-hidden="true">Open this document in</div>
      {modes.map((candidate) => <button key={candidate} type="button" role="menuitemradio" aria-checked={candidate === mode}
        data-mode={candidate} onClick={() => { close(true); if (candidate !== mode) onPick(candidate); }}>
        <span className="document-mode-dot" aria-hidden="true" />
        <span className="document-mode-name">{DOCUMENT_MODE_LABELS[candidate]}{candidate === "read" ? <kbd>⌘E</kbd> : null}</span>
        <span className="document-mode-hint">{DOCUMENT_MODE_HINTS[candidate]}</span>
      </button>)}
      {onMap || onLearn || onNewLesson || (review && review.count > 0) ? <div className="document-mode-separator" role="separator" /> : null}
      {onMap ? <button type="button" role="menuitem" data-mode="map" onClick={() => { close(); onMap(); }}>
        <span className="document-mode-dot" aria-hidden="true" />
        <span className="document-mode-name">Map<kbd>⌘G</kbd></span>
        <span className="document-mode-hint">What this document connects to, beside it</span>
      </button> : null}
      {onLearn ? <button type="button" role="menuitem" data-mode="learn" onClick={() => { close(); onLearn(); }}>
        <span className="document-mode-dot" aria-hidden="true" />
        <span className="document-mode-name">Learn</span>
        <span className="document-mode-hint">This roadmap as a course, one step at a time</span>
      </button> : null}
      {review && review.count > 0 ? <button type="button" role="menuitem" data-mode="review" onClick={() => { close(); review.onOpen(); }}>
        <span className="document-mode-dot" aria-hidden="true" />
        <span className="document-mode-name">Review<span className="document-mode-count">{review.count}</span></span>
        <span className="document-mode-hint">This document's flashcards, one at a time</span>
      </button> : null}
      {onNewLesson ? <button type="button" role="menuitem" data-mode="lesson" onClick={() => { close(); onNewLesson(); }}>
        <span className="document-mode-dot" aria-hidden="true" />
        <span className="document-mode-name">New lesson…</span>
        <span className="document-mode-hint">Something new to read in the language you're learning</span>
      </button> : null}
    </div>, document.body) : null}
  </div>;
}
