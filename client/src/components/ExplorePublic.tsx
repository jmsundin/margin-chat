import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { browsePath, canOpen, openWikipediaNode, packBrowse, sourceRoot, topicChildren, withChildren, type BrowseCircle, type BrowseNode, type ExploreSource } from "../lib/exploreSources";
import { squarify } from "../lib/exploreLibrary";
import type { PublicTopic } from "../lib/publicKnowledge";
import { getWikipediaSummary, wikipediaArticleUrl } from "../lib/wikipedia";
import { fitCircle, useCirclesCamera, useSize } from "./exploreCamera";
import "./ExploreLibrary.css";

/** Section colours, picked by position so a section keeps its colour all the way down. */
const HUES = ["#c9485b", "#3f8f6b", "#4d6fd6", "#c08419", "#9a52c7", "#1f93a8", "#cf6a32", "#6c8d26", "#b8478f", "#5a6fa0", "#2f8a86", "#a0603a"];
const colorOf = (_node: BrowseNode, at: number) => HUES[at % HUES.length];
/** Opening many places at once makes Wikipedia ask us to slow down; zooming waits its turn. */
const MAX_AUTO_LOADS = 3;

export interface ExplorePublicActions {
  /** AI sub-topics for a topic; absent when this account cannot ask AI. */
  ask?: (label: string, existing: string[], signal: AbortSignal) => Promise<PublicTopic[]>;
  /** The note in the vault for a topic, when there is one. */
  noteFor: (label: string, topic?: PublicTopic) => string | null;
  onOpenNote: (id: string) => void;
  /** Opens a Wikipedia article to read beside. */
  onRead: (title: string) => void;
  /** Saves a topic as a note; resolves to the note, or a reason it could not be saved. */
  onKeep: (node: BrowseNode) => Promise<{ id: string } | { error: string }>;
  /** Starts a roadmap for a topic in Learn; returns a reason when it could not start. */
  onRoadmap?: (node: BrowseNode) => string | null;
}

/**
 * Explore from Wikipedia or from a topic AI splits up. The same Tiles and Clusters as your notes,
 * except that each place is fetched the first time you open it.
 */
