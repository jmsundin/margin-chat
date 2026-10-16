import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { currentPdfOutlineEntry, type PdfOutlineEntry } from "../lib/pdfOutline";

export type PdfSidebarTab = "thumbnails" | "contents";

interface PageSize { width: number; height: number }

export interface PdfSidebarProps {
  pdf: PDFDocumentProxy;
  tab: PdfSidebarTab;
  onTab: (tab: PdfSidebarTab) => void;
  sizes: PageSize[];
  labels: string[] | null;
  /** The table of contents, or null while it is read. */
  outline: PdfOutlineEntry[] | null;
  currentPage: number;
  onJump: (page: number, top?: number | null) => void;
  onClose: () => void;
}

/** Page thumbnails and the PDF's own table of contents, for jumping around a long file. */
export default function PdfSidebar(props: PdfSidebarProps) {
  return <aside className="vault-pdf-sidebar" aria-label="Pages and contents">
    <div className="vault-pdf-sidebar-tabs" role="tablist" aria-label="Show">
      <button type="button" role="tab" aria-selected={props.tab === "thumbnails"} onClick={() => props.onTab("thumbnails")}>Thumbnails</button>
      <button type="button" role="tab" aria-selected={props.tab === "contents"} onClick={() => props.onTab("contents")}>Contents</button>
      <button type="button" className="vault-pdf-sidebar-close" aria-label="Close pages and contents" title="Close" onClick={props.onClose}>×</button>
    </div>
    {props.tab === "thumbnails"
      ? <Thumbnails {...props} />
      : <PdfContents inTab outline={props.outline} currentPage={props.currentPage} labels={props.labels} onJump={props.onJump} />}
  </aside>;
}

/* ---------- Thumbnails ---------- */

const THUMBNAIL_WIDTH = 112;

// A few thumbnails draw at a time, so a long jump down the list doesn't queue hundreds of pages ahead of the reader's own.
let drawing = 0;
const waiting: Array<() => void> = [];
function drawSlot(): Promise<() => void> {
  return new Promise((resolve) => {
    const start = () => {
      drawing += 1;
      let done = false;
      resolve(() => {
        if (done) return;
        done = true;
        drawing -= 1;
        waiting.shift()?.();
      });
    };
    if (drawing < 2) start(); else waiting.push(start);
  });
}

function Thumbnails(props: PdfSidebarProps) {
  const listRef = useRef<HTMLOListElement>(null);
  const [root, setRoot] = useState<HTMLOListElement | null>(null);
  useLayoutEffect(() => setRoot(listRef.current), []);

  // Keep the reader's page in view in the list, without moving the document itself.
  useEffect(() => {
    const list = listRef.current;
    const item = list?.querySelector<HTMLElement>(`[data-thumbnail-page="${props.currentPage}"]`);
    if (!list || !item) return;
    const top = item.offsetTop;
    if (top < list.scrollTop || top + item.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = Math.max(0, top - (list.clientHeight - item.offsetHeight) / 2);
    }
  }, [props.currentPage, root]);

  return <ol className="vault-pdf-thumbnails" ref={listRef} role="tabpanel" aria-label="Thumbnails">
    {root ? props.sizes.map((size, index) => <Thumbnail key={index} pdf={props.pdf} number={index + 1} size={size} root={root}
      label={props.labels?.[index] || String(index + 1)} active={props.currentPage === index + 1} onJump={props.onJump} />) : null}
  </ol>;
}

function Thumbnail(props: { pdf: PDFDocumentProxy; number: number; size: PageSize; label: string; active: boolean; root: HTMLElement; onJump: (page: number) => void }) {
  const itemRef = useRef<HTMLLIElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  const [drawn, setDrawn] = useState(false);
  const height = Math.round(THUMBNAIL_WIDTH * (props.size.height / props.size.width || 1.3));

  useEffect(() => {
    const item = itemRef.current;
    if (!item || typeof IntersectionObserver === "undefined") { setNear(true); return; }
    const observer = new IntersectionObserver((entries) => setNear(entries.some((entry) => entry.isIntersecting)), { root: props.root, rootMargin: "400px 0px" });
    observer.observe(item);
    return () => observer.disconnect();
  }, [props.root]);

  // Only thumbnails near the visible part of the list are drawn; the rest give their memory back.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!near || !canvas) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    let release: (() => void) | null = null;
    (async () => {
      release = await drawSlot();
      if (cancelled) return;
      const page = await props.pdf.getPage(props.number);
      if (cancelled) return;
      const natural = page.getViewport({ scale: 1 });
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: (THUMBNAIL_WIDTH / natural.width) * ratio });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      task = page.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport });
      await task.promise;
      if (!cancelled) setDrawn(true);
    })().catch(() => undefined).finally(() => release?.());
    return () => {
      cancelled = true;
      task?.cancel();
      release?.();
      canvas.width = 0;
      canvas.height = 0;
      setDrawn(false);
    };
  }, [near, props.pdf, props.number]);

  return <li className={`vault-pdf-thumbnail${props.active ? " is-current" : ""}`} ref={itemRef} data-thumbnail-page={props.number}>
    <button type="button" aria-label={`Go to page ${props.label}`} aria-current={props.active ? "page" : undefined} onClick={() => props.onJump(props.number)}>
      <span className="vault-pdf-thumbnail-page" style={{ width: THUMBNAIL_WIDTH, height }}>
        <canvas ref={canvasRef} aria-hidden="true" style={{ width: THUMBNAIL_WIDTH, height }} hidden={!drawn} />
      </span>
      <span className="vault-pdf-thumbnail-label">{props.label}</span>
    </button>
  </li>;
}

