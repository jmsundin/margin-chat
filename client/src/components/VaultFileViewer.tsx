import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import type { Conversation, MessageAnchorLink, SelectionDraft, VaultFileReference } from "../types";
import { useVaultMedia } from "../lib/vaultMedia";
import { loadPdfjs, openPdf } from "../lib/pdfDocuments";
import {
  imageAreaFromSourceId, imageAreaQuote, imageAreaSourceId, pdfPageFromSourceId, pdfPageSourceId, pdfPageText, vaultFileTitle,
  type ImageArea,
} from "../lib/vaultFileDocuments";
import "./VaultFileViewer.css";

export interface VaultFileViewerProps {
  conversation: Conversation;
  file: VaultFileReference;
  /** Branches, margin notes and links anchored in this document. */
  anchors: MessageAnchorLink[];
  onSelection: (selection: SelectionDraft) => void;
  onClearSelection?: () => void;
  onOpenBranch: (id: string) => void;
}

type Loaded = { status: "loading" } | { status: "missing" } | { status: "error"; message: string } | { status: "ready"; blob: Blob };

function useVaultFile(path: string): Loaded {
  const media = useVaultMedia();
  const [state, setState] = useState<Loaded>({ status: "loading" });
  useEffect(() => {
    if (!media) { setState({ status: "missing" }); return; }
    let cancelled = false;
    setState({ status: "loading" });
    media.read(path).then((file) => {
      if (!cancelled) setState(file ? { status: "ready", blob: file.blob } : { status: "missing" });
    }, (error: unknown) => {
      if (!cancelled) setState({ status: "error", message: error instanceof Error ? error.message : "This file could not be opened." });
    });
    return () => { cancelled = true; };
  }, [media, path]);
  return state;
}

/** Shows a PDF or image from the vault, with passages and areas people can select, note and ask about. */
export default function VaultFileViewer(props: VaultFileViewerProps) {
  const file = useVaultFile(props.file.path);
  const name = vaultFileTitle(props.file.path);
  if (file.status === "loading") return <div className="vault-file-status" role="status">Opening {name}…</div>;
  if (file.status === "missing") return <div className="vault-file-status">“{name}” isn’t in your vault on this device. If you moved or renamed it, open it from its new place.</div>;
  if (file.status === "error") return <div className="vault-file-status" role="alert">{file.message}</div>;
  return props.file.kind === "pdf"
    ? <PdfView {...props} blob={file.blob} />
    : <ImageView {...props} blob={file.blob} />;
}

const MIN_SCALE = 0.25;
const MAX_SCALE = 5;

function clampScale(scale: number) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(scale * 100) / 100));
}

function ZoomBar(props: { label: string; scale: number | null; fit: boolean; onScale: (scale: number) => void; onFit: () => void; children?: React.ReactNode }) {
  const percent = props.scale ? `${Math.round(props.scale * 100)}%` : "…";
  return <div className="vault-file-toolbar" role="toolbar" aria-label={`${props.label} view`}>
    {props.children}
    <span className="vault-file-toolbar-spacer" />
    <button type="button" aria-label="Zoom out" title="Zoom out" disabled={!props.scale || props.scale <= MIN_SCALE}
      onClick={() => props.scale && props.onScale(clampScale(props.scale / 1.2))}>−</button>
    <span className="vault-file-zoom" aria-live="polite">{percent}</span>
    <button type="button" aria-label="Zoom in" title="Zoom in" disabled={!props.scale || props.scale >= MAX_SCALE}
      onClick={() => props.scale && props.onScale(clampScale(props.scale * 1.2))}>+</button>
    <button type="button" aria-pressed={props.fit} title="Fit to width" onClick={props.onFit}>Fit width</button>
  </div>;
}

/* ---------- PDF ---------- */

interface PageSize { width: number; height: number }