export default function ExplorePublic({ source, layout, sourceMenu, actions, reader, onPlace }: {
  source: Exclude<ExploreSource, { kind: "notes" }>;
  layout: "tiles" | "clusters";
  sourceMenu: (onTop: () => void) => ReactNode;
  actions: ExplorePublicActions;
  /** A reading pane shown beside the layout, when one is open. */
  reader?: ReactNode;
  /** Tells the host which article or topic you are on, so Canvas can start from it. */
  onPlace?: (place: string | undefined) => void;
}) {
  const sourceKey = source.kind === "ai" ? `ai:${source.topic}` : source.kind;
  const [root, setRoot] = useState<BrowseNode>(() => sourceRoot(source));
  const [pathIds, setPathIds] = useState<string[]>([]);
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [flyRequest, setFlyRequest] = useState(0);
  const latest = useRef({ root, actions, source });
  latest.current = { root, actions, source };
  const inflight = useRef(new Map<string, { controller: AbortController; auto: boolean }>());

  // A new source starts a new walk.
  useEffect(() => {
    for (const { controller } of inflight.current.values()) controller.abort();
    inflight.current.clear();
    setRoot(sourceRoot(source)); setPathIds([]); setLoading(new Set()); setErrors({}); setFlyRequest((count) => count + 1);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey]);
  useEffect(() => () => { for (const { controller } of inflight.current.values()) controller.abort(); }, []);

  /** Fetches what a node opens into, once. */
  const load = useCallback((node: BrowseNode, auto = false) => {
    if (node.children) return;
    const running = inflight.current.get(node.id);
    if (running && (auto || !running.auto)) return;
    if (auto && inflight.current.size >= MAX_AUTO_LOADS) return;
    // What you pick goes first: background fetches step aside and come back later.
    if (!auto) for (const [id, other] of inflight.current) if (other.auto) { other.controller.abort(); inflight.current.delete(id); }
    const controller = new AbortController();
    inflight.current.set(node.id, { controller, auto });
    setLoading((current) => new Set(current).add(node.id));
    setErrors((current) => { if (!(node.id in current)) return current; const next = { ...current }; delete next[node.id]; return next; });
    const { source: from, actions: act } = latest.current;
    const fetching = from.kind === "ai"
      ? act.ask ? act.ask(node.kind === "root" ? from.topic : node.label, [], controller.signal).then((topics) => topicChildren(node, topics))
        : Promise.reject(new Error("Ask AI is part of the paid plan."))
      : openWikipediaNode(node, controller.signal);
    fetching.then((children) => {
      if (controller.signal.aborted) return;
      setRoot((current) => withChildren(current, node.id, children));
      if (!children.length) setErrors((current) => ({ ...current, [node.id]: from.kind === "ai" ? "AI found no sub-topics here." : "Nothing is filed under this yet." }));
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      setErrors((current) => ({ ...current, [node.id]: reason instanceof Error ? reason.message : "This could not be opened. Try again." }));
    }).finally(() => {
      if (inflight.current.get(node.id)?.controller === controller) inflight.current.delete(node.id);
      setLoading((current) => { const next = new Set(current); next.delete(node.id); return next; });
    });
  }, []);
  const retry = useCallback((node: BrowseNode) => {
    setErrors((current) => { const next = { ...current }; delete next[node.id]; return next; });
    if (node.children && !node.children.length) setRoot((current) => withChildren(current, node.id, undefined));
    load({ ...node, children: undefined });
  }, [load]);

  useEffect(() => { load(root); }, [root, load]);
  const path = useMemo(() => browsePath(root, pathIds), [root, pathIds]);
  const here = path[path.length - 1];
  useEffect(() => { if (layout === "tiles") load(here); }, [here, layout, load]);
  useEffect(() => {
    const place = [...path].reverse().find((node) => node.article || node.kind === "topic" || node.kind === "root" && source.kind === "ai");
    onPlace?.(place?.article ?? (place ? place.label : undefined));
  }, [path, source.kind, onPlace]);

  const goTo = useCallback((ids: string[]) => { setPathIds(ids); setFlyRequest((count) => count + 1); }, []);
  const follow = useCallback((ids: string[]) => setPathIds((current) => current.length === ids.length && current.every((id, at) => id === ids[at]) ? current : ids), []);
  const enter = (node: BrowseNode) => { load(node); goTo([...pathIds.slice(0, path.length - 1), node.id]); };

  return <div className={`explore-library is-${layout} is-public${reader ? " has-reader" : ""}`} data-graph-ui="true">
    <div className="explore-public-main">
      <nav className="explore-library-crumbs" aria-label="Where you are in Explore">
        <span>{sourceMenu(() => goTo([]))}{path.length > 1 ? <span aria-hidden="true">›</span> : null}</span>
        {path.slice(1).map((node, index) => index + 1 < path.length - 1
          ? <span key={node.id}><button type="button" onClick={() => goTo(pathIds.slice(0, index + 1))}>{node.label}</button><span aria-hidden="true">›</span></span>
          : <span key={node.id} className="is-here" aria-current="location">{node.label}</span>)}
      </nav>
      {layout === "tiles" || here.kind === "article" || here.kind === "topic" ? <TopicHeader node={here} actions={actions} /> : null}
      {layout === "tiles"
        ? <PublicTiles node={here} siblings={path.length > 1 ? path[path.length - 2].children ?? [] : []} loading={loading.has(here.id)} error={errors[here.id]}
          noteFor={actions.noteFor} onEnter={enter} onSibling={(node) => { load(node); goTo([...pathIds.slice(0, path.length - 2), node.id]); }}
          onRetry={() => retry(here)} onOpenNote={actions.onOpenNote} onPeek={(node) => load(node, true)} />
        : <PublicClusters root={root} target={here} pathKey={path.map((node) => node.id).join(">")} flyRequest={flyRequest} loading={loading} errors={errors} noteFor={actions.noteFor}
          onLoad={load} onFollow={follow} />}
    </div>
    {reader}
  </div>;
}

/* ---------- The sign over the room you are in ---------- */

