import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { Conversation } from "../types";
import { formatRelativeTime } from "../lib/conversationSearch";
import { getDocumentBreadcrumbs, getDocumentKind, type DocumentKind } from "../lib/documentBreadcrumbs";
import { getDocumentPreview } from "../lib/documentSources";
import { useOutsideDismiss } from "../lib/useOutsideDismiss";
import "./DocumentBreadcrumbs.css";

interface Props {
  conversations: Record<string, Conversation>;
  focusedId: string;
  /** Panes, pinned panes and margin notes currently on screen. */
  onScreenIds: ReadonlySet<string>;
  minimizedIds: ReadonlySet<string>;
  streamingIds: ReadonlySet<string>;
  backTitle: string | null;
  onBack: () => void;
  onExpand: (id: string) => void;
  onOpenBeside: (id: string) => void;
}

const KIND_LABELS: Record<DocumentKind, string> = {
  main: "Main document", side: "Side document", branch: "Branch chat", note: "Margin note",
};
const ICONS = {
  main: "M6 3h8l4 4v14H6zM14 3v4h4",
  side: "M6 3h8l4 4v14H6zM9 12h6M9 16h6",
  branch: "M4 5h16v11H9l-5 4z",
  note: "M5 4h14v11l-5 5H5zM14 20v-5h5",
  children: "M7 4v9a3 3 0 0 0 3 3h9M16 13l3 3-3 3",
  chevron: "M6 9l6 6 6-6",
  back: "M15 6l-6 6 6 6",
  expand: "M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7",
  beside: "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM12 4v16",
};

function Icon({ name, className }: { name: keyof typeof ICONS; className: string }) {
  return <svg className={className} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={ICONS[name]} /></svg>;
}

function titleOf(document: Conversation) {
  return document.title || "Untitled document";
}

