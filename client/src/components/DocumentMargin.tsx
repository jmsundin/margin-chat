import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import "./DocumentMargin.css";
import { MobileKeyboardDirect } from "./MobileKeyboard";

export interface DocumentMarginItem {
  id: string;
  /** False for a note about the whole document: it sits at the top of the margin. */
  anchored: boolean;
  node: ReactNode;
  /** What a mark's button says, in marks mode. */
  label?: string;
  /** Written by the AI, so its mark shows in the AI's ink. */
  ai?: boolean;
  /** The AI is still writing it: its passage gets a wavy underline that fills like a loading bar. */
  pending?: boolean;
}

interface Props {
  bodyRef: RefObject<HTMLDivElement | null>;
  documentId: string;
  label: string;
  items: DocumentMarginItem[];
  width: number;
  activeId?: string;
  /** The track's height in the body's scroll coordinates, so the body can scroll to the last note. */
  onHeightChange: (height: number) => void;
  /** Marks only: a dot beside each passage instead of the note; clicking a dot opens its note over the page's edge. */
  marks?: boolean;
  /** The width of an opened note in marks mode. */
  noteWidth?: number;
}

/** `left` is the note's x from the margin's left edge; set only for a note moved to the left of the text. */
type Placement = { top: number; anchorTop: number | null; left?: number; line?: AnchorLine };
/** The passage's first line, where its note's curve starts: x from the margin's left edge, y in the track. */
type AnchorLine = { start: number; end: number; y: number };
/** The left column: where its notes start and how wide they are, from the margin's left edge; null when there's no room. */
type LeftColumn = { x: number; width: number; textX: number } | null;
const GAP = 12;
/** Room on the left of the cards for the line back to each passage. */
export const DOCUMENT_MARGIN_GUTTER = 22;
/** The margin's width in marks mode: room for one dot beside the text. */
export const DOCUMENT_MARKS_WIDTH = 26;
const MARK_SIZE = 16;
/** A note pushed this far below its passage on the right goes to the left of the text instead, when there's room. */
const CROWDED = 40;
const LEFT_MIN_WIDTH = 150;
const LEFT_PAD = 16;
/** Where a note's dot sits from its top (see .margin-document-frame::before in quiet-page.css). */
const NOTE_DOT_Y = 22;

/** How far in from the note's left edge its dot is: past the editor's gutter, or at the edge without a quiet page. */
function noteDotX(aside: HTMLElement | null) {
  if (!aside?.closest(".is-quiet-page")) return 4;
  return typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse), (max-width: 700px)").matches ? 6 : 38;
}

/** Where the free room left of the text ends: the pane to the left, or the edge of the canvas. */
function leftBound(aside: HTMLElement) {
  const slot = aside.closest<HTMLElement>(".panel-slot") ?? aside.closest<HTMLElement>(".chat-panel");
  const before = slot?.previousElementSibling;
  if (before instanceof HTMLElement && before.offsetWidth) return before.getBoundingClientRect().right;
  const canvas = slot?.parentElement ?? aside.parentElement;
  return canvas ? Math.max(0, canvas.getBoundingClientRect().left) : 0;
}

/** The free room left of the text, from the margin's left edge, or null when it's too narrow for a note. */
function leftColumn(body: HTMLElement, aside: HTMLElement | null, width: number): LeftColumn {
  const text = body.querySelector<HTMLElement>(".live-document-host .cm-content") ?? body.querySelector<HTMLElement>(".live-document-host");
  if (!aside || !text) return null;
  const asideLeft = aside.getBoundingClientRect().left;
  const textLeft = text.getBoundingClientRect().left;
  const noteWidth = Math.min(width - DOCUMENT_MARGIN_GUTTER - 10, textLeft - leftBound(aside) - LEFT_PAD - DOCUMENT_MARGIN_GUTTER);
  if (noteWidth < LEFT_MIN_WIDTH) return null;
  const textX = textLeft - asideLeft;
  return { x: textX - DOCUMENT_MARGIN_GUTTER - noteWidth, width: noteWidth, textX };
}

