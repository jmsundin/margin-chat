import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { fitCircle, useCirclesCamera, useSize } from "./exploreCamera";
import { getDocumentPreview } from "../lib/documentSources";
import { groupLinks, layRooms, libraryPath, packLibrary, type ExploreLayout, type LibrarySection, type PackedCircle } from "../lib/exploreLibrary";
import type { Conversation } from "../types";
import "./ExploreLibrary.css";

/**
 * Explore's library layouts: the vault as sections inside sections, to browse without a query.
 * Tiles draws the sections of one level as rooms; Clusters draws them as circles that split into
 * the sections inside as you zoom. Both share one path, shown as breadcrumbs, so switching layout
 * keeps your place.
 */
export default function ExploreLibrary({ root, layout, conversations, links, selectedId, leading, sourceMenu, onOpenNote }: {
  root: LibrarySection;
  layout: Exclude<ExploreLayout, "canvas">;
  conversations: Record<string, Conversation>;
  links: Array<{ sourceId: string; targetId: string }>;
  selectedId?: string | null;
  /** Controls before the breadcrumbs, such as the Layout menu. */
  leading?: ReactNode;
  /** Where Explore starts, as a menu that stands in for the first crumb. */
  sourceMenu?: (onTop: () => void) => ReactNode;
  onOpenNote: (id: string) => void;
}) {
  const [pathIds, setPathIds] = useState<string[]>([]);
  const path = useMemo(() => libraryPath(root, pathIds), [root, pathIds]);
  const here = path[path.length - 1];
  // A crumb or a room picked by hand moves Clusters' camera; following the camera does not.
  const [flyRequest, setFlyRequest] = useState(0);
  const goTo = useCallback((ids: string[]) => { setPathIds(ids); setFlyRequest((count) => count + 1); }, []);
  const follow = useCallback((ids: string[]) => setPathIds((current) => sameIds(current, ids) ? current : ids), []);
  const titleOf = useCallback((id: string) => conversations[id]?.title?.trim() || "Untitled", [conversations]);

  return <div className={`explore-library is-${layout}`} data-graph-ui="true">
    <nav className="explore-library-crumbs" aria-label="Where you are in Explore">
      {leading}
      {sourceMenu ? <span>{sourceMenu(() => goTo([]))}{path.length > 1 ? <span aria-hidden="true">›</span> : <small>{noteCount(root.allIds.length)}</small>}</span> : null}
      {(sourceMenu ? path.slice(1) : path).map((section, index) => { const at = sourceMenu ? index + 1 : index; return at < path.length - 1
        ? <span key={section.id}><button type="button" onClick={() => goTo(pathIds.slice(0, at))}>{section.label}</button><span aria-hidden="true">›</span></span>
        : <span key={section.id} className="is-here" aria-current="location">{section.label} <small>{noteCount(section.allIds.length)}</small></span>; })}
    </nav>
    {!root.allIds.length ? <p className="explore-library-empty">Notes you write show up here, sorted into sections you can walk through.</p>
      : layout === "tiles" ? <ExploreTiles section={here} siblings={path.length > 1 ? path[path.length - 2].sections : []}
        titleOf={titleOf} conversations={conversations} selectedId={selectedId}
        onEnter={(id) => goTo([...pathIds.slice(0, path.length - 1), id])}
        onSibling={(id) => goTo([...pathIds.slice(0, path.length - 2), id])}
        onOpenNote={onOpenNote} />
      : <ExploreClusters root={root} target={here} flyRequest={flyRequest} links={links} titleOf={titleOf} selectedId={selectedId}
        onFollow={follow}
        onOpenNote={onOpenNote} />}
  </div>;
}

const noteCount = (count: number) => `${count} note${count === 1 ? "" : "s"}`;
const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((id, at) => id === b[at]);

/* ---------- Tiles ---------- */

const PEEK_WIDTH = 86, PEEK_HEIGHT = 74;

