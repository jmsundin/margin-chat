import OpenBesideIcon from "./OpenBesideIcon";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type CSSProperties, type ReactNode, type RefObject } from "react";
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
  /**
   * A written note (not a card such as a checked claim): when a page has more than one, each folds
   * to one line, its `label`, level with its passage, and opens when clicked.
   */
  foldable?: boolean;
  /** Opens the note beside the page; a folded line shows the button when you point at it. */
  onOpenBeside?: () => void;
  /** The note's name (the AI names a note once it has words); unset while it still has a placeholder name. */
  title?: string;
  /** When the note was started, shown under its name while it's open. */
  createdAt?: string;
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
const GAP = 8;
/** Between folded notes: just enough that notes on neighbouring lines don't touch. */
const FOLDED_GAP = 2;
/** Room on the left of the cards for the line back to each passage. */
export const DOCUMENT_MARGIN_GUTTER = 22;
/** The margin's width in bubbles mode: room for a short bubble with the first words of each note. */
export const DOCUMENT_MARKS_WIDTH = 136;
/**
 * On a phone the margin takes no room: a note on a passage is that passage, underlined, and a tap on it
 * opens the note; a note about the whole page is a tab tucked part-way off the screen's edge showing the
 * first letters of its title, which slides out to show the whole title when you swipe the tabs left (or tap one).
 */
export const DOCUMENT_MARKS_PHONE_WIDTH = 0;
/** How far a finger has to move sideways on the phone's note tabs to slide them out or back in. */
export const TAB_SWIPE_PX = 24;
/** Gap kept between the end of the page's text and a tucked tab, and the narrowest a tucked tab gets. */
export const TAB_TEXT_GAP_PX = 4;
export const TAB_MIN_PEEK_PX = 14;

/** How much of a tucked tab shows: the margin to the right of the page's text, less a small gap. */
export function tabPeekWidth(edgeRight: number, textRight: number): number {
  return Math.max(TAB_MIN_PEEK_PX, Math.round(edgeRight - textRight - TAB_TEXT_GAP_PX));
}
const MARK_SIZE = 26;
/** Between bubbles on neighbouring lines. */
const BUBBLE_GAP = 4;
/** A note pushed this far below its passage on the right goes to the left of the text instead, when there's room. */
const CROWDED = 40;
const LEFT_MIN_WIDTH = 150;
const LEFT_PAD = 16;
/** Where a note's dot sits from its top (see .margin-document-frame::before in quiet-page.css). */
const NOTE_DOT_Y = 22;