function anchorMarks(body: HTMLElement, id: string) {
  // A checked claim's card sits beside the claim's own words.
  const claims = [...body.querySelectorAll<HTMLElement>("[data-ratchet-claim]")].filter((element) => element.dataset.ratchetClaim === id);
  if (claims.length) return claims;
  return [...body.querySelectorAll<HTMLElement>("[data-annotation-branches]")].filter((element) => {
    try { return (JSON.parse(element.dataset.annotationBranches ?? "[]") as unknown[]).includes(id); } catch { return false; }
  });
}

/** Scrolling up or down inside a note that can still scroll belongs to that note. */
function scrollsInside(target: EventTarget | null, stop: Element, deltaY: number) {
  for (let element = target instanceof Element ? target : null; element && element !== stop; element = element.parentElement) {
    if (element.scrollHeight <= element.clientHeight + 1) continue;
    const overflow = getComputedStyle(element).overflowY;
    if (overflow !== "auto" && overflow !== "scroll") continue;
    if (deltaY < 0 ? element.scrollTop > 0 : element.scrollTop + element.clientHeight < element.scrollHeight - 1) return true;
  }
  return false;
}

/**
 * Whether a tap leaves the open note open: taps inside the margin, in a menu or dialog the note
 * opened, and on the phone's keyboard button and writing bar (which a note needs to be typed in).
 */
function keepsNoteOpen(aside: HTMLElement | null, target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null;
  if (!element) return true;
  return Boolean(aside?.contains(element)
    || element.closest("[role=menu], [role=dialog], .selection-toolbar-row, [data-mobile-keyboard-toggle], [data-mobile-keyboard-bar], [data-note-sheet]"));
}

/** Phones open a note as a sheet from the bottom of the screen, over the page, instead of beside its dot. */
const NOTE_SHEET_QUERY = "(max-width: 900px)";
function useNoteSheet(marks: boolean) {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(NOTE_SHEET_QUERY).matches);
  useEffect(() => {
    if (!marks || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(NOTE_SHEET_QUERY);
    const sync = () => setNarrow(query.matches);
    sync();
    query.addEventListener?.("change", sync);
    return () => query.removeEventListener?.("change", sync);
  }, [marks]);
  return marks && narrow;
}

/**
 * The document's right margin. Each note sits level with the passage it was written on and
 * scrolls with the text; notes about the whole document come first, at the top. When notes
 * would overlap, later ones move down and a line keeps them tied to their passage.
 */
