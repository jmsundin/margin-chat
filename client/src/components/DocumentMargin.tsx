import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import "./DocumentMargin.css";

export interface DocumentMarginItem {
  id: string;
  /** False for a note about the whole document: it sits at the top of the margin. */
  anchored: boolean;
  node: ReactNode;
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
}

type Placement = { top: number; anchorTop: number | null };
const GAP = 12;
/** Room on the left of the cards for the line back to each passage. */
export const DOCUMENT_MARGIN_GUTTER = 22;

function anchorMarks(body: HTMLElement, id: string) {
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
 * The document's right margin. Each note sits level with the passage it was written on and
 * scrolls with the text; notes about the whole document come first, at the top. When notes
 * would overlap, later ones move down and a line keeps them tied to their passage.
 */
export default function DocumentMargin({ bodyRef, documentId, label, items, width, activeId, onHeightChange }: Props) {
  const asideRef = useRef<HTMLElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [placements, setPlacements] = useState<Record<string, Placement>>({});
  const [height, setHeight] = useState(0);
  const [hoverId, setHoverId] = useState<string | null>(null);
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
    const measured = items.map((item, index) => {
      const mark = item.anchored ? anchorMarks(body, item.id)[0] : undefined;
      return { id: item.id, index, anchorTop: mark ? mark.getBoundingClientRect().top - bodyTop : null, height: itemRefs.current[item.id]?.offsetHeight ?? 0 };
    });
    // Whole-document notes (and notes whose passage is gone) first, then notes in passage order.
    measured.sort((a, b) => (a.anchorTop === null ? -1 : 0) - (b.anchorTop === null ? -1 : 0)
      || (a.anchorTop ?? 0) - (b.anchorTop ?? 0) || a.index - b.index);
    let cursor = start;
    const next: Record<string, Placement> = {};
    for (const item of measured) {
      const top = Math.max(cursor, item.anchorTop === null ? start : item.anchorTop - 4);
      next[item.id] = { top, anchorTop: item.anchorTop };
      cursor = top + item.height + GAP;
    }
    setPlacements((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
    setHeight((current) => current === cursor ? current : cursor);
    syncScroll();
  }, [bodyRef, itemKey, syncScroll]);

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
    mutations?.observe(body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-annotation-branches", "class", "style"] });
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

  // The passage of the note being read or pointed at stays lit in the text. The editor owns
  // its DOM and would undo a class added to the passage, so a scoped style rule lights it.
  const linkedId = hoverId ?? (activeId && items.some((item) => item.id === activeId) ? activeId : null);
  const escape = (value: string) => typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
  const linkedRule = linkedId ? `.document-panel-content:has(> .document-margin[data-margin-notes-for="${escape(documentId)}"]) > .document-body .message-anchor[data-annotation-branches*='"${escape(linkedId)}"'] { background: var(--margin-linked-passage); box-shadow: 0 1.5px 0 var(--margin-linked-line); }` : "";

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

  return <aside className="document-margin" ref={asideRef} aria-label={label} data-margin-notes-for={documentId}
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
          if (!placement || placement.anchorTop === null) return null;
          const from = placement.anchorTop + 10, to = placement.top + 16, x = DOCUMENT_MARGIN_GUTTER - 4;
          return <path key={item.id} className={item.id === linkedId ? "is-linked" : undefined}
            d={`M0 ${from} H8 V${to} H${x}`} />;
        })}
      </svg>
      {items.map((item) => {
        const placement = placements[item.id];
        return <div key={item.id} className={`document-margin-item${placement?.anchorTop === null ? " is-document-note" : ""}`}
          data-margin-note-id={item.id} ref={(element) => { itemRefs.current[item.id] = element; }}
          style={{ top: placement?.top ?? 0, left: DOCUMENT_MARGIN_GUTTER, visibility: placement ? undefined : "hidden" }}
          onPointerEnter={() => setHoverId(item.id)} onPointerLeave={() => setHoverId((current) => current === item.id ? null : current)}>
          {item.anchored ? null : <span className="document-margin-label">About this document</span>}
          {item.node}
        </div>;
      })}
    </div>
  </aside>;
}