/* ---------- Contents ---------- */

/** The PDF's bookmarks as a tree that follows the reader. Also shown in the left panel's Outline. */
export function PdfContents(props: { outline: PdfOutlineEntry[] | null; currentPage: number; labels: string[] | null; onJump: (page: number, top?: number | null) => void; inTab?: boolean }) {
  const current = useMemo(() => props.outline ? currentPdfOutlineEntry(props.outline, props.currentPage) : null, [props.outline, props.currentPage]);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const listRef = useRef<HTMLDivElement>(null);

  // The chapter being read is always shown, with the sections around it opened.
  useEffect(() => {
    if (!current?.parents.length) return;
    setOpen((was) => current.parents.every((id) => was.has(id)) ? was : new Set([...was, ...current.parents]));
  }, [current]);

  useEffect(() => {
    const list = listRef.current;
    const item = list?.querySelector<HTMLElement>(".vault-pdf-outline-entry.is-current");
    if (!list || !item) return;
    const top = item.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    if (top < list.scrollTop || top + item.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = Math.max(0, top - list.clientHeight / 3);
  }, [current, open]);

  if (props.outline === null) return <div className="vault-pdf-outline-empty" role="tabpanel" aria-label="Contents">Reading contents…</div>;
  if (!props.outline.length) return <div className="vault-pdf-outline-empty" role="tabpanel" aria-label="Contents">
    This PDF has no table of contents. Use Thumbnails to jump to a page.
  </div>;

  const toggle = (id: string) => setOpen((was) => {
    const next = new Set(was);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const render = (entries: PdfOutlineEntry[], depth: number) => <ul className="vault-pdf-outline-list" role={depth ? "group" : "tree"} aria-label={depth ? undefined : "Contents"}>
    {entries.map((entry) => {
      const expanded = open.has(entry.id);
      const isCurrent = current?.entry.id === entry.id;
      return <li key={entry.id} role="treeitem" aria-expanded={entry.items.length ? expanded : undefined} aria-selected={isCurrent}>
        <div className={`vault-pdf-outline-entry${isCurrent ? " is-current" : ""}`} style={{ paddingLeft: 4 + depth * 14 }}>
          {entry.items.length
            ? <button type="button" className="vault-pdf-outline-toggle" aria-label={`${expanded ? "Collapse" : "Expand"} ${entry.title}`} onClick={() => toggle(entry.id)}>
              <svg viewBox="0 0 16 16" aria-hidden="true" style={{ transform: expanded ? "rotate(90deg)" : undefined }}><path d="m6 4 4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
            : <span className="vault-pdf-outline-toggle" aria-hidden="true" />}
          <button type="button" className="vault-pdf-outline-title" disabled={entry.page === null} title={entry.title}
            style={{ fontWeight: entry.bold ? 600 : undefined, fontStyle: entry.italic ? "italic" : undefined }}
            onClick={() => entry.page !== null && props.onJump(entry.page, entry.top)}>
            <span>{entry.title}</span>
            {entry.page !== null ? <span className="vault-pdf-outline-page">{props.labels?.[entry.page - 1] || entry.page}</span> : null}
          </button>
        </div>
        {entry.items.length && expanded ? render(entry.items, depth + 1) : null}
      </li>;
    })}
  </ul>;
  return <div className="vault-pdf-outline" ref={listRef} role={props.inTab ? "tabpanel" : undefined} aria-label={props.inTab ? "Contents" : undefined}>{render(props.outline, 0)}</div>;
}