function PdfView(props: VaultFileViewerProps & { blob: Blob }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [fit, setFit] = useState(true);
  const [scale, setScale] = useState<number | null>(null);
  const [width, setWidth] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const frameRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let close: (() => void) | null = null;
    setPdf(null); setSizes([]); setError(null);
    openPdf(props.blob).then(async (opened) => {
      close = opened.close;
      if (cancelled) { opened.close(); return; }
      const document = opened.pdf;
      const first = await document.getPage(1);
      const viewport = first.getViewport({ scale: 1 });
      if (cancelled) return;
      // Every page starts at the first page's size; the rest are measured as the reader scrolls.
      setSizes(Array.from({ length: document.numPages }, () => ({ width: viewport.width, height: viewport.height })));
      setPdf(document);
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error && reason.name === "PasswordException"
        ? "This PDF is protected by a password, so it can’t be shown here."
        : "This PDF couldn’t be read. It may be damaged.");
    });
    return () => { cancelled = true; close?.(); };
  }, [props.blob]);

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const measure = () => setWidth(frame.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [pdf]);

  const fitScale = width && sizes[0] ? clampScale((width - 2) / sizes[0].width) : null;
  const shownScale = fit ? fitScale : scale;

  function reportPage() {
    const frame = frameRef.current;
    if (!frame) return;
    const middle = frame.getBoundingClientRect().top + Math.min(window.innerHeight, frame.clientHeight) / 3;
    let page = 1;
    for (const element of frame.querySelectorAll<HTMLElement>("[data-pdf-page]")) {
      if (element.getBoundingClientRect().top <= middle) page = Number(element.dataset.pdfPage);
    }
    setCurrentPage(page);
  }
  useEffect(() => {
    const scroller = frameRef.current?.closest(".document-body");
    if (!scroller) return;
    const listener = () => reportPage();
    scroller.addEventListener("scroll", listener, { passive: true });
    return () => scroller.removeEventListener("scroll", listener);
  }, [pdf]);

  function measured(page: number, size: PageSize) {
    setSizes((current) => current[page - 1] && (current[page - 1].width !== size.width || current[page - 1].height !== size.height)
      ? current.map((item, index) => index === page - 1 ? size : item) : current);
  }

  const anchorsByPage = useMemo(() => {
    const byPage = new Map<number, MessageAnchorLink[]>();
    for (const anchor of props.anchors) {
      const page = pdfPageFromSourceId(anchor.anchor.sourceMessageId);
      if (page) byPage.set(page, [...byPage.get(page) ?? [], anchor]);
    }
    return byPage;
  }, [props.anchors]);

  if (error) return <div className="vault-file-status" role="alert">{error}</div>;
  return <section className="vault-file-viewer vault-file-pdf" aria-label={`PDF: ${props.file.path}`}>
    <ZoomBar label="PDF" scale={shownScale} fit={fit} onFit={() => setFit(true)} onScale={(next) => { setFit(false); setScale(next); }}>
      <span className="vault-file-page-count">{pdf ? `Page ${currentPage} of ${pdf.numPages}` : "Opening…"}</span>
    </ZoomBar>
    <div className="vault-file-frame" ref={frameRef}>
      {pdf && shownScale ? sizes.map((size, index) => <PdfPage key={index} pdf={pdf} number={index + 1} size={size} scale={shownScale}
        conversationId={props.conversation.id} anchors={anchorsByPage.get(index + 1) ?? []} onMeasured={measured}
        onSelection={props.onSelection} onClearSelection={props.onClearSelection} onOpenBranch={props.onOpenBranch} />)
        : <div className="vault-file-status" role="status">Opening {vaultFileTitle(props.file.path)}…</div>}
    </div>
  </section>;
}

interface PdfPageProps {
  pdf: PDFDocumentProxy;
  number: number;
  size: PageSize;
  scale: number;
  conversationId: string;
  anchors: MessageAnchorLink[];
  onMeasured: (page: number, size: PageSize) => void;
  onSelection: (selection: SelectionDraft) => void;
  onClearSelection?: () => void;
  onOpenBranch: (id: string) => void;
}

interface HighlightRect { id: string; left: number; top: number; width: number; height: number; first: boolean }

/** Text nodes and line breaks of a text layer, in reading order, with where each starts in the page text. */
function textLayerPieces(layer: HTMLElement) {
  const pieces: Array<{ node: Node; start: number; length: number }> = [];
  let offset = 0;
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) {
      const length = node.textContent?.length ?? 0;
      pieces.push({ node, start: offset, length });
      offset += length;
    } else if ((node as Element).tagName === "BR") {
      pieces.push({ node, start: offset, length: 1 });
      offset += 1;
    }
  }
  return pieces;
}

