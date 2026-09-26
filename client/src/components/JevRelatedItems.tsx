import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { Conversation } from "../types";
import type { JevStatus } from "../lib/jevAssistance";
import { useOutsideDismiss } from "../lib/useOutsideDismiss";
import "./JevRelatedItems.css";

export default function JevRelatedItems({ status, related, conversations, currentId, onSelect, warning }: {
  status: JevStatus;
  related: Array<{ id: string; score: number }>;
  conversations: Record<string, Conversation>;
  currentId: string;
  onSelect: (id: string) => void;
  warning?: string;
}) {
  const items = related.filter((item) => item.id !== currentId && conversations[item.id]).slice(0, 5);
  const popupId = useId();
  const headingId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [openForId, setOpenForId] = useState<string | null>(null);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const visible = status === "ready" && items.length > 0;
  const open = visible && openForId === currentId;

  function close(restoreFocus = false) {
    setOpenForId(null);
    if (restoreFocus) trigger.current?.focus();
  }

  useOutsideDismiss(open, () => close(), popup, trigger);
  useEffect(() => { setOpenForId(null); }, [currentId, status, visible]);

  useLayoutEffect(() => {
    if (!open) return;
    function placePopup() {
      const bounds = trigger.current?.getBoundingClientRect();
      if (!bounds) return;
      const width = Math.min(320, window.innerWidth - 16);
      const height = popup.current?.offsetHeight ?? 0;
      const below = bounds.bottom + 6;
      const top = below + height <= window.innerHeight - 8 ? below : bounds.top - height - 6;
      setPosition({
        left: Math.max(8, Math.min(bounds.right - width, window.innerWidth - width - 8)),
        top: Math.max(8, Math.min(top, window.innerHeight - height - 8)),
      });
    }
    placePopup();
    popup.current?.querySelector<HTMLButtonElement>("button")?.focus();
    window.addEventListener("resize", placePopup);
    window.addEventListener("scroll", placePopup, true);
    return () => {
      window.removeEventListener("resize", placePopup);
      window.removeEventListener("scroll", placePopup, true);
    };
  }, [open]);

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    const buttons = Array.from(popup.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
      : event.key === "ArrowDown" ? (index + 1) % buttons.length
      : event.key === "ArrowUp" ? (index - 1 + buttons.length) % buttons.length : -1;
    if (next < 0) return;
    event.preventDefault();
    buttons[next]?.focus();
  }

  if (!visible) return null;
  return <div className="jev-related-control" onKeyDown={open ? handleKeyDown : undefined} onBlur={(event) => {
    const next = event.relatedTarget as Node | null;
    if (next && !popup.current?.contains(next) && !trigger.current?.contains(next)) close();
  }}>
    <button ref={trigger} type="button" className="jev-related-trigger" aria-label={`Related notes and chats (${items.length})`}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? popupId : undefined}
      title="Related notes and chats" onClick={() => setOpenForId(open ? null : currentId)}>
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="m10 13 4-4M8 15l-1 1a4 4 0 0 1-5-6l4-4a4 4 0 0 1 6 0m0 12a4 4 0 0 0 6 0l4-4a4 4 0 0 0-5-6l-1 1" />
      </svg>
      <span className="jev-related-trigger-label">Related</span><span className="jev-related-count" aria-hidden="true">{items.length}</span>
    </button>
    {open ? createPortal(<div ref={popup} id={popupId} className="jev-related-popover" role="dialog" aria-labelledby={headingId} style={position}>
      <h2 id={headingId}>Related notes and chats</h2>
      <div className="jev-related-links">{items.map(({ id }) => <button key={id} type="button" onClick={() => { close(); onSelect(id); }} title={conversations[id].title}>
        <span className="jev-related-kind">{conversations[id].kind === "note" ? "Note" : "Chat"}</span>
        <span className="jev-related-title">{conversations[id].title || "Untitled document"}</span>
        <span className="jev-related-arrow" aria-hidden="true">↗</span>
      </button>)}</div>
      {warning ? <p role="status">{warning}</p> : null}
    </div>, document.body) : null}
  </div>;
}