function ExploreTiles({ section, siblings, titleOf, conversations, selectedId, onEnter, onSibling, onOpenNote }: {
  section: LibrarySection; siblings: LibrarySection[]; titleOf: (id: string) => string; conversations: Record<string, Conversation>;
  selectedId?: string | null; onEnter: (id: string) => void; onSibling: (id: string) => void; onOpenNote: (id: string) => void;
}) {
  const [ref, size] = useSize<HTMLDivElement>();
  const rooms = useMemo(() => section.sections.length && size.width ? layRooms(section.sections.map((child) => child.allIds.length), size.width, size.height, 12) : null,
    [section, size]);
  const rects = rooms?.rects ?? [];
  if (!section.sections.length) {
    const others = siblings.filter((sibling) => sibling.id !== section.id);
    return <div className="explore-shelf">
      <div className="explore-shelf-notes" role="list">
        {section.noteIds.map((id) => <button type="button" role="listitem" key={id} className="explore-shelf-note" style={{ "--section": section.color } as CSSProperties}
          aria-current={selectedId === id ? "true" : undefined} onClick={() => onOpenNote(id)}>
          <strong>{titleOf(id)}</strong>
          {conversations[id] ? <span>{getDocumentPreview(conversations[id], 110)}</span> : null}
        </button>)}
      </div>
      {others.length ? <div className="explore-shelf-next"><span>Next shelves over</span>
        {others.map((sibling) => <button type="button" key={sibling.id} style={{ "--section": sibling.color } as CSSProperties} onClick={() => onSibling(sibling.id)}>
          {sibling.label} <small>{sibling.allIds.length}</small></button>)}
      </div> : null}
    </div>;
  }
  return <div className={`explore-tiles${rooms?.stacked ? " is-stacked" : ""}`} ref={ref}>
    {rooms?.stacked ? <div className="explore-tiles-length" style={{ height: rooms.height }} aria-hidden="true" /> : null}
    {rects.map((rect) => {
      const child = section.sections[rect.index];
      const inner = child.sections;
      const peekColumns = Math.floor((rect.width - 24) / (PEEK_WIDTH + 6));
      const peekRows = Math.floor((rect.height - (inner.length ? 112 : 78) - (child.summary && rect.height > 200 ? 40 : 0)) / (PEEK_HEIGHT + 6));
      const peek = peekColumns > 0 && peekRows > 0 ? child.allIds.slice(0, peekColumns * peekRows) : [];
      const compact = rect.height < 70 || rect.width < 110;
      return <button type="button" key={child.id} className={`explore-tile${compact ? " is-compact" : ""}`}
        style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height, "--section": child.color } as CSSProperties}
        title={`${child.label}: ${noteCount(child.allIds.length)}`} onClick={() => onEnter(child.id)}>
        <span className="explore-tile-sign">{child.label}</span>
        {compact ? null : <span className="explore-tile-meta">{noteCount(child.allIds.length)}{inner.length ? ` · ${inner.length} sections` : ""}</span>}
        {!compact && child.summary && rect.height > 200 ? <span className="explore-tile-summary">{child.summary}</span> : null}
        {!compact && inner.length && rect.height > 118 ? <span className="explore-tile-sections">{inner.map((item) => <span key={item.id}>{item.label}</span>)}</span> : null}
        {peek.length ? <span className="explore-tile-peek" aria-hidden="true">{peek.map((id) => <span key={id}>{titleOf(id)}</span>)}</span> : null}
      </button>;
    })}
  </div>;
}

/* ---------- Clusters ---------- */

/** A section opens into what it holds once it is this many pixels across on screen (a shelf of notes, a little sooner). */
const OPEN_RADIUS = 110, OPEN_SHELF_RADIUS = 76;
/**
 * Notes are dots with no titles: a wall of overlapping titles can't be read, and Clusters is for finding
 * the section. A note's title shows while you point at it or move to it with the keyboard.
 */
const fitLabel = (label: string, r: number, fontSize: number) => {
  const maxChars = Math.max(4, Math.floor((r * 1.8) / (fontSize * 0.6)));
  return label.length > maxChars ? `${label.slice(0, maxChars - 1)}…` : label;
};