function pageOffset(layer: HTMLElement, container: Node, offset: number): number | null {
  if (!layer.contains(container)) return null;
  const pieces = textLayerPieces(layer);
  if (container.nodeType === Node.TEXT_NODE) {
    const piece = pieces.find((item) => item.node === container);
    return piece ? piece.start + Math.min(offset, piece.length) : null;
  }
  // A boundary between elements: the first piece at or after that point.
  const boundary = container.childNodes[offset] ?? null;
  if (!boundary) {
    const after = pieces.filter((piece) => container.contains(piece.node)).at(-1);
    return after ? after.start + after.length : pieces.at(-1) ? pieces.at(-1)!.start + pieces.at(-1)!.length : 0;
  }
  const next = pieces.find((piece) => piece.node === boundary || boundary.contains(piece.node)
    || (boundary.compareDocumentPosition(piece.node) & Node.DOCUMENT_POSITION_FOLLOWING));
  return next ? next.start : pieces.at(-1) ? pieces.at(-1)!.start + pieces.at(-1)!.length : 0;
}

function PdfPage(props: PdfPageProps) {
  const pageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(props.number <= 2);
  const [text, setText] = useState<string | null>(null);
  const [rendered, setRendered] = useState(0);
  const [highlights, setHighlights] = useState<HighlightRect[]>([]);
  const width = Math.floor(props.size.width * props.scale);
  const height = Math.floor(props.size.height * props.scale);

  useEffect(() => {
    const element = pageRef.current;
    if (!element || visible || typeof IntersectionObserver === "undefined") { if (!visible) setVisible(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
    }, { rootMargin: "800px 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    let page: PDFPageProxy | null = null;
    (async () => {
      const pdfjs = await loadPdfjs();
      page = await props.pdf.getPage(props.number);
      if (cancelled) return;
      const natural = page.getViewport({ scale: 1 });
      props.onMeasured(props.number, { width: natural.width, height: natural.height });
      const viewport = page.getViewport({ scale: props.scale });
      const canvas = canvasRef.current;
      const layer = layerRef.current;
      if (!canvas || !layer) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 3);
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      task = page.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined });
      const content = await page.getTextContent();
      if (cancelled) return;
      layer.replaceChildren();
      const textLayer = new pdfjs.TextLayer({ textContentSource: content, container: layer, viewport });
      await textLayer.render();
      if (cancelled) return;
      layer.style.width = `${Math.floor(viewport.width)}px`;
      layer.style.height = `${Math.floor(viewport.height)}px`;
      setText(pdfPageText(content.items as Array<{ str?: string; hasEOL?: boolean }>));
      setRendered((count) => count + 1);
      await task.promise.catch(() => undefined);
    })().catch(() => undefined);
    return () => { cancelled = true; task?.cancel(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, props.pdf, props.number, props.scale]);

  // Saved passages on this page, drawn under the selectable text.
  useLayoutEffect(() => {
    const layer = layerRef.current;
    const page = pageRef.current;
    if (!layer || !page || text === null || !rendered) { setHighlights([]); return; }
    const pieces = textLayerPieces(layer);
    const origin = page.getBoundingClientRect();
    const rects: HighlightRect[] = [];
    for (const link of props.anchors) {
      let { startOffset: start, endOffset: end } = link.anchor;
      if (link.anchor.quote && text.slice(start, end) !== link.anchor.quote) {
        const found = text.indexOf(link.anchor.quote);
        if (found < 0) continue;
        start = found; end = found + link.anchor.quote.length;
      }
      const startPiece = pieces.find((piece) => piece.node.nodeType === Node.TEXT_NODE && start < piece.start + piece.length);
      const endPiece = [...pieces].reverse().find((piece) => piece.node.nodeType === Node.TEXT_NODE && end > piece.start);
      if (!startPiece || !endPiece) continue;
      const range = document.createRange();
      range.setStart(startPiece.node, Math.max(0, start - startPiece.start));
      range.setEnd(endPiece.node, Math.min(endPiece.length, end - endPiece.start));
      let first = true;
      for (const rect of range.getClientRects()) {
        if (rect.width < 1 || rect.height < 1) continue;
        rects.push({ id: link.branchConversationId, left: rect.left - origin.left, top: rect.top - origin.top, width: rect.width, height: rect.height, first });
        first = false;
      }
    }
    setHighlights(rects);
  }, [props.anchors, text, rendered, props.scale]);

  function select() {
    const layer = layerRef.current;
    const selection = window.getSelection();
    if (!layer || text === null || !selection || selection.isCollapsed || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!layer.contains(range.startContainer) && !layer.contains(range.endContainer)) return;
    // A selection that runs past this page keeps the part on it.
    const start = layer.contains(range.startContainer) ? pageOffset(layer, range.startContainer, range.startOffset) : 0;
    const end = layer.contains(range.endContainer) ? pageOffset(layer, range.endContainer, range.endOffset) : text.length;
    if (start === null || end === null || end <= start) return;
    // Leading and trailing spaces and line breaks are not part of the passage.
    let from = start;
    let to = end;
    while (from < to && /\s/u.test(text[from])) from += 1;
    while (to > from && /\s/u.test(text[to - 1])) to -= 1;
    if (to <= from) return;
    const rect = range.getBoundingClientRect();
    props.onSelection({
      conversationId: props.conversationId, messageId: pdfPageSourceId(props.number), quote: text.slice(from, to),
      startOffset: from, endOffset: to, prompt: "", sourceKind: "message", sourceContent: text,
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    });
  }

  // Phones select by touch, which ends without a mouse-up; follow the selection itself.
  const selectRef = useRef(select);
  selectRef.current = select;
  useEffect(() => {
    let timer = 0;
    const changed = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const selection = window.getSelection();
        if (selection?.rangeCount && layerRef.current?.contains(selection.getRangeAt(0).commonAncestorContainer)) selectRef.current();
      }, 350);
    };
    document.addEventListener("selectionchange", changed);
    return () => { window.clearTimeout(timer); document.removeEventListener("selectionchange", changed); };
  }, []);

  function click(event: React.MouseEvent) {
    if (!window.getSelection()?.isCollapsed) return;
    const page = pageRef.current;
    if (!page) return;
    const origin = page.getBoundingClientRect();
    const x = event.clientX - origin.left;
    const y = event.clientY - origin.top;
    const hit = highlights.find((rect) => x >= rect.left && x <= rect.left + rect.width && y >= rect.top && y <= rect.top + rect.height);
    if (hit) props.onOpenBranch(hit.id);
  }

  return <div className="vault-pdf-page" ref={pageRef} data-pdf-page={props.number} aria-label={`Page ${props.number}`} role="group"
    style={{ width, height, ["--scale-factor" as string]: props.scale, ["--user-unit" as string]: 1, ["--total-scale-factor" as string]: props.scale,
      ["--scale-round-x" as string]: "1px", ["--scale-round-y" as string]: "1px" }}
    onMouseUp={select} onKeyUp={select} onClick={click}>
    <canvas ref={canvasRef} aria-hidden="true" />
    <div className="vault-file-highlights" aria-hidden="true">
      {highlights.map((rect, index) => <span key={`${rect.id}-${index}`} className="vault-file-highlight"
        style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
        {...(rect.first ? { "data-annotation-branches": JSON.stringify([rect.id]) } : {})} />)}
    </div>
    <div className="textLayer" ref={layerRef} />
    {!visible || text === null ? <span className="vault-pdf-page-placeholder">Page {props.number}</span> : null}
  </div>;
}