function TopicHeader({ node, actions }: { node: BrowseNode; actions: ExplorePublicActions }) {
  const [extract, setExtract] = useState<string | null>(null);
  const [state, setState] = useState<{ busy?: boolean; message?: string; error?: boolean; kept?: string }>({});
  useEffect(() => {
    setExtract(null); setState({});
    if (!node.article || (node.kind !== "article" && node.kind !== "topic")) return;
    const controller = new AbortController();
    getWikipediaSummary(wikipediaArticleUrl(node.article), controller.signal).then((summary) => {
      if (!controller.signal.aborted && summary?.extract) setExtract(summary.extract);
    }).catch(() => undefined);
    return () => controller.abort();
  }, [node.id, node.article, node.kind]);
  if (node.kind !== "article" && node.kind !== "topic" && node.kind !== "root") return null;
  if (node.kind === "root") return node.summary ? <p className="explore-public-lede">{node.summary}</p> : null;
  const noteId = state.kept ?? actions.noteFor(node.label, node.topic);
  const text = extract ?? node.summary;
  return <section className="explore-public-header" aria-label={node.label}>
    <div>
      <h2>{node.label}</h2>
      {text ? <p>{text.length > 320 ? `${text.slice(0, 319).replace(/\s+\S*$/u, "")}…` : text}</p> : null}
    </div>
    <div className="explore-public-actions">
      {node.article ? <button type="button" onClick={() => actions.onRead(node.article!)}>Read</button> : null}
      {noteId ? <button type="button" className="is-mine" onClick={() => actions.onOpenNote(noteId)}>In your notes · Open</button>
        : <button type="button" disabled={state.busy} onClick={() => {
          setState({ busy: true });
          void actions.onKeep(node).then((made) => setState("id" in made ? { kept: made.id, message: "Saved to your notes." } : { message: made.error, error: true }));
        }}>{state.busy ? "Saving…" : "Keep as note"}</button>}
      {actions.onRoadmap ? <button type="button" onClick={() => { const reason = actions.onRoadmap!(node); if (reason) setState({ message: reason, error: true }); }}>Make a roadmap</button> : null}
    </div>
    {state.message ? <p className={`explore-public-status${state.error ? " is-error" : ""}`} role={state.error ? "alert" : "status"}>{state.message}</p> : null}
  </section>;
}

/* ---------- Tiles ---------- */

const KIND_HINT: Record<BrowseNode["kind"], string> = { root: "", section: "", shelf: "Articles", article: "Article", group: "Part of the article", topic: "Topic" };
const countText = (node: BrowseNode) => node.children ? `${node.children.length} inside` : node.hint ?? KIND_HINT[node.kind];

function PublicTiles({ node, siblings, loading, error, noteFor, onEnter, onSibling, onRetry, onOpenNote, onPeek }: {
  node: BrowseNode; siblings: BrowseNode[]; loading: boolean; error?: string; noteFor: ExplorePublicActions["noteFor"];
  onEnter: (node: BrowseNode) => void; onSibling: (node: BrowseNode) => void; onRetry: () => void; onOpenNote: (id: string) => void;
  /** Fetches what a room holds in the background, so big rooms can show what is inside. */
  onPeek: (node: BrowseNode) => void;
}) {
  const [ref, size] = useSize<HTMLDivElement>();
  const children = node.children ?? [];
  // A list of articles reads best as a shelf of cards; sections read best as rooms.
  const shelf = children.length > 0 && children.every((child) => child.kind === "article" || child.kind === "topic");
  const rects = useMemo(() => !shelf && children.length && size.width ? squarify(children.map((child) => child.weight), size.width, size.height, 12) : [],
    [shelf, children, size]);
  // The biggest rooms show what is inside them, fetched a few at a time.
  useEffect(() => {
    for (const rect of rects.filter((item) => item.height > 150 && item.width > 160).slice(0, 8)) {
      const child = children[rect.index];
      if (child && !child.children && child.kind !== "article") onPeek(child);
    }
  });
  if (error) return <div className="explore-public-note" role="alert"><p>{error}</p><button type="button" onClick={onRetry}>Try again</button></div>;
  if (!node.children || loading) return <div className="explore-public-note" role="status"><span className="explore-public-spinner" aria-hidden="true" />Opening {node.label}…</div>;
  if (shelf) {
    const others = siblings.filter((sibling) => sibling.id !== node.id);
    return <div className="explore-shelf">
      <div className="explore-shelf-notes" role="list">
        {children.map((child, at) => {
          const mine = noteFor(child.label, child.topic);
          return <button type="button" role="listitem" key={child.id} className={`explore-shelf-note${child.kind === "topic" ? " is-ai" : ""}`}
            style={{ "--section": HUES[at % HUES.length] } as CSSProperties} onClick={() => onEnter(child)}>
            <strong>{child.label}</strong>
            {child.summary ? <span>{child.summary}</span> : null}
            {mine ? <em className="explore-mine" onClick={(event) => { event.stopPropagation(); onOpenNote(mine); }}>In your notes</em> : null}
          </button>;
        })}
      </div>
      {others.length ? <div className="explore-shelf-next"><span>Next shelves over</span>
        {others.slice(0, 12).map((sibling) => <button type="button" key={sibling.id} onClick={() => onSibling(sibling)}>{sibling.label}</button>)}
      </div> : null}
    </div>;
  }
  return <div className="explore-tiles" ref={ref}>
    {rects.map((rect) => {
      const child = children[rect.index];
      const color = HUES[rect.index % HUES.length];
      const inner = child.children ?? [];
      const compact = rect.height < 70 || rect.width < 110;
      return <button type="button" key={child.id} className={`explore-tile${compact ? " is-compact" : ""}${child.kind === "topic" ? " is-ai" : ""}`}
        style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height, "--section": color } as CSSProperties}
        title={child.label} onClick={() => onEnter(child)}>
        <span className="explore-tile-sign">{child.label}</span>
        {compact || !countText(child) ? null : <span className="explore-tile-meta">{countText(child)}</span>}
        {!compact && child.summary && rect.height > 120 ? <span className="explore-tile-summary">{child.summary}</span> : null}
        {!compact && inner.length && rect.height > 118 ? <span className="explore-tile-sections">{inner.slice(0, 12).map((item) => <span key={item.id}>{item.label}</span>)}</span> : null}
      </button>;
    })}
  </div>;
}

