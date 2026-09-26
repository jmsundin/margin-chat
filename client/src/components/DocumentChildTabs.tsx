import { useEffect, useId, useRef, useState } from "react";
import type { Conversation } from "../types";
import { useOutsideDismiss } from "../lib/useOutsideDismiss";
import "./DocumentChildTabs.css";

interface Props {
  parent: Conversation;
  documents: Conversation[];
  currentDocumentId: string;
  minimizedDocumentIds: string[];
  onSelect: (id: string) => void;
}

/** An intentional pause reveals siblings without moving the document beneath them. */
export default function DocumentChildTabs({ parent, documents, currentDocumentId, minimizedDocumentIds, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const boundary = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const regionId = useId();
  function cancelTimer() { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; }
  function close() { cancelTimer(); setOpen(false); }
  useEffect(() => () => cancelTimer(), []);
  useOutsideDismiss(open, close, boundary);

  useEffect(() => {
    const surface = panel.current;
    const scroller = list.current;
    if (!open || !surface || !scroller) return;
    const scrollTabs = (event: WheelEvent) => {
      if (event.ctrlKey) return; // Preserve browser pinch zoom.
      // Consume even at an edge or without overflow, so the canvas cannot move.
      event.preventDefault();
      event.stopPropagation();
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientWidth : 1;
      scroller.scrollLeft = Math.max(0, Math.min(scroller.scrollWidth - scroller.clientWidth, scroller.scrollLeft + delta * scale));
    };
    // React wheel listeners are passive; cancellation requires a native listener.
    surface.addEventListener("wheel", scrollTabs, { passive: false });
    return () => surface.removeEventListener("wheel", scrollTabs);
  }, [open]);

  return <div ref={boundary} className={`document-child-tabs${open ? " is-open" : ""}`}
    onPointerEnter={(event) => {
      cancelTimer();
      if (event.pointerType !== "touch" && !event.buttons) timer.current = setTimeout(() => setOpen(true), 450);
    }}
    onPointerLeave={() => {
      cancelTimer();
      if (!boundary.current?.contains(document.activeElement)) timer.current = setTimeout(() => setOpen(false), 220);
    }}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) close(); }}
    onKeyDown={(event) => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation();
        trigger.current?.focus(); close();
      }
    }}>
    <button ref={trigger} className="document-child-tabs-trigger" type="button"
      aria-label={`Show child documents of ${parent.title || "Untitled document"}`}
      aria-expanded={open} aria-controls={regionId}
      onFocus={() => { cancelTimer(); setOpen(true); }}
      onClick={() => { cancelTimer(); setOpen(true); }}>
      <span aria-hidden="true" />
    </button>
    {open && <nav ref={panel} id={regionId} className="document-child-tabs-panel" aria-label={`Child documents of ${parent.title || "Untitled document"}`}>
      <div className="document-child-tabs-heading"><span>From {parent.title || "Untitled document"}</span><span>{documents.length}</span></div>
      <div ref={list} className="document-child-tabs-list" onKeyDown={(event) => {
        const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
        if (!keys.includes(event.key)) return;
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (index < 0) return;
        event.preventDefault(); event.stopPropagation();
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length;
        buttons[next]?.focus();
        buttons[next]?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      }}>
        {documents.map((document) => <button type="button" key={document.id}
          aria-current={document.id === currentDocumentId ? "page" : undefined}
          title={document.title || "Untitled document"}
          onClick={() => { close(); onSelect(document.id); }}>
          <span>{document.title || "Untitled document"}</span>
          {minimizedDocumentIds.includes(document.id) && <small>Minimized</small>}
        </button>)}
      </div>
    </nav>}
  </div>;
}