/** What a bubble says: the note's name once it has one, otherwise its first words, without the markdown that starts a line. */
function bubbleText(item: DocumentMarginItem) {
  if (item.title?.trim()) return item.title.trim();
  const text = (item.label ?? "").replace(/^\s*(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|>\s*|\d+[.)]\s+)/, "").replace(/[*_`~]+/g, "").trim();
  return text || (item.pending ? "Thinking…" : "Margin note");
}

/** "Today, 2:45 PM", "Yesterday, 9:10 AM", "Nov 18, 2:45 PM", or with the year when it isn't this year. */
export function noteTimeLabel(iso: string | undefined, now = new Date()): string {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const day = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((day(now) - day(date)) / 86_400_000);
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  const sameYear = date.getFullYear() === now.getFullYear();
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) })}, ${time}`;
}

/**
 * The top of an open note: its name and when it was started, quietly, above the words.
 * A note about the whole document says so under its name.
 */
function NoteHead({ item }: { item: DocumentMarginItem }) {
  const time = noteTimeLabel(item.createdAt);
  const title = item.title?.trim();
  return <div className="document-margin-note-head">
    <span className={`document-margin-note-title${title ? "" : " is-unnamed"}`}>{title || (item.pending ? "Thinking…" : "New note")}</span>
    <span className="document-margin-note-time">{[item.anchored ? "" : "About this document", time].filter(Boolean).join(" · ")}</span>
  </div>;
}

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

/** The note a tap or pointer is on: the first of the passage's notes that is in this margin. */
function noteAtTarget(body: HTMLElement, target: EventTarget | null, ids: readonly string[]) {
  const mark = target instanceof Element ? target.closest<HTMLElement>(".message-anchor[data-annotation-branches]") : null;
  if (!mark || !body.contains(mark)) return null;
  try {
    const found: unknown = JSON.parse(mark.dataset.annotationBranches ?? "[]");
    return Array.isArray(found) ? found.find((id): id is string => typeof id === "string" && ids.includes(id)) ?? null : null;
  } catch { return null; }
}

function anchorMarks(body: HTMLElement, id: string) {
  // A checked claim's card sits beside the claim's own words.
  const claims = [...body.querySelectorAll<HTMLElement>("[data-ratchet-claim]")].filter((element) => element.dataset.ratchetClaim === id);
  if (claims.length) return claims;
  return [...body.querySelectorAll<HTMLElement>("[data-annotation-branches]")].filter((element) => {
    try { return (JSON.parse(element.dataset.annotationBranches ?? "[]") as unknown[]).includes(id); } catch { return false; }
  });
}

/**
 * Beside an HTML page the page itself never scrolls (it fills the panel), so the margin scrolls on
 * its own there: otherwise a long note, or many notes, run off the bottom with no way to reach them.
 */
function scrollsItself(aside: HTMLElement) {
  return getComputedStyle(aside).overflowY === "auto";
}

/** How far an open note can widen past the margin's right edge: up to the window's edge, but
 *  never over another document open beside this one (a side document or a note opened beside). */
export function freeRoomRight(aside: HTMLElement, gap = 16) {
  const rect = aside.getBoundingClientRect();
  let edge = window.innerWidth;
  const own = aside.closest(".panel-slot");
  if (own) {
    for (const slot of document.querySelectorAll<HTMLElement>(".panel-slot")) {
      if (slot === own || slot.contains(own) || own.contains(slot)) continue;
      const box = slot.getBoundingClientRect();
      if (box.width <= 0 || box.bottom <= rect.top || box.top >= rect.bottom) continue;
      if (box.left >= rect.right - 1) edge = Math.min(edge, box.left);
    }
  }
  return Math.max(0, edge - rect.right - gap);
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
 * opened, on the phone's keyboard button and writing bar (which a note needs to be typed in), and in
 * the phone's Ask AI prompt, which opens over the keyboard outside the note.
 */
export function keepsNoteOpen(aside: HTMLElement | null, target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null;
  if (!element) return true;
  return Boolean(aside?.contains(element)
    || element.closest("[role=menu], [role=dialog], .selection-toolbar-row, [data-mobile-keyboard-toggle], [data-mobile-keyboard-bar], [data-mobile-composer], [data-note-sheet]"));
}

/**
 * Where a note sheet comes to rest after its handle is dragged, as a share of the screen's height:
 * a short peek, half (the default, so the passage stays in view above), or the whole screen.
 * Dragged well below the peek, it closes. A quick flick goes one stop in the flick's direction.
 */
export const NOTE_SHEET_STOPS = [0.3, 0.52, 1] as const;
export type NoteSheetStop = 0 | 1 | 2;
export function noteSheetRest(height: number, viewport: number, velocity = 0): NoteSheetStop | "close" {
  const share = viewport > 0 ? height / viewport : NOTE_SHEET_STOPS[1];
  if (share < NOTE_SHEET_STOPS[0] * 0.6) return "close";
  let nearest: NoteSheetStop = 0;
  NOTE_SHEET_STOPS.forEach((stop, index) => {
    if (Math.abs(stop - share) < Math.abs(NOTE_SHEET_STOPS[nearest] - share)) nearest = index as NoteSheetStop;
  });
  // velocity is px/ms, positive = growing taller.
  if (Math.abs(velocity) > 0.5) {
    const above = NOTE_SHEET_STOPS.findIndex((stop) => stop > share + 0.01);
    if (velocity > 0) return (above === -1 ? 2 : above) as NoteSheetStop;
    const below = [...NOTE_SHEET_STOPS].reverse().findIndex((stop) => stop < share - 0.01);
    return below === -1 ? "close" : (NOTE_SHEET_STOPS.length - 1 - below) as NoteSheetStop;
  }
  return nearest;
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
  /** Which of NOTE_SHEET_STOPS the sheet rests at; dragging its handle moves it between them. */
  const [sheetStop, setSheetStop] = useState<NoteSheetStop>(1);
  const sheetFull = sheetStop === 2;
  /** The sheet's height in px while its handle is being dragged. */
  const [sheetDrag, setSheetDrag] = useState<number | null>(null);
  const sheetDragStart = useRef<{ pointer: number; y: number; height: number; moved: boolean; samples: { y: number; t: number }[] } | null>(null);
  /** Set when a drag ends, so the click the browser sends after it does not also toggle the sheet. */
  const sheetDragged = useRef(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!openId) { setSheetStop(1); setSheetDrag(null); } }, [openId]);
  const sheetHandleDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !sheetRef.current) return;
    sheetDragStart.current = { pointer: event.pointerId, y: event.clientY, height: sheetRef.current.getBoundingClientRect().height, moved: false, samples: [{ y: event.clientY, t: event.timeStamp }] };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* the pointer may already be gone */ }
  };
  const sheetHandleMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = sheetDragStart.current;
    if (!start || start.pointer !== event.pointerId) return;
    const dy = event.clientY - start.y;
    if (!start.moved && Math.abs(dy) < 6) return;
    start.moved = true;
    start.samples = [...start.samples.slice(-4), { y: event.clientY, t: event.timeStamp }];
    event.preventDefault();
    setSheetDrag(Math.max(48, Math.min(window.innerHeight, start.height - dy)));
  };
  const sheetHandleEnd = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = sheetDragStart.current;
    if (!start || start.pointer !== event.pointerId) return;
    sheetDragStart.current = null;
    if (!start.moved) return; // a tap: the click toggles half and full screen
    sheetDragged.current = true;
    window.setTimeout(() => { sheetDragged.current = false; }, 400);
    const first = start.samples[0], last = start.samples[start.samples.length - 1];
    const velocity = last.t > first.t ? (first.y - last.y) / (last.t - first.t) : 0;
    const height = Math.max(48, Math.min(window.innerHeight, start.height - (event.clientY - start.y)));
    const rest = event.type === "pointercancel" ? sheetStop : noteSheetRest(height, window.innerHeight, velocity);
    setSheetDrag(null);
    if (rest === "close") setOpenId(null);
    else setSheetStop(rest);
  };
  /** A drag ends without a click; only a plain tap toggles. */
  const sheetHandleClick = (_event: ReactMouseEvent<HTMLButtonElement>) => {
    if (sheetDragged.current) { sheetDragged.current = false; return; }
    setSheetStop((stop) => stop === 2 ? 1 : 2);
  };
  const frame = useRef(0);
  const itemKey = items.map((item) => `${item.id}:${item.anchored ? 1 : 0}`).join("|");
  // Clicking a note opens it a little wider, and only then is its line back to the passage drawn.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /** With more than one note, every note but the open one folds to a line beside its passage. */
  const folds = !marks && items.filter((item) => item.foldable).length > 1;
  const isFolded = (item: DocumentMarginItem) => folds && Boolean(item.foldable) && item.id !== expandedId;
  const foldedKey = items.filter(isFolded).map((item) => item.id).join("|");
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
    const folded = new Set(foldedKey ? foldedKey.split("|") : []);
    const measured = items.map((item, index) => {
      const found = item.anchored ? anchorMarks(body, item.id) : [];
      const mark = found[0];
      // The passage's first line: its words run from the first box's left to the last box on that line.
      const boxes = found.flatMap((element) => [...element.getClientRects()]).filter((box) => box.width > 0);
      const first = boxes[0];
      const onLine = first ? boxes.filter((box) => Math.abs(box.top - first.top) < first.height / 2) : [];
      const line = first ? { start: Math.round(Math.min(...onLine.map((box) => box.left)) - asideLeft),
        end: Math.round(Math.max(...onLine.map((box) => box.right)) - asideLeft), y: Math.round(first.top + first.height / 2 - bodyTop) } : undefined;
      return { id: item.id, index, anchorTop: mark ? mark.getBoundingClientRect().top - bodyTop : null, line,
        folded: folded.has(item.id), height: marks ? itemRefs.current[item.id]?.offsetHeight || MARK_SIZE : itemRefs.current[item.id]?.offsetHeight ?? 0 };
    });
    // Whole-document notes (and notes whose passage is gone) first, then notes in passage order.
    measured.sort((a, b) => (a.anchorTop === null ? -1 : 0) - (b.anchorTop === null ? -1 : 0)
      || (a.anchorTop ?? 0) - (b.anchorTop ?? 0) || a.index - b.index);
    // When the right margin is crowded, a note goes to the left of the text, level with its passage.
    const column = marks ? null : leftColumn(body, asideRef.current, width);
    let cursor = start, leftCursor = start;
    const next: Record<string, Placement> = {};
    for (const item of measured) {
      // A folded note's one line sits on its passage's first line, centred on it.
      const wanted = item.anchorTop === null ? start
        // A folded note's line and a bubble sit on their passage's first line, centred on it.
        : item.folded || marks ? (item.line ? item.line.y - item.height / 2 : item.anchorTop)
        : item.anchorTop - 4;
      const gap = item.folded ? FOLDED_GAP : GAP;
      const top = Math.max(cursor, wanted);
      const leftTop = Math.max(leftCursor, wanted);
      // A folded line just steps down under the open note: sending it across the page would be a jump.
      if (column && !item.folded && item.anchorTop !== null && top - wanted > CROWDED && leftTop < top) {
        next[item.id] = { top: leftTop, anchorTop: item.anchorTop, left: column.x, line: item.line };
        leftCursor = leftTop + item.height + gap;
        continue;
      }
      next[item.id] = { top, anchorTop: item.anchorTop, line: item.line };
      cursor = top + item.height + (marks ? BUBBLE_GAP : gap);
    }
    const end = Math.max(cursor, leftCursor);
    setPlacements((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
    setLeft((current) => JSON.stringify(current) === JSON.stringify(column) ? current : column);
    setHeight((current) => current === end ? current : end);
    syncScroll();
  }, [bodyRef, itemKey, foldedKey, syncScroll, marks, width]);

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
    const noteAt = (target: EventTarget | null) => noteAtTarget(body, target, itemIds.current);
    const over = (event: PointerEvent) => { if (event.pointerType !== "touch") setPassageHoverId(noteAt(event.target)); };
    const out = (event: PointerEvent) => { if (!noteAt(event.relatedTarget)) setPassageHoverId(null); };
    body.addEventListener("pointerover", over);
    body.addEventListener("pointerout", out);
    return () => { body.removeEventListener("pointerover", over); body.removeEventListener("pointerout", out); };
  }, [bodyRef]);

  // Phones: a noted passage is the note's button. A tap on it opens the note's sheet instead of
  // putting the caret there (the keyboard would cover the sheet); the rest of the line edits as usual.
  useEffect(() => {
    const body = bodyRef.current;
    if (!sheet || !body) return;
    const hold = (event: Event) => { if (noteAtTarget(body, event.target, itemIds.current)) { event.preventDefault(); event.stopPropagation(); } };
    const open = (event: MouseEvent) => {
      const id = noteAtTarget(body, event.target, itemIds.current);
      if (!id) return;
      event.preventDefault(); event.stopPropagation();
      setOpenId(id);
    };
    body.addEventListener("mousedown", hold, true);
    body.addEventListener("click", open, true);
    return () => { body.removeEventListener("mousedown", hold, true); body.removeEventListener("click", open, true); };
  }, [bodyRef, sheet]);

  // A note about the whole page has no passage to underline, so it's a tab at the screen's edge.
  // Swiping the tabs left (or tapping one) slides them all out far enough to read each note's whole
  // title, without covering the page until you ask; tapping a title then opens that note. A swipe
  // right, a tap on the page or Escape tucks them back in.
  const [tabsOut, setTabsOut] = useState(false);
  const tabSwipe = useRef<{ x: number; y: number; id: number; slid: boolean } | null>(null);
  useEffect(() => { setTabsOut(false); }, [documentId, sheet]);
  // Tucked, a tab sticks out only as far as the margin beside the page's text.
  const [tabPeek, setTabPeek] = useState<number | null>(null);
  const hasTabs = sheet && marks && Object.values(placements).some((placement) => placement.anchorTop === null);
  useLayoutEffect(() => {
    if (!hasTabs) return;
    const measure = () => {
      const body = bodyRef.current, aside = asideRef.current;
      if (!body || !aside) return;
      const edge = Math.min(aside.getBoundingClientRect().right, document.documentElement.clientWidth);
      const line = body.querySelector(".cm-line, .live-document-block, p");
      let textRight: number;
      if (line instanceof HTMLElement && line.getBoundingClientRect().width > 0) {
        textRight = line.getBoundingClientRect().right - (parseFloat(getComputedStyle(line).paddingRight) || 0);
      } else {
        textRight = body.getBoundingClientRect().right - (parseFloat(getComputedStyle(body).paddingRight) || 0);
      }
      setTabPeek(tabPeekWidth(edge, textRight));
    };
    measure();
    // The text column settles after the editor lays out (and moves when the page resizes).
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    const body = bodyRef.current;
    if (observer && body) { observer.observe(body); const host = body.firstElementChild; if (host) observer.observe(host); }
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [hasTabs, bodyRef, width, itemKey]);
  useEffect(() => {
    if (!tabsOut) return;
    const tuck = (event: PointerEvent) => {
      if (!(event.target instanceof Element && event.target.closest(".document-margin-mark.is-tab"))) setTabsOut(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setTabsOut(false); };
    document.addEventListener("pointerdown", tuck, true);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", tuck, true); document.removeEventListener("keydown", escape); };
  }, [tabsOut]);
  const tabPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    tabSwipe.current = { x: event.clientX, y: event.clientY, id: event.pointerId, slid: false };
  };
  const tabPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = tabSwipe.current;
    if (!start || start.id !== event.pointerId || start.slid) return;
    const dx = event.clientX - start.x;
    if (Math.abs(dx) < TAB_SWIPE_PX || Math.abs(dx) < Math.abs(event.clientY - start.y)) return;
    start.slid = true;
    setTabsOut(dx < 0);
  };
  /** A tap on a tucked tab slides the tabs out; a tap on a title opens its note. A swipe does neither. */
  const tabClick = (id: string) => {
    const swiped = tabSwipe.current?.slid;
    tabSwipe.current = null;
    if (swiped) return;
    if (!tabsOut) { setTabsOut(true); return; }
    setTabsOut(false);
    setOpenId(id);
  };

  // A bubble's note opens out to the right, over the bubble, when there's room beside the page;
  // otherwise it opens over the page's edge to the left.
  const [openRight, setOpenRight] = useState(true);
  useLayoutEffect(() => {
    const aside = asideRef.current;
    if (!marks || !openId || !aside) return;
    setOpenRight(freeRoomRight(aside, 8) + aside.offsetWidth >= noteWidth);
  }, [marks, openId, noteWidth, width]);
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
    // A margin that scrolls by itself (beside an HTML page) clips sideways, so its note can't widen out.
    const measure = () => setExpandBy(scrollsItself(aside) ? 0 : Math.max(0, Math.min(Math.round(width * 0.5), Math.floor(freeRoomRight(aside)))));
    measure();
    // A document opened, closed or resized beside this one changes the room, so watch the row too.
    const row = aside.closest(".panel-slot")?.parentElement ?? null;
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    const mutate = typeof MutationObserver === "undefined" || !row ? null : new MutationObserver(() => {
      resize?.disconnect();
      for (const slot of row.children) resize?.observe(slot);
      measure();
    });
    if (row) { for (const slot of row.children) resize?.observe(slot); mutate?.observe(row, { childList: true }); }
    window.addEventListener("resize", measure);
    return () => { window.removeEventListener("resize", measure); resize?.disconnect(); mutate?.disconnect(); };
  }, [expandedId, width, placements[expandedId ?? ""]?.left]);

  // The passage of the note being read or pointed at stays lit in the text. The editor owns
  // its DOM and would undo a class added to the passage, so a scoped style rule lights it.
  const linkedId = hoverId ?? passageHoverId ?? (marks ? openId : null) ?? (activeId && items.some((item) => item.id === activeId) ? activeId : null);
  const escape = (value: string) => typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
  const pendingRule = items.filter((item) => item.pending).map((item) =>
    `.document-panel-content:has(> .document-margin[data-margin-notes-for="${escape(documentId)}"]) > .document-body .message-anchor[data-annotation-branches*='"${escape(item.id)}"']`).join(",");
  const passage = (id: string) => `.document-panel-content:has(> .document-margin[data-margin-notes-for="${escape(documentId)}"]) > .document-body .message-anchor[data-annotation-branches*='"${escape(id)}"']`;
  // On a phone, the AI's notes underline their passages in the AI's ink.
  const aiRule = sheet ? items.filter((item) => item.ai).map((item) => passage(item.id)).join(",") : "";
  const linkedRule = (aiRule ? `${aiRule} { --note-ink: var(--quiet-ai-ink, var(--accent)); }` : "")
    + (linkedId ? `${passage(linkedId)} { background-color: var(--margin-linked-passage); box-shadow: 0 1.5px 0 var(--margin-linked-line); }` : "")
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
    const scroller = asideRef.current && scrollsItself(asideRef.current) ? asideRef.current : body;
    if (top < scroller.scrollTop || bottom > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = Math.max(0, top - 24);
    syncScroll();
  }, [activeId, placements]);

  if (marks) return <aside className={`document-margin is-marks${sheet ? " is-phone" : ""}${tabsOut ? " has-tabs-out" : ""}`} ref={asideRef} aria-label={label} data-margin-notes-for={documentId}
    style={{ width, flexBasis: width, ...(tabPeek !== null ? { "--tab-peek": `${tabPeek}px` } : {}) } as CSSProperties}
    onPointerDownCapture={() => { pointerInside.current = Date.now(); }}
    onWheel={(event) => {
      const body = bodyRef.current;
      if (!body || scrollsInside(event.target, event.currentTarget, event.deltaY)) return;
      body.scrollTop += event.deltaY;
    }}>
    {linkedRule ? <style>{linkedRule}</style> : null}
    {/* With the titles out, a tap anywhere else (even inside an HTML page, whose taps never reach
        this document) lands here and tucks them back into the margin. */}
    {tabsOut ? <div className="document-margin-tabs-backdrop" aria-hidden="true" onPointerDown={() => setTabsOut(false)} /> : null}
    <div className="document-margin-track" ref={trackRef} style={{ height }}>
      {items.map((item) => {
        const placement = placements[item.id];
        const open = openId === item.id;
        const text = bubbleText(item);
        // On a phone a note on a passage shows no button: its underlined passage is the button.
        const underlined = sheet && placement?.anchorTop !== null && placement?.anchorTop !== undefined;
        return <div key={item.id} className={`document-margin-mark-slot${open ? " is-open" : ""}${underlined ? " is-underlined" : ""}`} style={{ top: placement?.top ?? 0, visibility: placement ? undefined : "hidden" }}>
          {/* Kept for keyboards and screen readers, out of sight: the passage is what you tap. */}
          {/* On a phone, a note about the whole page is a tab tucked part-way off the edge, showing the start of its title (see tabClick). */}
          <button type="button" className={`document-margin-mark${underlined ? " is-offscreen" : sheet ? " is-tab" : ""}${item.ai ? " is-ai" : ""}${open ? " is-open" : ""}${item.id === passageHoverId ? " is-pointed" : ""}${item.pending ? " is-pending" : ""}`}
            ref={(element) => { itemRefs.current[item.id] = element; }}
            aria-expanded={open} aria-label={sheet && !underlined && !tabsOut ? `Show the titles of this page's notes: ${text}` : `${open ? "Close" : "Open"} note: ${text}`}
            onPointerEnter={() => setHoverId(item.id)} onPointerLeave={() => setHoverId((current) => current === item.id ? null : current)}
            {...(sheet && !underlined ? { onPointerDown: tabPointerDown, onPointerMove: tabPointerMove, onClick: () => tabClick(item.id) }
              : { onClick: () => setOpenId((current) => current === item.id ? null : item.id) })}>
            <span className="document-margin-mark-dot" aria-hidden="true" />
            <span className="document-margin-mark-text">{text}</span>
          </button>
          {open && sheet ? createPortal(<div className={`note-sheet${sheetFull && sheetDrag === null ? " is-full" : ""}${sheetDrag !== null ? " is-dragging" : ""}`} ref={sheetRef} data-note-sheet
            data-sheet-stop={["peek", "half", "full"][sheetStop]}
            style={{ height: sheetDrag !== null ? `${sheetDrag}px` : sheetStop === 2 ? undefined : `${NOTE_SHEET_STOPS[sheetStop] * 100}dvh` }}
            data-margin-note-id={item.id} data-mobile-keyboard-direct role="dialog" aria-label={`Note: ${item.label || "Margin note"}`}>
            <button type="button" className="note-sheet-handle" aria-expanded={sheetFull}
              aria-label={sheetFull ? "Show the page above the note (or drag to resize)" : "Make the note full screen (or drag to resize)"}
              onPointerDown={sheetHandleDown} onPointerMove={sheetHandleMove} onPointerUp={sheetHandleEnd} onPointerCancel={sheetHandleEnd}
              onClick={sheetHandleClick}><span aria-hidden="true" /></button>
            {sheetFull ? <button type="button" className="note-sheet-back" onClick={() => setOpenId(null)}>‹ {label.replace(/^Notes for /, "")}</button> : null}
            <NoteHead item={item} />
            <div className="note-sheet-body"><MobileKeyboardDirect>{item.node}</MobileKeyboardDirect></div>
          </div>, asideRef.current?.closest(".app-shell") ?? document.body) : null}
          {open && !sheet ? <div className={`document-margin-mark-note${openRight ? " is-right" : ""}`} data-margin-note-id={item.id} data-mobile-keyboard-direct style={{ width: noteWidth }}
            onPointerEnter={() => setHoverId(item.id)} onPointerLeave={() => setHoverId((current) => current === item.id ? null : current)}>
            <NoteHead item={item} />
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
      // A note's own body stops the wheel from reaching the margin, so the margin is moved here.
      (scrollsItself(event.currentTarget) ? event.currentTarget : body).scrollTop += event.deltaY;
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
        const folded = isFolded(item);
        return <div key={item.id} className={`document-margin-item${folded ? " is-folded" : ""}${item.ai ? " is-ai" : ""}${placement?.anchorTop === null ? " is-document-note" : ""}${item.id === expandedId ? " is-expanded" : ""}${item.id === passageHoverId ? " is-pointed" : ""}${onLeft ? " is-left" : ""}${placement && placedIds.current.has(item.id) ? "" : " is-placing"}`}
          data-margin-note-id={item.id} ref={(element) => { itemRefs.current[item.id] = element; }}
          onPointerDownCapture={() => setExpandedId(item.id)}
          style={{ top: placement?.top ?? 0, left: onLeft ? left.x : DOCUMENT_MARGIN_GUTTER, visibility: placement ? undefined : "hidden",
            ...(onLeft ? { right: "auto", width: left.width } : item.id === expandedId && expandBy ? { right: 10 - expandBy } : {}) }}
          onPointerEnter={() => setHoverId(item.id)} onPointerLeave={() => setHoverId((current) => current === item.id ? null : current)}>
          {folded ? <button type="button" className="document-margin-fold" title={item.label}
            aria-label={`Open note: ${item.label || "Margin note"}`} aria-expanded={false}
            onClick={(event) => {
              setExpandedId(item.id);
              // From the keyboard, the caret goes into the note so you can write or reply at once.
              if (event.detail === 0) window.requestAnimationFrame(() => itemRefs.current[item.id]?.querySelector<HTMLElement>(".cm-content, [contenteditable=\"true\"]")?.focus());
            }}>
            <span className="document-margin-fold-text">{item.label || (item.pending ? "Thinking…" : "Margin note")}</span>
          </button> : item.anchored ? null : <span className="document-margin-label">About this document</span>}
          {folded && item.onOpenBeside ? <button type="button" className="document-margin-fold-beside"
            aria-label={`Open beside the page: ${item.label || "Margin note"}`} title="Open beside" onClick={item.onOpenBeside}>
            <OpenBesideIcon size={14} />
          </button> : null}
          {/* A folded note stays mounted (CSS hides it), so it opens at once with its editor as it was. */}
          {item.node}
        </div>;
      })}
    </div>
  </aside>;
}