function ExploreClusters({ root, target, flyRequest, links, titleOf, selectedId, onFollow, onOpenNote }: {
  root: LibrarySection; target: LibrarySection; flyRequest: number; links: Array<{ sourceId: string; targetId: string }>;
  titleOf: (id: string) => string; selectedId?: string | null; onFollow: (ids: string[]) => void; onOpenNote: (id: string) => void;
}) {
  const [ref, size, element] = useSize<HTMLDivElement>();
  const circles = useMemo(() => packLibrary(root), [root]);
  const byId = useMemo(() => new Map(circles.map((circle) => [circle.id, circle])), [circles]);
  const [pointedNote, setPointedNote] = useState<string | null>(null);
  // Each note's chain of sections, outermost first, ending with its own circle.
  const chains = useMemo(() => {
    const out = new Map<string, PackedCircle[]>();
    for (const circle of circles) {
      if (circle.kind !== "note" || !circle.noteId) continue;
      const chain: PackedCircle[] = [circle];
      for (let parent = circle.parentId ? byId.get(circle.parentId) : undefined; parent; parent = parent.parentId ? byId.get(parent.parentId) : undefined) chain.unshift(parent);
      out.set(circle.noteId, chain);
    }
    return out;
  }, [circles, byId]);
  const fitTo = useCallback((circle: PackedCircle | undefined, width: number, height: number) => {
    const subject = circle ?? byId.get(root.id)!;
    return fitCircle(subject, width, height, subject.depth === 0 ? 0.47 : 0.44);
  }, [byId, root.id]);
  // Zoom stops where it stops helping: out to a little smaller than everything, in to where one
  // note's dot is about a sixth of the screen.
  const bounds = size.width && size.height
    ? { min: fitTo(undefined, size.width, size.height).k * 0.5, max: Math.min(size.width, size.height) / 60 }
    : { min: 0.05, max: 400 };
  const { camera, fly, zoomAround, handlers, dragged } = useCirclesCamera(element, bounds);
  // On first draw, and whenever a crumb or a room is picked, fly to that section.
  const flown = useRef<number | null>(null);
  useEffect(() => {
    if (!size.width || !size.height) return;
    const first = flown.current === null;
    if (!first && flown.current === flyRequest) return;
    flown.current = flyRequest;
    fly(fitTo(byId.get(target.id), size.width, size.height), !first);
  }, [flyRequest, size, target.id, byId, fitTo, fly]);

  const { k } = camera;
  const isOpen = useCallback((circle: PackedCircle): boolean => {
    if (circle.kind !== "section") return false;
    if (circle.depth === 0) return true;
    const parent = circle.parentId ? byId.get(circle.parentId) : undefined;
    if (parent && !isOpen(parent)) return false;
    return circle.r * k > (circle.section?.sections.length ? OPEN_RADIUS : OPEN_SHELF_RADIUS);
  }, [byId, k]);

  // Breadcrumbs follow the camera: the smallest open section under the middle of the screen
  // that still fills most of it.
  useEffect(() => {
    if (!size.width || !size.height || flown.current === null) return;
    const cx = (size.width / 2 - camera.x) / camera.k, cy = (size.height / 2 - camera.y) / camera.k;
    const need = Math.min(size.width, size.height) * 0.6;
    let deepest: PackedCircle | null = null;
    for (const circle of circles) {
      if (circle.kind !== "section" || circle.depth === 0 || !isOpen(circle)) continue;
      if (Math.hypot(circle.x - cx, circle.y - cy) > circle.r || circle.r * 2 * camera.k < need) continue;
      if (!deepest || circle.depth > deepest.depth) deepest = circle;
    }
    const ids: string[] = [];
    for (let at: PackedCircle | undefined = deepest ?? undefined; at && at.depth > 0; at = at.parentId ? byId.get(at.parentId) : undefined) ids.unshift(at.id);
    onFollow(ids);
  }, [camera, size, circles, isOpen, byId, onFollow]);

  // What is drawn: circles whose parent is open, on screen.
  const visible = useMemo(() => circles.filter((circle) => {
    if (circle.depth === 0) return false;
    const parent = circle.parentId ? byId.get(circle.parentId) : undefined;
    if (!parent || !isOpen(parent)) return false;
    const x = circle.x * k + camera.x, y = circle.y * k + camera.y, r = circle.r * k;
    return x + r > -40 && x - r < size.width + 40 && y + r > -40 && y - r < size.height + 40;
  }), [circles, byId, isOpen, k, camera.x, camera.y, size]);
  // Links between notes, between whatever stands for each end at this zoom.
  const lines = useMemo(() => {
    const standIn = (noteId: string) => {
      const chain = chains.get(noteId);
      if (!chain) return null;
      for (const circle of chain) if (circle.depth > 0 && !isOpen(circle)) return circle.id;
      return chain[chain.length - 1].id;
    };
    return groupLinks(links, standIn);
  }, [links, chains, isOpen]);

  const pick = (circle: PackedCircle) => {
    if (dragged.current) return;
    if (circle.kind === "note" && circle.noteId) { onOpenNote(circle.noteId); return; }
    fly(fitTo(circle, size.width, size.height));
  };

  const screen = (circle: PackedCircle) => ({ x: circle.x * k + camera.x, y: circle.y * k + camera.y, r: circle.r * k });
  const sections = visible.filter((circle) => circle.kind === "section");
  const notes = visible.filter((circle) => circle.kind === "note");
  return <div className="explore-clusters" ref={ref} {...handlers}>
    <svg width={size.width} height={size.height} role="group" aria-label="Clusters of notes">
      <g className="explore-cluster-lines" aria-hidden="true">
        {lines.map((line) => {
          const a = byId.get(line.a), b = byId.get(line.b);
          if (!a || !b) return null;
          const p = screen(a), q = screen(b);
          return <line key={`${line.a}|${line.b}`} x1={p.x} y1={p.y} x2={q.x} y2={q.y} strokeWidth={Math.min(0.8 + line.count * 0.7, 7)} />;
        })}
      </g>
      {sections.map((circle) => {
        const { x, y, r } = screen(circle);
        const open = isOpen(circle);
        const section = circle.section!;
        const fontSize = Math.min(15, Math.max(11, r / 5));
        const name = fitLabel(section.label, r, fontSize);
        // An open section's name sits across its top, where the circle is narrower than its middle.
        const headingSize = circle.depth === 1 ? 15 : 13;
        const heading = fitLabel(section.label, r * 0.8, headingSize);
        return <g key={circle.id} className={`explore-cluster${open ? " is-open" : ""}`} style={{ "--section": circle.color } as CSSProperties}
          role="button" tabIndex={0} aria-label={`${section.label}, ${noteCount(section.allIds.length)}${open ? "" : ". Open"}`}
          onClick={() => pick(circle)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); pick(circle); } }}>
          <circle cx={x} cy={y} r={r} />
          {open ? <text className="explore-cluster-heading" x={x} y={y - r + Math.min(22, r * 0.2) + 4} textAnchor="middle" style={{ fontSize: headingSize }}>{heading}<title>{section.label}</title></text>
            : r > 22 ? <>
              <text className="explore-cluster-name" x={x} y={y} textAnchor="middle" style={{ fontSize }}>{name}</text>
              <text className="explore-cluster-count" x={x} y={y + fontSize + 2} textAnchor="middle">{section.allIds.length}{r > 48 && section.sections.length ? ` · ${section.sections.length} inside` : ""}</text>
            </> : <title>{`${section.label}: ${noteCount(section.allIds.length)}`}</title>}
        </g>;
      })}
      {notes.map((circle) => {
        const { x, y } = screen(circle);
        const dot = Math.max(4, Math.min(circle.r * k * 0.5, 13));
        const title = titleOf(circle.noteId!);
        return <g key={circle.id} className={`explore-cluster-note${selectedId === circle.noteId ? " is-selected" : ""}`} style={{ "--section": circle.color } as CSSProperties}
          role="button" tabIndex={0} aria-label={title} onClick={() => pick(circle)}
          onPointerEnter={() => setPointedNote(circle.noteId!)} onPointerLeave={() => setPointedNote((current) => current === circle.noteId ? null : current)}
          onFocus={() => setPointedNote(circle.noteId!)} onBlur={() => setPointedNote((current) => current === circle.noteId ? null : current)}
          onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); pick(circle); } }}>
          <circle cx={x} cy={y} r={dot}><title>{title}</title></circle>
        </g>;
      })}
      {/* The title of the note pointed at, drawn last so no other dot covers it. */}
      {notes.filter((circle) => circle.noteId === pointedNote).map((circle) => {
        const { x, y } = screen(circle);
        const dot = Math.max(4, Math.min(circle.r * k * 0.5, 13));
        const title = titleOf(circle.noteId!);
        return <g key="pointed" className="explore-cluster-note" aria-hidden="true">
          <text x={x} y={y + dot + 15} textAnchor="middle" style={{ fontSize: 12.5 }}>{title.length > 48 ? `${title.slice(0, 47)}…` : title}</text>
        </g>;
      })}
    </svg>
    <div className="explore-cluster-zoom">
      <button type="button" aria-label="Zoom in" onClick={() => zoomAround(1.6, size.width / 2, size.height / 2)}>+</button>
      <button type="button" aria-label="Zoom out" onClick={() => zoomAround(1 / 1.6, size.width / 2, size.height / 2)}>−</button>
    </div>
  </div>;
}