export default function DocumentMargin({ bodyRef, documentId, label, items, width, activeId, onHeightChange, marks = false, noteWidth = 280 }: Props) {
  const asideRef = useRef<HTMLElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Record<string, HTMLElement | null>>({});
  const [placements, setPlacements] = useState<Record<string, Placement>>({});
  const [left, setLeft] = useState<LeftColumn>(null);
  const [height, setHeight] = useState(0);
  const [hoverId, setHoverId] = useState<string | null>(null);
  /** The note whose passage the pointer is on: it lights up here, in place of a hover card over the text. */
  const [passageHoverId, setPassageHoverId] = useState<string | null>(null);
  /** Marks mode: the note opened from its dot. */
  const [openId, setOpenId] = useState<string | null>(null);
  /** On phones the open note is a sheet: half the screen, so its passage stays in view above it, or all of it. */
  const sheet = useNoteSheet(marks);
  const [sheetFull, setSheetFull] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!openId) setSheetFull(false); }, [openId]);
  const frame = useRef(0);
  const itemKey = items.map((item) => `${item.id}:${item.anchored ? 1 : 0}`).join("|");
  const heightCallback = useRef(onHeightChange);
  heightCallback.current = onHeightChange;

  const syncScroll = useCallback(() => {
    const body = bodyRef.current, track = trackRef.current;
    if (body && track) track.style.transform = `translateY(${-body.scrollTop}px)`;
  }, [bodyRef]);

  const layout = useCallback(() => {
    const body = bodyRef.current;
    if (!body) return;
    const bodyTop = body.getBoundingClientRect().top - body.scrollTop;
    const start = Number.parseFloat(getComputedStyle(body).paddingTop) || GAP;
    const asideLeft = asideRef.current?.getBoundingClientRect().left ?? 0;
    const measured = items.map((item, index) => {
      const found = item.anchored ? anchorMarks(body, item.id) : [];
      const mark = found[0];
      // The passage's first line: its words run from the first box's left to the last box on that line.
      const boxes = marks ? [] : found.flatMap((element) => [...element.getClientRects()]).filter((box) => box.width > 0);
      const first = boxes[0];
      const onLine = first ? boxes.filter((box) => Math.abs(box.top - first.top) < first.height / 2) : [];
      const line = first ? { start: Math.round(Math.min(...onLine.map((box) => box.left)) - asideLeft),
        end: Math.round(Math.max(...onLine.map((box) => box.right)) - asideLeft), y: Math.round(first.top + first.height / 2 - bodyTop) } : undefined;
      return { id: item.id, index, anchorTop: mark ? mark.getBoundingClientRect().top - bodyTop : null, line,
        height: marks ? MARK_SIZE : itemRefs.current[item.id]?.offsetHeight ?? 0 };
    });
    // Whole-document notes (and notes whose passage is gone) first, then notes in passage order.
    measured.sort((a, b) => (a.anchorTop === null ? -1 : 0) - (b.anchorTop === null ? -1 : 0)
      || (a.anchorTop ?? 0) - (b.anchorTop ?? 0) || a.index - b.index);
    // When the right margin is crowded, a note goes to the left of the text, level with its passage.
    const column = marks ? null : leftColumn(body, asideRef.current, width);
    let cursor = start, leftCursor = start;
    const next: Record<string, Placement> = {};
    for (const item of measured) {
      const wanted = item.anchorTop === null ? start : item.anchorTop + (marks ? 6 : -4);
      const top = Math.max(cursor, wanted);
      const leftTop = Math.max(leftCursor, wanted);
      if (column && item.anchorTop !== null && top - wanted > CROWDED && leftTop < top) {
        next[item.id] = { top: leftTop, anchorTop: item.anchorTop, left: column.x, line: item.line };
        leftCursor = leftTop + item.height + GAP;
        continue;
      }
      next[item.id] = { top, anchorTop: item.anchorTop, line: item.line };
      cursor = top + item.height + (marks ? 4 : GAP);
    }
    const end = Math.max(cursor, leftCursor);
    setPlacements((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
    setLeft((current) => JSON.stringify(current) === JSON.stringify(column) ? current : column);
    setHeight((current) => current === end ? current : end);
    syncScroll();
  }, [bodyRef, itemKey, syncScroll, marks, width]);

  const schedule = useCallback(() => {
    window.cancelAnimationFrame(frame.current);
    frame.current = window.requestAnimationFrame(layout);
  }, [layout]);

  useLayoutEffect(layout, [layout]);
  useEffect(() => { heightCallback.current(height); }, [height]);
  useEffect(() => () => heightCallback.current(0), []);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    body.addEventListener("scroll", syncScroll, { passive: true });
    // Typing, decorations and lazy editors move passages; resizing a note moves the notes below it.
    const mutations = typeof MutationObserver === "undefined" ? null : new MutationObserver(schedule);
    mutations?.observe(body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-annotation-branches", "data-ratchet-claim", "class", "style"] });
    const sizes = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    sizes?.observe(body);
    for (const child of body.children) sizes?.observe(child);
    for (const element of Object.values(itemRefs.current)) if (element) sizes?.observe(element);
    window.addEventListener("resize", schedule);
    return () => {
      body.removeEventListener("scroll", syncScroll);
      mutations?.disconnect(); sizes?.disconnect();
      window.removeEventListener("resize", schedule);
      window.cancelAnimationFrame(frame.current);
    };
  }, [bodyRef, schedule, syncScroll, itemKey]);

  const itemIds = useRef<string[]>([]);
  itemIds.current = items.map((item) => item.id);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const noteAt = (target: EventTarget | null) => {
      const mark = target instanceof Element ? target.closest<HTMLElement>(".message-anchor[data-annotation-branches]") : null;
      if (!mark || !body.contains(mark)) return null;
      try {
        const ids: unknown = JSON.parse(mark.dataset.annotationBranches ?? "[]");
        return Array.isArray(ids) ? ids.find((id): id is string => typeof id === "string" && itemIds.current.includes(id)) ?? null : null;
      } catch { return null; }
    };
    const over = (event: PointerEvent) => { if (event.pointerType !== "touch") setPassageHoverId(noteAt(event.target)); };
    const out = (event: PointerEvent) => { if (!noteAt(event.relatedTarget)) setPassageHoverId(null); };
    body.addEventListener("pointerover", over);
    body.addEventListener("pointerout", out);
    return () => { body.removeEventListener("pointerover", over); body.removeEventListener("pointerout", out); };
  }, [bodyRef]);

  // Marks mode: a note chosen elsewhere (Children menu, search, a new question) opens from its dot.
  useEffect(() => { if (marks && activeId && items.some((item) => item.id === activeId)) setOpenId(activeId); }, [marks, activeId, itemKey]);
  useEffect(() => { if (!marks) setOpenId(null); }, [marks]);
  useEffect(() => {
    if (!marks || !openId) return;
    const close = (event: PointerEvent) => { if (!keepsNoteOpen(asideRef.current, event.target)) setOpenId(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && (asideRef.current?.contains(document.activeElement) || sheetRef.current?.contains(document.activeElement))) setOpenId(null); };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close, true); document.removeEventListener("keydown", escape); };
  }, [marks, openId]);

  // Clicking a note opens it a little wider, and only then is its line back to the passage drawn.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /** Notes already drawn in place: only these glide when they move, so a new note doesn't fly in from the top. */
  const placedIds = useRef(new Set<string>());
  useEffect(() => { for (const id of Object.keys(placements)) placedIds.current.add(id); }, [placements]);
  useEffect(() => { if (!marks && activeId && items.some((item) => item.id === activeId)) setExpandedId(activeId); }, [marks, activeId, itemKey]);
  useEffect(() => { if (expandedId && !items.some((item) => item.id === expandedId)) setExpandedId(null); }, [expandedId, itemKey]);
  useEffect(() => {
    if (marks || !expandedId) return;
    const close = (event: PointerEvent) => { if (!keepsNoteOpen(asideRef.current, event.target)) setExpandedId(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && asideRef.current?.contains(document.activeElement)) setExpandedId(null); };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close, true); document.removeEventListener("keydown", escape); };
  }, [marks, expandedId]);
  // It grows into the free room right of the page, up to half again as wide, so the text never moves.
  const [expandBy, setExpandBy] = useState(0);
  useLayoutEffect(() => {
    const aside = asideRef.current;
    if (!expandedId || !aside || placements[expandedId]?.left !== undefined) { setExpandBy(0); return; }
    const measure = () => setExpandBy(Math.max(0, Math.min(Math.round(width * 0.5), Math.floor(window.innerWidth - aside.getBoundingClientRect().right - 16))));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [expandedId, width, placements[expandedId ?? ""]?.left]);

  // The passage of the note being read or pointed at stays lit in the text. The editor owns
  // its DOM and would undo a class added to the passage, so a scoped style rule lights it.
  const linkedId = hoverId ?? passageHoverId ?? (marks ? openId : null) ?? (activeId && items.some((item) => item.id === activeId) ? activeId : null);
  const escape = (value: string) => typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
  const pendingRule = items.filter((item) => item.pending).map((item) =>
    `.document-panel-content:has(> .document-margin[data-margin-notes-for="${escape(documentId)}"]) > .document-body .message-anchor[data-annotation-branches*='"${escape(item.id)}"']`).join(",");
  const linkedRule = (linkedId ? `.document-panel-content:has(> .document-margin[data-margin-notes-for="${escape(documentId)}"]) > .document-body .message-anchor[data-annotation-branches*='"${escape(linkedId)}"'] { background: var(--margin-linked-passage); box-shadow: 0 1.5px 0 var(--margin-linked-line); }` : "")
    // Placed after the hover rule so a passage being thought about keeps its wave.
    + (pendingRule ? `${pendingRule} { background: var(--margin-thinking-wave) 0 100% / var(--margin-thinking-at) 5px no-repeat; box-shadow: none; text-decoration: none; padding-bottom: 4px; animation: margin-note-thinking 9s cubic-bezier(.15,.7,.3,1) forwards; }` : "");

  // Choosing a note somewhere else (tabs, search, the Children menu) scrolls the text to it once.
  // Clicking into a note in the margin leaves the text where it is.
  const scrollTarget = useRef<string | null>(null);
  const pointerInside = useRef(0);
  useEffect(() => {
    const inMargin = Date.now() - pointerInside.current < 500 || (asideRef.current?.contains(document.activeElement) ?? false);
    scrollTarget.current = activeId && !inMargin ? activeId : null;
  }, [activeId]);
  useEffect(() => {
    const id = scrollTarget.current, body = bodyRef.current, placement = id ? placements[id] : undefined;
    if (!id || !body || !placement) return;
    scrollTarget.current = null;
    const top = Math.min(placement.top, placement.anchorTop ?? placement.top);
    const bottom = placement.top + (itemRefs.current[id]?.offsetHeight ?? 0);
    if (top < body.scrollTop || bottom > body.scrollTop + body.clientHeight) body.scrollTop = Math.max(0, top - 24);
    syncScroll();
  }, [activeId, placements]);

  if (marks) return <aside className="document-margin is-marks" ref={asideRef} aria-label={label} data-margin-notes-for={documentId}
    style={{ width, flexBasis: width }}
    onPointerDownCapture={() => { pointerInside.current = Date.now(); }}
    onWheel={(event) => {
      const body = bodyRef.current;
      if (!body || scrollsInside(event.target, event.currentTarget, event.deltaY)) return;
      body.scrollTop += event.deltaY;
    }}>
    {linkedRule ? <style>{linkedRule}</style> : null}
    <div className="document-margin-track" ref={trackRef} style={{ height }}>
      {items.map((item) => {
        const placement = placements[item.id];
        const open = openId === item.id;
        return <div key={item.id} className="document-margin-mark-slot" style={{ top: placement?.top ?? 0, visibility: placement ? undefined : "hidden" }}>
          <button type="button" className={`document-margin-mark${item.ai ? " is-ai" : ""}${open ? " is-open" : ""}${item.id === passageHoverId ? " is-pointed" : ""}`}
            ref={(element) => { itemRefs.current[item.id] = element; }}
            aria-expanded={open} aria-label={`${open ? "Close" : "Open"} note: ${item.label || "Margin note"}`} title={item.label}
            onPointerEnter={() => setHoverId(item.id)} onPointerLeave={() => setHoverId((current) => current === item.id ? null : current)}
            onClick={() => setOpenId((current) => current === item.id ? null : item.id)} />
          {open && sheet ? createPortal(<div className={`note-sheet${sheetFull ? " is-full" : ""}`} ref={sheetRef} data-note-sheet
            data-margin-note-id={item.id} data-mobile-keyboard-direct role="dialog" aria-label={`Note: ${item.label || "Margin note"}`}>
            <button type="button" className="note-sheet-handle" aria-expanded={sheetFull}
              aria-label={sheetFull ? "Show the page above the note" : "Make the note full screen"}
              onClick={() => setSheetFull((full) => !full)}><span aria-hidden="true" /></button>
            {sheetFull ? <button type="button" className="note-sheet-back" onClick={() => setOpenId(null)}>‹ {label.replace(/^Notes for /, "")}</button>
              : item.anchored ? null : <span className="document-margin-label">About this document</span>}
            <div className="note-sheet-body"><MobileKeyboardDirect>{item.node}</MobileKeyboardDirect></div>
          </div>, asideRef.current?.closest(".app-shell") ?? document.body) : null}
          {open && !sheet ? <div className="document-margin-mark-note" data-margin-note-id={item.id} data-mobile-keyboard-direct style={{ width: noteWidth }}
            onPointerEnter={() => setHoverId(item.id)} onPointerLeave={() => setHoverId((current) => current === item.id ? null : current)}>
            {item.anchored ? null : <span className="document-margin-label">About this document</span>}
            <MobileKeyboardDirect>{item.node}</MobileKeyboardDirect>
          </div> : null}
        </div>;
      })}
    </div>
  </aside>;

  const usesLeft = Boolean(left && Object.values(placements).some((placement) => placement.left !== undefined));
  return <aside className={`document-margin${usesLeft ? " has-left-notes" : ""}`} ref={asideRef} aria-label={label} data-margin-notes-for={documentId}
    style={{ width, flexBasis: width }}
    onPointerDownCapture={() => { pointerInside.current = Date.now(); }}
    onWheel={(event) => {
      const body = bodyRef.current;
      if (!body || scrollsInside(event.target, event.currentTarget, event.deltaY)) return;
      body.scrollTop += event.deltaY;
    }}>
    {linkedRule ? <style>{linkedRule}</style> : null}
    <div className="document-margin-track" ref={trackRef} style={{ height }}>
      <svg className="document-margin-links" width={DOCUMENT_MARGIN_GUTTER} height={height} aria-hidden="true">
        {items.map((item) => {
          const placement = placements[item.id];
          if (!placement || placement.anchorTop === null || item.id !== expandedId) return null;
          // One smooth curve from the end of the passage's first line to the note's dot, level at both
          // ends, so it leaves the words and meets the note head on.
          const curve = (x1: number, y1: number, x2: number, y2: number) => {
            const bend = (x2 - x1) * 0.5;
            return `M${x1} ${y1} C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`;
          };
          const line = placement.line;
          const from = line?.y ?? placement.anchorTop + 10, to = placement.top + NOTE_DOT_Y;
          // A note on the left: from its right edge across to the start of the passage's line.
          const d = placement.left !== undefined && left
            ? curve(left.x + left.width + 4, to, (line?.start ?? left.textX) - 4, from)
            : curve(Math.min(line ? line.end + 6 : 0, DOCUMENT_MARGIN_GUTTER - 8), from, DOCUMENT_MARGIN_GUTTER + noteDotX(asideRef.current) - 5, to);
          return <path key={item.id} className={item.id === linkedId ? "is-linked" : undefined} d={d} />;
        })}
      </svg>
      {items.map((item) => {
        const placement = placements[item.id];
        const onLeft = placement?.left !== undefined && left;
        return <div key={item.id} className={`document-margin-item${placement?.anchorTop === null ? " is-document-note" : ""}${item.id === expandedId ? " is-expanded" : ""}${item.id === passageHoverId ? " is-pointed" : ""}${onLeft ? " is-left" : ""}${placement && placedIds.current.has(item.id) ? "" : " is-placing"}`}
          data-margin-note-id={item.id} ref={(element) => { itemRefs.current[item.id] = element; }}
          onPointerDownCapture={() => setExpandedId(item.id)}
          style={{ top: placement?.top ?? 0, left: onLeft ? left.x : DOCUMENT_MARGIN_GUTTER, visibility: placement ? undefined : "hidden",
            ...(onLeft ? { right: "auto", width: left.width } : item.id === expandedId && expandBy ? { right: 10 - expandBy } : {}) }}
          onPointerEnter={() => setHoverId(item.id)} onPointerLeave={() => setHoverId((current) => current === item.id ? null : current)}>
          {item.anchored ? null : <span className="document-margin-label">About this document</span>}
          {item.node}
        </div>;
      })}
    </div>
  </aside>;
}