/* ---------- Images ---------- */

function ImageView(props: VaultFileViewerProps & { blob: Blob }) {
  const [url, setUrl] = useState<string | null>(null);
  const [natural, setNatural] = useState<PageSize | null>(null);
  const [fit, setFit] = useState(true);
  const [scale, setScale] = useState<number | null>(null);
  const [width, setWidth] = useState(0);
  const [picking, setPicking] = useState(false);
  const [drag, setDrag] = useState<{ x: number; y: number; toX: number; toY: number } | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const next = URL.createObjectURL(props.blob);
    setUrl(next); setNatural(null); setError(false);
    return () => URL.revokeObjectURL(next);
  }, [props.blob]);

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const measure = () => setWidth(frame.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  const fitScale = natural && width ? clampScale(Math.min(1, (width - 2) / natural.width)) : null;
  const shownScale = fit ? fitScale : scale;
  const areas = useMemo(() => props.anchors.flatMap((link) => {
    const area = imageAreaFromSourceId(link.anchor.sourceMessageId);
    return area ? [{ id: link.branchConversationId, title: link.title, area }] : [];
  }), [props.anchors]);

  function point(event: ReactPointerEvent) {
    const rect = stageRef.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)), y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)) };
  }

  function finish() {
    if (!drag || !stageRef.current) return;
    const area: ImageArea = { x: Math.min(drag.x, drag.toX), y: Math.min(drag.y, drag.toY), width: Math.abs(drag.toX - drag.x), height: Math.abs(drag.toY - drag.y) };
    setDrag(null);
    if (area.width < 0.01 || area.height < 0.01) return;
    const stage = stageRef.current.getBoundingClientRect();
    const quote = imageAreaQuote(area);
    setPicking(false);
    props.onSelection({
      conversationId: props.conversation.id, messageId: imageAreaSourceId(area), quote, startOffset: 0, endOffset: quote.length,
      prompt: "", sourceKind: "message", sourceContent: quote,
      rect: { left: stage.left + area.x * stage.width, top: stage.top + area.y * stage.height, width: area.width * stage.width, height: area.height * stage.height },
    });
  }

  const box = drag ? { x: Math.min(drag.x, drag.toX), y: Math.min(drag.y, drag.toY), width: Math.abs(drag.toX - drag.x), height: Math.abs(drag.toY - drag.y) } : null;
  return <section className="vault-file-viewer vault-file-image" aria-label={`Image: ${props.file.path}`}>
    <ZoomBar label="Image" scale={shownScale} fit={fit} onFit={() => setFit(true)} onScale={(next) => { setFit(false); setScale(next); }}>
      <button type="button" aria-pressed={picking} title="Drag across the image to pick an area to note or ask about"
        onClick={() => { setPicking((current) => !current); props.onClearSelection?.(); }}>{picking ? "Drag to pick an area…" : "Pick an area"}</button>
    </ZoomBar>
    <div className="vault-file-frame" ref={frameRef}>
      {error ? <div className="vault-file-status" role="alert">This image couldn’t be shown. It may be damaged or in a format this browser can’t open.</div> : null}
      {url && !error ? <div className={`vault-image-stage${picking ? " is-picking" : ""}`} ref={stageRef}
        style={natural && shownScale ? { width: natural.width * shownScale, height: natural.height * shownScale } : undefined}
        onPointerDown={(event) => {
          if (!picking || event.button !== 0) return;
          event.preventDefault();
          (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
          const start = point(event);
          setDrag({ x: start.x, y: start.y, toX: start.x, toY: start.y });
        }}
        onPointerMove={(event) => { if (drag) { const next = point(event); setDrag({ ...drag, toX: next.x, toY: next.y }); } }}
        onPointerUp={finish} onPointerCancel={() => setDrag(null)}>
        <img src={url} alt={vaultFileTitle(props.file.path)} draggable={false}
          onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth || 800, height: event.currentTarget.naturalHeight || 600 })}
          onError={() => setError(true)} />
        {/* The document opens a marked area's note or chat when it is clicked. */}
        {areas.map(({ id, title, area }) => <button key={id} type="button" className="vault-image-area" title={title}
          aria-label={`Open note or chat on this area: ${title}`} data-annotation-branches={JSON.stringify([id])}
          style={{ left: `${area.x * 100}%`, top: `${area.y * 100}%`, width: `${area.width * 100}%`, height: `${area.height * 100}%` }} />)}
        {box ? <span className="vault-image-area is-drawing" style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.width * 100}%`, height: `${box.height * 100}%` }} /> : null}
      </div> : null}
    </div>
  </section>;
}