/** One breadcrumb follows the focused document; each level lists its peers to expand here or open beside. */
export default function DocumentBreadcrumbs({ conversations, focusedId, onScreenIds, minimizedIds, streamingIds, backTitle, onBack, onExpand, onOpenBeside }: Props) {
  const { levels, children, childrenByParent } = useMemo(() => getDocumentBreadcrumbs(conversations, focusedId), [conversations, focusedId]);
  const focused = conversations[focusedId];
  const crumbs = [
    ...levels.map((level) => ({ key: level.document.id, document: level.document as Conversation | null, options: level.options,
      heading: level.parent ? `Children of ${titleOf(level.parent)}` : "Peer documents" })),
    ...(focused && children.length ? [{ key: "children", document: null, options: children, heading: `Children of ${titleOf(focused)}` }] : []),
  ];
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [detail, setDetail] = useState<{ id: string; top: number; left: number } | null>(null);
  const bar = useRef<HTMLElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const panel = useRef<HTMLElement>(null);
  const rows = useRef<HTMLDivElement>(null);
  const triggers = useRef(new Map<number, HTMLButtonElement>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusFirst = useRef(false);
  const hoverOpenedAt = useRef(0);
  const panelId = useId();
  const detailId = useId();
  const open = openIndex === null ? null : crumbs[openIndex] ?? null;

  function cancelTimer() { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; }
  function close(returnFocus = false) {
    cancelTimer();
    if (returnFocus && openIndex !== null) triggers.current.get(openIndex)?.focus();
    setOpenIndex(null);
    setDetail(null);
  }
  function show(index: number, focusRows = false) {
    cancelTimer();
    if (openIndex === index) {
      if (focusRows) rows.current?.querySelector<HTMLButtonElement>(".document-breadcrumb-row-title")?.focus();
      return;
    }
    focusFirst.current = focusRows;
    setDetail(null);
    setOpenIndex(index);
  }
  function enter(index: number, pointerType: string, buttons: number) {
    cancelTimer();
    if (pointerType === "touch" || buttons) return;
    // Moving along the bar switches levels at once, like a menu bar, once one level is open.
    if (openIndex !== null) { if (openIndex !== index) { show(index); hoverOpenedAt.current = Date.now(); } return; }
    timer.current = setTimeout(() => { setOpenIndex(index); hoverOpenedAt.current = Date.now(); }, 200);
  }
  function leave() {
    cancelTimer();
    if (bar.current?.contains(document.activeElement) || panel.current?.contains(document.activeElement)) return;
    timer.current = setTimeout(() => { setOpenIndex(null); setDetail(null); }, 250);
  }
  function choose(id: string, action: (id: string) => void) {
    close();
    if (id !== focusedId) action(id);
  }
  function showDetail(id: string, row: HTMLElement) {
    const menu = panel.current?.getBoundingClientRect();
    if (!menu) return;
    const width = 300;
    const right = menu.right + 8 + width <= window.innerWidth - 12;
    if (!right && menu.left - 8 - width < 12) { setDetail(null); return; }
    const top = Math.max(12, Math.min(row.getBoundingClientRect().top - 4, window.innerHeight - 240));
    setDetail({ id, top, left: right ? menu.right + 8 : menu.left - 8 - width });
  }

  useEffect(() => () => cancelTimer(), []);
  useEffect(() => { setOpenIndex(null); setDetail(null); }, [focusedId]);
  useEffect(() => { if (openIndex !== null && openIndex >= crumbs.length) close(); }, [crumbs.length, openIndex]);
  useOutsideDismiss(openIndex !== null, () => close(), bar, panel);
  useLayoutEffect(() => {
    // Deep paths keep the focused document in view.
    if (list.current) list.current.scrollLeft = list.current.scrollWidth;
  }, [focusedId, crumbs.length]);

  useLayoutEffect(() => {
    const popup = panel.current;
    const trigger = openIndex === null ? undefined : triggers.current.get(openIndex);
    if (!popup || !trigger) return;
    function position() {
      const anchor = trigger!.getBoundingClientRect();
      const width = Math.min(360, window.innerWidth - 24);
      const top = anchor.bottom + 6;
      Object.assign(popup!.style, {
        width: `${width}px`, maxHeight: `${Math.max(160, window.innerHeight - top - 16)}px`, top: `${top}px`,
        left: `${Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12))}px`,
      });
    }
    position();
    if (focusFirst.current) { rows.current?.querySelector<HTMLButtonElement>(".document-breadcrumb-row-title")?.focus(); focusFirst.current = false; }
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && popup.contains(event.target)) { setDetail(null); return; }
      position();
    };
    window.addEventListener("resize", position);
    window.addEventListener("scroll", onScroll, true);
    return () => { window.removeEventListener("resize", position); window.removeEventListener("scroll", onScroll, true); };
  }, [openIndex, open?.options.length]);

  useEffect(() => {
    const surface = panel.current;
    const scroller = rows.current;
    if (openIndex === null || !surface || !scroller) return;
    // Wheel input scrolls this list instead of the documents behind it.
    const scrollRows = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      const delta = event.deltaY || event.deltaX;
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientHeight : 1;
      scroller.scrollTop = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, scroller.scrollTop + delta * scale));
      setDetail(null);
    };
    surface.addEventListener("wheel", scrollRows, { passive: false });
    return () => surface.removeEventListener("wheel", scrollRows);
  }, [openIndex]);

  function moveFocus(event: ReactKeyboardEvent<HTMLElement>) {
    const current = document.activeElement as HTMLElement | null;
    const row = current?.closest<HTMLElement>(".document-breadcrumb-row");
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); close(true);
      return;
    }
    if (!row || !rows.current) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const buttons = [...row.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      const index = buttons.indexOf(current as HTMLButtonElement);
      const next = buttons[index + (event.key === "ArrowRight" ? 1 : -1)];
      if (!next) return;
      event.preventDefault(); next.focus();
      return;
    }
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    const titles = [...rows.current.querySelectorAll<HTMLButtonElement>(".document-breadcrumb-row-title")];
    const index = titles.indexOf(row.querySelector<HTMLButtonElement>(".document-breadcrumb-row-title")!);
    event.preventDefault(); event.stopPropagation();
    const next = event.key === "Home" ? 0 : event.key === "End" ? titles.length - 1
      : (index + (event.key === "ArrowDown" ? 1 : titles.length - 1)) % titles.length;
    titles[next]?.focus(); titles[next]?.scrollIntoView?.({ block: "nearest" });
  }

  const detailDocument = detail ? conversations[detail.id] : undefined;
  const detailChildren = detailDocument ? childrenByParent.get(detailDocument.id)?.length ?? 0 : 0;

  return <>
    <nav ref={bar} className="document-breadcrumbs" aria-label="Focused document path"
      onBlur={(event) => {
        if (openIndex !== null && !bar.current?.contains(event.relatedTarget) && !panel.current?.contains(event.relatedTarget)) close();
      }}>
      <button type="button" className="document-breadcrumbs-back" disabled={!backTitle} onClick={onBack}
        aria-label={backTitle ? `Back to ${backTitle}` : "Back"} title={backTitle ? `Back to ${backTitle}` : "Back"}>
        <Icon name="back" className="document-breadcrumbs-back-icon" />
      </button>
      <ol ref={list} className="document-breadcrumbs-list">
        {crumbs.map((crumb, index) => {
          const label = crumb.document ? titleOf(crumb.document) : `${crumb.options.length} ${crumb.options.length === 1 ? "child" : "children"}`;
          const current = crumb.document?.id === focusedId;
          return <li key={crumb.key} className={`document-breadcrumb${crumb.document ? "" : " is-children"}`}
            onPointerEnter={(event) => enter(index, event.pointerType, event.buttons)} onPointerLeave={leave}>
            {index ? <span className="document-breadcrumb-separator" aria-hidden="true">›</span> : null}
            <button type="button" className="document-breadcrumb-trigger"
              ref={(element) => { if (element) triggers.current.set(index, element); else triggers.current.delete(index); }}
              aria-current={current ? "page" : undefined} aria-expanded={openIndex === index}
              aria-controls={openIndex === index ? panelId : undefined}
              aria-label={`${label} (${crumb.heading}: ${crumb.options.length})`}
              // A click right after hover opened the level keeps it open instead of toggling it shut.
              onClick={() => openIndex === index && Date.now() - hoverOpenedAt.current > 600 ? close() : show(index)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") { event.preventDefault(); event.stopPropagation(); show(index, true); }
                else if (event.key === "Escape" && openIndex !== null) { event.preventDefault(); event.stopPropagation(); close(true); }
              }}>
              <Icon name={crumb.document ? getDocumentKind(crumb.document) : "children"} className="document-breadcrumb-icon" />
              <span className="document-breadcrumb-label">{label}</span>
              {crumb.document && streamingIds.has(crumb.document.id) ? <span className="document-breadcrumb-streaming" title="AI writing">
                <span className="thread-streaming-dot" aria-hidden="true" /></span> : null}
              <Icon name="chevron" className="document-breadcrumb-chevron" />
            </button>
          </li>;
        })}
      </ol>
    </nav>
    {open && openIndex !== null ? createPortal(<nav ref={panel} id={panelId} className="document-breadcrumb-menu" aria-label={open.heading}
      onPointerEnter={cancelTimer} onPointerLeave={leave} onKeyDown={moveFocus}
      onBlur={(event) => {
        if (!bar.current?.contains(event.relatedTarget) && !panel.current?.contains(event.relatedTarget)) close();
      }}>
      <div className="document-breadcrumb-menu-heading">{open.heading}</div>
      <div ref={rows} className="document-breadcrumb-menu-list" onPointerLeave={() => setDetail(null)}>
        {open.options.map((document) => {
          const title = titleOf(document);
          const here = document.id === focusedId;
          const onScreen = onScreenIds.has(document.id);
          const minimized = minimizedIds.has(document.id);
          const tag = here ? "Here" : onScreen ? "Open" : minimized ? "Minimized" : null;
          return <div key={document.id} data-breadcrumb-document-id={document.id}
            className={`document-breadcrumb-row${here ? " is-here" : onScreen || minimized ? " is-open" : ""}`}
            onPointerEnter={(event) => showDetail(document.id, event.currentTarget)}
            onFocus={(event) => showDetail(document.id, event.currentTarget)}>
            <button type="button" className="document-breadcrumb-row-title" aria-current={here ? "page" : undefined}
              aria-describedby={detail?.id === document.id ? detailId : undefined}
              onClick={() => choose(document.id, onExpand)}>
              <Icon name={getDocumentKind(document)} className="document-breadcrumb-icon" />
              <span className="document-breadcrumb-row-label">{title}</span>
              {streamingIds.has(document.id) ? <span className="document-breadcrumb-streaming" title="AI writing">
                <span className="thread-streaming-dot" aria-hidden="true" /></span> : null}
              {tag ? <span className={`document-breadcrumb-tag is-${tag.toLowerCase()}`}>{tag}</span> : null}
            </button>
            <button type="button" className="document-breadcrumb-action" disabled={here}
              aria-label={`Expand ${title} here`} title="Expand here" onClick={() => choose(document.id, onExpand)}>
              <Icon name="expand" className="document-breadcrumb-action-icon" />
            </button>
            <button type="button" className="document-breadcrumb-action" disabled={here}
              aria-label={`Open ${title} beside`} title="Open beside" onClick={() => choose(document.id, onOpenBeside)}>
              <Icon name="beside" className="document-breadcrumb-action-icon" />
            </button>
          </div>;
        })}
      </div>
    </nav>, document.body) : null}
    {open && detail && detailDocument ? createPortal(<div id={detailId} role="tooltip" className="document-breadcrumb-detail"
      style={{ top: `${detail.top}px`, left: `${detail.left}px` }}>
      <div className="document-breadcrumb-detail-kind">
        <Icon name={getDocumentKind(detailDocument)} className="document-breadcrumb-icon" />
        <span>{KIND_LABELS[getDocumentKind(detailDocument)]}</span>
        {streamingIds.has(detailDocument.id) ? <span className="document-breadcrumb-streaming"><span className="thread-streaming-dot" aria-hidden="true" />AI writing</span> : null}
      </div>
      <strong className="document-breadcrumb-detail-title">{titleOf(detailDocument)}</strong>
      {detailDocument.branchAnchor?.quote ? <blockquote>“{detailDocument.branchAnchor.quote}”</blockquote> : null}
      <p>{getDocumentPreview(detailDocument, 220)}</p>
      <div className="document-breadcrumb-detail-meta">
        <span>{detailChildren ? `${detailChildren} ${detailChildren === 1 ? "child" : "children"}` : "No children"}</span>
        <span>Edited {formatRelativeTime(detailDocument.updatedAt)}</span>
      </div>
    </div>, document.body) : null}
  </>;
}
