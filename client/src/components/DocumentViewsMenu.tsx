import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useOutsideDismiss } from "../lib/useOutsideDismiss";
import "./DocumentViewsMenu.css";

export interface DocumentViewsMenuProps {
  currentDocumentId: string;
  relatedItems: Array<{ id: string; title: string; kind?: string }>;
  relatedWarning?: string;
  onSelectRelated: (id: string) => void;
  branchCount: number;
  branchesOpen: boolean;
  branchesEnabled?: boolean;
  onToggleBranches: () => void;
}

export default function DocumentViewsMenu({ currentDocumentId, relatedItems, relatedWarning, onSelectRelated,
  branchCount, branchesOpen, branchesEnabled = true, onToggleBranches }: DocumentViewsMenuProps) {
  const popupId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const initialFocus = useRef<"first" | "last">("first");
  const [view, setView] = useState<"views" | "related" | null>(null);
  const [position, setPosition] = useState({ left: 8, top: 8 });

  function close(restoreFocus = false) {
    setView(null);
    if (restoreFocus) trigger.current?.focus();
  }

  useOutsideDismiss(view !== null, () => close(), popup, trigger);
  useEffect(() => { setView(null); }, [currentDocumentId]);

  useLayoutEffect(() => {
    if (!view) return;
    function placePopup() {
      const bounds = trigger.current?.getBoundingClientRect();
      if (!bounds) return;
      const width = popup.current?.offsetWidth || (view === "related" ? 320 : 224);
      const height = popup.current?.offsetHeight || 96;
      const below = bounds.bottom + 6;
      setPosition({
        left: Math.max(8, Math.min(bounds.right - width, window.innerWidth - width - 8)),
        top: Math.max(8, Math.min(below + height <= window.innerHeight - 8 ? below : bounds.top - height - 6, window.innerHeight - height - 8)),
      });
    }
    placePopup();
    const items = popup.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)');
    (items?.[initialFocus.current === "last" ? items.length - 1 : 0] ?? popup.current)?.focus();
    initialFocus.current = "first";
    window.addEventListener("resize", placePopup);
    window.addEventListener("scroll", placePopup, true);
    return () => {
      window.removeEventListener("resize", placePopup);
      window.removeEventListener("scroll", placePopup, true);
    };
  }, [view]);

  function handleMenuKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape" || (view === "related" && event.key === "ArrowLeft")) {
      event.preventDefault();
      event.stopPropagation();
      if (view === "related") setView("views");
      else close(true);
      return;
    }
    if (event.key === "Tab") { close(true); return; }
    const items = [...(popup.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : event.key === "ArrowDown" ? (index + 1) % items.length
      : event.key === "ArrowUp" ? (index - 1 + items.length) % items.length : -1;
    if (next < 0) return;
    event.preventDefault();
    items[next]?.focus();
  }

  return <div className="document-views-control" onBlur={(event) => {
    const next = event.relatedTarget as Node | null;
    if (next && !popup.current?.contains(next) && !trigger.current?.contains(next)) close();
  }}>
    <button ref={trigger} type="button" className="document-views-trigger"
      aria-label="Document views" title="Document views" aria-haspopup="menu"
      aria-expanded={view !== null} aria-controls={view ? popupId : undefined}
      onClick={() => view ? close(true) : setView("views")}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        initialFocus.current = event.key === "ArrowUp" ? "last" : "first";
        setView("views");
      }}>
      <svg viewBox="0 0 20 20" aria-hidden="true" fill="currentColor"><circle cx="10" cy="4" r="1.6"/><circle cx="10" cy="10" r="1.6"/><circle cx="10" cy="16" r="1.6"/></svg>
    </button>
    {view ? createPortal(<div ref={popup} id={popupId} role="menu" tabIndex={-1}
      aria-label={view === "related" ? "Related notes and chats" : "Document views"}
      className={`document-views-menu${view === "related" ? " is-related" : ""}`}
      style={position} onKeyDown={handleMenuKeyDown}>
      {view === "views" ? <>
        <button type="button" role="menuitem" className="document-views-related"
          disabled={!relatedItems.length} aria-haspopup="menu" aria-label={`Related notes and chats (${relatedItems.length})`}
          title={relatedItems.length ? "Related notes and chats" : "No related notes or chats available"}
          onClick={() => setView("related")}
          onKeyDown={(event) => { if (event.key === "ArrowRight") { event.preventDefault(); setView("related"); } }}>
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="m10 13 4-4M8 15l-1 1a4 4 0 0 1-5-6l4-4a4 4 0 0 1 6 0m0 12a4 4 0 0 0 6 0l4-4a4 4 0 0 0-5-6l-1 1" /></svg>
          <span>Related</span><span className="document-views-count" aria-hidden="true">{relatedItems.length}</span><span aria-hidden="true">›</span>
        </button>
        {branchesEnabled ? <button type="button" role="menuitemcheckbox" aria-checked={branchesOpen}
          aria-label={`Branches ${branchCount}`} aria-controls="branch-navigation-map"
          disabled={branchCount === 0 && !branchesOpen}
          title="Browse the conversation hierarchy"
          onClick={() => { close(true); onToggleBranches(); }}>
          <svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="5" cy="4" r="2"/><circle cx="5" cy="16" r="2"/><circle cx="15" cy="6" r="2"/><path d="M5 6v8m0-4h6a4 4 0 0 0 4-4"/></svg>
          <span>Branches</span><span className="document-views-count" aria-hidden="true">{branchCount}</span><span className="document-views-check" aria-hidden="true">{branchesOpen ? "✓" : ""}</span>
        </button> : null}
      </> : <>
        <button type="button" role="menuitem" className="document-views-back" onClick={() => setView("views")}>
          <span aria-hidden="true">‹</span><span>Document views</span>
        </button>
        <div className="document-views-heading">Related notes and chats</div>
        {relatedItems.map((item) => <button key={item.id} type="button" role="menuitem"
          title={item.title || "Untitled document"} onClick={() => { close(true); onSelectRelated(item.id); }}>
          <span className="document-views-kind" aria-hidden="true">{item.kind === "note" ? "Note" : "Chat"}</span>
          <span className="document-views-title">{item.title || "Untitled document"}</span><span aria-hidden="true">↗</span>
        </button>)}
        {!relatedItems.length ? <p>No related notes or chats available.</p> : null}
        {relatedWarning ? <p role="status">{relatedWarning}</p> : null}
      </>}
    </div>, document.body) : null}
  </div>;
}
