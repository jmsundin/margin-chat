import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Conversation } from "../types";
import { getDocumentPreview } from "../lib/documentSources";
import { useOutsideDismiss } from "../lib/useOutsideDismiss";
import "./DocumentChildTabs.css";

interface Props {
  parent: Conversation;
  documents: Conversation[];
  currentDocumentId: string;
  minimizedDocumentIds: string[];
  openDocumentIds?: string[];
  onSelect: (id: string) => void;
}

/** Branches and linked documents share one Children list, independently of pane position. */
export default function DocumentChildTabs({ parent, documents, currentDocumentId, minimizedDocumentIds, openDocumentIds = [], onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const boundary = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusFirst = useRef(false);
  const regionId = useId();
  function cancelTimer() { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; }
  function close() { cancelTimer(); setOpen(false); }
  function enter(pointerType: string, buttons: number) {
    cancelTimer();
    if (pointerType !== "touch" && !buttons) timer.current = setTimeout(() => setOpen(true), 450);
  }
  function leave() {
    cancelTimer();
    if (!boundary.current?.contains(document.activeElement) && !panel.current?.contains(document.activeElement)) {
      timer.current = setTimeout(() => setOpen(false), 220);
    }
  }
  useEffect(() => () => cancelTimer(), []);
  useEffect(() => {
    if (!documents.length) { close(); focusFirst.current = false; }
  }, [documents.length]);
  useOutsideDismiss(open, close, boundary, panel);

  useLayoutEffect(() => {
    if (!open || !panel.current || !trigger.current) return;
    const popup = panel.current;
    function position() {
      const anchor = trigger.current!.getBoundingClientRect();
      const width = Math.min(360, window.innerWidth - 24);
      const below = window.innerHeight - anchor.bottom - 20;
      const above = anchor.top - 20;
      const flip = below < 180 && above > below;
      const height = Math.min(380, Math.max(80, flip ? above : below));
      Object.assign(popup.style, {
        width: `${width}px`, maxHeight: `${height}px`,
        left: `${Math.max(12, Math.min(anchor.right - width, window.innerWidth - width - 12))}px`,
        top: flip ? "auto" : `${anchor.bottom + 6}px`,
        bottom: flip ? `${window.innerHeight - anchor.top + 6}px` : "auto",
      });
    }
    position();
    if (focusFirst.current) { list.current?.querySelector<HTMLButtonElement>("button")?.focus(); focusFirst.current = false; }
    const onScroll = (event: Event) => { if (!(event.target instanceof Node) || !popup.contains(event.target)) position(); };
    window.addEventListener("resize", position);
    window.addEventListener("scroll", onScroll, true);
    return () => { window.removeEventListener("resize", position); window.removeEventListener("scroll", onScroll, true); };
  }, [open, documents.length]);

  useEffect(() => {
    const surface = panel.current;
    const scroller = list.current;
    if (!open || !surface || !scroller) return;
    const scrollChildren = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      const delta = event.deltaY || event.deltaX;
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientHeight : 1;
      scroller.scrollTop = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, scroller.scrollTop + delta * scale));
    };
    surface.addEventListener("wheel", scrollChildren, { passive: false });
    return () => surface.removeEventListener("wheel", scrollChildren);
  }, [open, documents.length]);

  if (!documents.length) return null;

  return <div ref={boundary} className={`document-child-tabs${open ? " is-open" : ""}`}
    onPointerEnter={(event) => enter(event.pointerType, event.buttons)} onPointerLeave={leave}
    onBlur={(event) => {
      if (!boundary.current?.contains(event.relatedTarget) && !panel.current?.contains(event.relatedTarget)) close();
    }}
    onKeyDown={(event) => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); close(); trigger.current?.focus();
      }
    }}>
    <button ref={trigger} className="document-child-tabs-trigger" type="button"
      aria-label={`Children of ${parent.title || "Untitled document"} (${documents.length})`}
      aria-expanded={open} aria-controls={open ? regionId : undefined}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown") return;
        event.preventDefault(); event.stopPropagation(); cancelTimer();
        if (open) list.current?.querySelector<HTMLButtonElement>("button")?.focus();
        else { focusFirst.current = true; setOpen(true); }
      }}
      onClick={() => { cancelTimer(); setOpen(!open); }}>
      <span className="document-child-count">{documents.length}</span><span aria-hidden="true">⌄</span>
    </button>
    {open && createPortal(<nav ref={panel} id={regionId} className="document-child-tabs-panel" aria-label={`Child documents of ${parent.title || "Untitled document"}`}
      onPointerEnter={() => cancelTimer()} onPointerLeave={leave}>
      <div className="document-child-tabs-heading">Children of {parent.title || "Untitled document"}</div>
      <div ref={list} className="document-child-tabs-list" onKeyDown={(event) => {
        if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (index < 0) return;
        event.preventDefault(); event.stopPropagation();
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length;
        buttons[next]?.focus(); buttons[next]?.scrollIntoView?.({ block: "nearest" });
      }}>
        {documents.map((document) => <button type="button" key={document.id}
          aria-current={document.id === currentDocumentId ? "page" : undefined}
          onClick={() => { close(); onSelect(document.id); }}>
          <span className="document-child-item-heading"><span className="document-child-title">{document.title || "Untitled document"}</span>
            <small>{openDocumentIds.includes(document.id) ? "Open" : minimizedDocumentIds.includes(document.id) ? "Minimized" : "Not open"}</small></span>
          <span className="document-child-preview">{getDocumentPreview(document)}</span>
        </button>)}
      </div>
    </nav>, document.body)}
  </div>;
}