/* ---------- Clusters ---------- */

/** A circle opens into what it holds once it is this many pixels across; a closed one asks for its contents a little sooner. */
const OPEN_RADIUS = 120, FETCH_RADIUS = 90;

function PublicClusters({ root, target, pathKey, flyRequest, loading, errors, noteFor, onLoad, onFollow }: {
  root: BrowseNode; target: BrowseNode; pathKey: string; flyRequest: number; loading: Set<string>; errors: Record<string, string>;
  noteFor: ExplorePublicActions["noteFor"]; onLoad: (node: BrowseNode, auto?: boolean) => void; onFollow: (ids: string[]) => void;
}) {
  const [ref, size, element] = useSize<HTMLDivElement>();
  const circles = useMemo(() => packBrowse(root, colorOf), [root]);
  const byId = useMemo(() => {
    // The same category can sit in two places; the first one found is the one the path follows.
    const map = new Map<string, BrowseCircle>();
    for (const circle of circles) if (!map.has(circle.id)) map.set(circle.id, circle);
    return map;
  }, [circles]);
  const byKey = useMemo(() => new Map(circles.map((circle) => [circle.key, circle])), [circles]);
  const rootCircle = circles[0];
  const bounds = size.width && size.height
    ? { min: fitCircle(rootCircle, size.width, size.height, 0.47).k * 0.5, max: 1e6 }
    : { min: 1e-9, max: 1e6 };
  const { camera, fly, zoomAround, handlers, dragged } = useCirclesCamera(element, bounds);
  const { k } = camera;

  const flown = useRef<number | null>(null);
  useEffect(() => {
    if (!size.width || !size.height) return;
    const first = flown.current === null;
    if (!first && flown.current === flyRequest) return;
    flown.current = flyRequest;
    // The circle the path leads to: follow the path's ids from the root.
    const circle = byKey.get(pathKey) ?? byId.get(target.id) ?? rootCircle;
    fly(fitCircle(circle, size.width, size.height, circle.depth === 0 ? 0.47 : 0.44), !first);
  }, [flyRequest, size, target.id, byId, byKey, pathKey, rootCircle, fly]);

  const parentOf = useCallback((circle: BrowseCircle) => circle.parentKey ? byKey.get(circle.parentKey) : undefined, [byKey]);
  const openIds = useMemo(() => {
    const open = new Set<BrowseCircle>();
    for (const circle of circles) {
      if (circle.depth === 0) { open.add(circle); continue; }
      const parent = parentOf(circle);
      if (parent && open.has(parent) && circle.node.children?.length && circle.r * k > OPEN_RADIUS) open.add(circle);
    }
    return open;
  }, [circles, parentOf, k]);
  const isShown = (circle: BrowseCircle) => { const parent = parentOf(circle); return Boolean(parent && openIds.has(parent)); };
  const screen = (circle: BrowseCircle) => ({ x: circle.x * k + camera.x, y: circle.y * k + camera.y, r: circle.r * k });
  const visible = circles.filter((circle) => {
    if (circle.depth === 0 || !isShown(circle)) return false;
    const { x, y, r } = screen(circle);
    return x + r > -40 && x - r < size.width + 40 && y + r > -40 && y - r < size.height + 40;
  });

  // Circles big enough on screen ask for what is inside them, a few at a time.
  useEffect(() => {
    const wanted = visible.filter((circle) => !circle.node.children && canOpen(circle.node) && !errors[circle.id] && circle.r * k > FETCH_RADIUS)
      .sort((a, b) => b.r - a.r).slice(0, 3);
    for (const circle of wanted) onLoad(circle.node, true);
  });

  // Breadcrumbs follow the camera: the smallest open circle under the middle that still fills most of the view.
  useEffect(() => {
    if (!size.width || !size.height || flown.current === null) return;
    const cx = (size.width / 2 - camera.x) / camera.k, cy = (size.height / 2 - camera.y) / camera.k;
    const need = Math.min(size.width, size.height) * 0.6;
    let deepest: BrowseCircle | null = null;
    for (const circle of openIds) {
      if (circle.depth === 0 || Math.hypot(circle.x - cx, circle.y - cy) > circle.r || circle.r * 2 * camera.k < need) continue;
      if (!deepest || circle.depth > deepest.depth) deepest = circle;
    }
    const ids: string[] = [];
    for (let at: BrowseCircle | undefined = deepest ?? undefined; at && at.depth > 0; at = parentOf(at)) ids.unshift(at.id);
    onFollow(ids);
  }, [camera, size, openIds, parentOf, onFollow]);

  const pick = (circle: BrowseCircle) => {
    if (dragged.current) return;
    onLoad(circle.node);
    fly(fitCircle(circle, size.width, size.height));
  };
  return <div className="explore-clusters" ref={ref} {...handlers}>
    <svg width={size.width} height={size.height} role="group" aria-label="Clusters of topics">
      {visible.map((circle) => {
        const { x, y, r } = screen(circle);
        const open = openIds.has(circle);
        const node = circle.node;
        const busy = loading.has(circle.id);
        const fontSize = Math.min(15, Math.max(11, r / 5));
        const maxChars = Math.max(4, Math.floor((r * 1.8) / (fontSize * 0.6)));
        const name = node.label.length > maxChars ? `${node.label.slice(0, maxChars - 1)}…` : node.label;
        const mine = node.kind === "article" || node.kind === "topic" ? noteFor(node.label, node.topic) : null;
        return <g key={circle.key} className={`explore-cluster${open ? " is-open" : ""}${node.kind === "topic" ? " is-ai" : ""}${busy ? " is-loading" : ""}`}
          style={{ "--section": circle.color } as CSSProperties} role="button" tabIndex={0}
          aria-label={`${node.label}${node.children ? `, ${node.children.length} inside` : ""}${open ? "" : ". Open"}`}
          onClick={() => pick(circle)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); pick(circle); } }}>
          <circle cx={x} cy={y} r={r}>{errors[circle.id] ? <title>{errors[circle.id]}</title> : null}</circle>
          {mine && r > 10 ? <circle className="explore-cluster-mine" cx={x + r * 0.7} cy={y - r * 0.7} r={Math.min(7, Math.max(3, r * 0.12))}><title>In your notes</title></circle> : null}
          {open ? <text className="explore-cluster-heading" x={x} y={y - r + Math.min(22, r * 0.12) + 6} textAnchor="middle" style={{ fontSize: 14 }}>{node.label}</text>
            : r > 20 ? <>
              <text className="explore-cluster-name" x={x} y={y} textAnchor="middle" style={{ fontSize }}>{name}</text>
              {r > 40 ? <text className="explore-cluster-count" x={x} y={y + fontSize + 2} textAnchor="middle">
                {busy ? "Opening…" : errors[circle.id] ? "Tap to try again" : countText(node)}</text> : null}
            </> : <title>{node.label}</title>}
        </g>;
      })}
    </svg>
    <div className="explore-cluster-zoom">
      <button type="button" aria-label="Zoom in" onClick={() => zoomAround(1.6, size.width / 2, size.height / 2)}>+</button>
      <button type="button" aria-label="Zoom out" onClick={() => zoomAround(1 / 1.6, size.width / 2, size.height / 2)}>−</button>
    </div>
  </div>;
}
