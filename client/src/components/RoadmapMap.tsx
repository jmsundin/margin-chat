import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Conversation, RoadmapNode, RoadmapStatus } from "../types";
import { buildRoadmapGraph, getRoadmap, roadmapNodeTitle, roadmapStatus, ROADMAP_STATUS_LABELS, type RoadmapGraph } from "../lib/roadmap";
import {
  layoutRoadmapMap, mapEdgePath, mapStageHue, mapStepKey, mapSubKey, mapSubPath, type MapItem, type MapLayoutRoadmap,
} from "../lib/roadmapMapLayout";
import StatusMark, { NEXT_ROADMAP_STATUS } from "./RoadmapStatusMark";
import "./RoadmapMap.css";

/** A step and the roadmap it is in. */
export interface RoadmapMapStep { roadmapId: string; nodeId: string }

/** The roadmap a step's document holds, when it has one with steps; null otherwise. */
export function roadmapOfStep(node: RoadmapNode, conversations: Record<string, Conversation>): Conversation | null {
  if (node.target.blockId) return null;
  const target = conversations[node.target.docId];
  return target?.nodeType === "roadmap" && getRoadmap(target).nodes.length ? target : null;
}

export const openSubKey = (roadmapId: string, nodeId: string) => `${roadmapId}/${nodeId}`;

export interface RoadmapMapProps {
  conversation: Conversation;
  graph: RoadmapGraph;
  conversations: Record<string, Conversation>;
  /** Sub-roadmaps open beside their step, by `openSubKey(roadmapId, nodeId)`. */
  open: Set<string>;
  onToggle: (step: RoadmapMapStep) => void;
  selected: RoadmapMapStep | null;
  onSelect: (step: RoadmapMapStep | null) => void;
  onStatus: (step: RoadmapMapStep, status: RoadmapStatus) => void;
  /** Steps whose document is still on its way from the cloud, or gone. */
  isWaiting: (node: RoadmapNode) => boolean;
  cloudTitles: Map<string, string>;
  /** Documents AI is writing in now. */
  writingIds?: Record<string, unknown>;
  /** The selected step's details, shown beside the map. */
  detail: ReactNode;
}

type Frame = Map<string, MapItem & { o: number }>;
type Camera = { x: number; y: number; k: number };
const MIN_ZOOM = 0.25, MAX_ZOOM = 2;

const reducedMotion = () => typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
const ease = (t: number) => 1 - Math.pow(1 - t, 3);

/** Moves boxes and steps to their new places instead of jumping, so it is clear what moved aside for what. */
function useTweenedLayout(items: MapItem[], originOf: (item: MapItem) => MapItem | undefined): Frame {
  const [frame, setFrame] = useState<Frame>(() => new Map(items.map((item) => [item.key, { ...item, o: 1 }])));
  const current = useRef(frame);
  useEffect(() => {
    const target = new Map(items.map((item) => [item.key, item]));
    const from = new Map<string, MapItem & { o: number }>();
    for (const item of items) {
      const before = current.current.get(item.key);
      if (before) { from.set(item.key, before); continue; }
      // New boxes grow out of the step that opened them.
      const origin = originOf(item);
      const start = origin ? current.current.get(origin.key) ?? origin : item;
      from.set(item.key, { ...item, x: start.x + start.w * .6, y: start.y, w: item.w * .7, h: item.h * .7, o: 0 });
    }
    for (const [key, before] of current.current) if (!target.has(key)) from.set(key, before);
    const duration = reducedMotion() ? 0 : 380;
    const started = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = duration ? Math.min(1, (now - started) / duration) : 1, k = ease(t);
      const next: Frame = new Map();
      for (const [key, start] of from) {
        const end = target.get(key);
        if (end) next.set(key, { ...end, x: start.x + (end.x - start.x) * k, y: start.y + (end.y - start.y) * k,
          w: start.w + (end.w - start.w) * k, h: start.h + (end.h - start.h) * k, o: start.o + (1 - start.o) * k });
        else if (t < 1) next.set(key, { ...start, o: start.o * (1 - Math.min(1, t * 2)) });
      }
      current.current = next;
      setFrame(next);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // originOf reads the same items; the layout is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);
  return frame;
}

export default function RoadmapMap({ conversation, graph, conversations, open, onToggle, selected, onSelect, onStatus, isWaiting, cloudTitles, writingIds, detail }: RoadmapMapProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 900, height: 560 });
  const [hovered, setHovered] = useState<RoadmapMapStep | null>(null);

  // Every roadmap on the map: this one and each open sub-roadmap, once each.
  const { graphs, opened } = useMemo(() => {
    const graphs = new Map<string, { graph: RoadmapGraph; title: string }>([[conversation.id, { graph, title: conversation.title }]]);
    const opened = new Map<string, string>();
    const walk = (roadmapId: string, current: RoadmapGraph) => {
      for (const node of current.roadmap.nodes) {
        if (!open.has(openSubKey(roadmapId, node.id))) continue;
        const sub = roadmapOfStep(node, conversations);
        if (!sub || graphs.has(sub.id)) continue;
        const subGraph = buildRoadmapGraph(getRoadmap(sub), conversations);
        graphs.set(sub.id, { graph: subGraph, title: sub.title });
        opened.set(openSubKey(roadmapId, node.id), sub.id);
        walk(sub.id, subGraph);
      }
    };
    walk(conversation.id, graph);
    return { graphs, opened };
  }, [conversation.id, conversation.title, graph, conversations, open]);

  const layout = useMemo(() => {
    const input = (roadmapId: string): MapLayoutRoadmap => ({
      id: roadmapId,
      stages: graphs.get(roadmapId)!.graph.stages.map((stage) => ({ id: stage.id || "unstaged", title: stage.title, nodeIds: stage.rows.flatMap((row) => row.nodeIds) })),
      sub: (nodeId) => { const id = opened.get(openSubKey(roadmapId, nodeId)); return id ? input(id) : null; },
    });
    // Rows wrap so the whole roadmap fits the map as large as it can.
    return layoutRoadmapMap(input(conversation.id), Math.max(640, Math.min(1500, size.width * 1.15)), { width: size.width - 56, height: size.height - 80 });
  }, [graphs, opened, conversation.id, size]);

  const byKey = useMemo(() => new Map(layout.items.map((item) => [item.key, item])), [layout]);
  const frame = useTweenedLayout(layout.items, (item) => {
    if (item.kind !== "sub") return undefined;
    return byKey.get(mapStepKey(item.parentRoadmapId!, item.id));
  });

  // ---- Camera: drag to move, pinch or ⌘/Ctrl + scroll to zoom ----
  const camera = useRef<Camera>({ x: 24, y: 24, k: 1 });
  const cameraAnimation = useRef(0);
  const applyCamera = useCallback(() => {
    const el = world.current; if (!el) return;
    const { x, y, k } = camera.current;
    el.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
    el.style.setProperty("--roadmap-map-inv", Math.min(2.4, Math.max(1, 1 / k)).toFixed(3));
  }, []);
  const moveCamera = useCallback((to: Camera) => {
    cancelAnimationFrame(cameraAnimation.current);
    const from = { ...camera.current }, started = performance.now(), duration = reducedMotion() ? 0 : 360;
    const step = (now: number) => {
      const t = duration ? Math.min(1, (now - started) / duration) : 1, k = ease(t);
      camera.current = { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k, k: from.k + (to.k - from.k) * k };
      applyCamera();
      if (t < 1) cameraAnimation.current = requestAnimationFrame(step);
    };
    cameraAnimation.current = requestAnimationFrame(step);
  }, [applyCamera]);
  const panelWidth = useCallback(() => {
    const panel = viewport.current?.querySelector<HTMLElement>(".roadmap-map-panel");
    return panel && getComputedStyle(panel).position === "absolute" ? panel.offsetWidth + 16 : 0;
  }, []);
  const fit = useCallback((keys?: string[], maxZoom = 1) => {
    const el = viewport.current; if (!el) return;
    const boxes = (keys ?? [...byKey.keys()]).map((key) => byKey.get(key)).filter(Boolean) as MapItem[];
    if (!boxes.length) return;
    const x1 = Math.min(...boxes.map((b) => b.x)), y1 = Math.min(...boxes.map((b) => b.y));
    const x2 = Math.max(...boxes.map((b) => b.x + b.w)), y2 = Math.max(...boxes.map((b) => b.y + b.h));
    const W = el.clientWidth - panelWidth(), H = el.clientHeight, pad = 28, bottom = 52;
    const k = Math.max(MIN_ZOOM, Math.min(maxZoom, (W - pad * 2) / (x2 - x1 || 1), (H - pad - bottom) / (y2 - y1 || 1)));
    moveCamera({ k, x: (W - (x2 - x1) * k) / 2 - x1 * k, y: pad + (H - pad - bottom - (y2 - y1) * k) / 2 - y1 * k });
  }, [byKey, moveCamera, panelWidth]);
  /** Pan just enough to bring a box into view, or fit it when it is bigger than the view. */
  const reveal = useCallback((key: string) => {
    const el = viewport.current, box = byKey.get(key); if (!el || !box) return;
    const W = el.clientWidth - panelWidth(), H = el.clientHeight;
    let { x, y } = camera.current; const { k } = camera.current;
    const sx = box.x * k + x, sy = box.y * k + y, sw = box.w * k, sh = box.h * k;
    if (sw > W - 40 || sh > H - 80) { fit([key]); return; }
    if (sx + sw > W - 20) x -= sx + sw - (W - 20);
    if (sx < 20) x += 20 - sx;
    if (sy + sh > H - 56) y -= sy + sh - (H - 56);
    if (sy < 16) y += 16 - sy;
    if (x !== camera.current.x || y !== camera.current.y) moveCamera({ x, y, k });
  }, [byKey, fit, moveCamera, panelWidth]);

  useLayoutEffect(() => {
    const el = viewport.current; if (!el) return;
    const measure = () => setSize((current) => current.width === el.clientWidth && current.height === el.clientHeight ? current : { width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(el);
    return () => observer?.disconnect();
  }, []);
  // First view: the whole roadmap, readable.
  const fitted = useRef(false);
  useEffect(() => { if (!fitted.current && byKey.size) { fitted.current = true; fit(undefined, 1); } }, [byKey, fit]);
  useEffect(() => { applyCamera(); }, [applyCamera]);
  // A newly opened sub-roadmap, or a newly selected step, comes into view once it has moved into place.
  const lastOpened = useRef(new Set(opened.keys()));
  useEffect(() => {
    const added = [...opened.keys()].filter((key) => !lastOpened.current.has(key));
    lastOpened.current = new Set(opened.keys());
    if (!added.length) return;
    const [roadmapId, nodeId] = [added[0].slice(0, added[0].lastIndexOf("/")), added[0].slice(added[0].lastIndexOf("/") + 1)];
    const timer = window.setTimeout(() => reveal(mapSubKey(roadmapId, nodeId)), 400);
    return () => window.clearTimeout(timer);
  }, [opened, reveal]);
  useEffect(() => {
    if (!selected) return;
    const timer = window.setTimeout(() => reveal(mapStepKey(selected.roadmapId, selected.nodeId)), 40);
    return () => window.clearTimeout(timer);
  }, [selected, reveal]);

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean; pinch?: { d: number; k: number } } | null>(null);
  const zoomAt = useCallback((factor: number, px: number, py: number) => {
    cancelAnimationFrame(cameraAnimation.current);
    const { x, y, k } = camera.current, next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k * factor));
    camera.current = { k: next, x: px - (px - x) * (next / k), y: py - (py - y) * (next / k) };
    applyCamera();
  }, [applyCamera]);
  useEffect(() => {
    const el = viewport.current; if (!el) return;
    const wheel = (event: WheelEvent) => {
      if ((event.target as HTMLElement).closest(".roadmap-map-panel")) return;
      event.preventDefault();
      const box = el.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) zoomAt(Math.exp(-event.deltaY * .0035), event.clientX - box.left, event.clientY - box.top);
      else { cancelAnimationFrame(cameraAnimation.current); camera.current = { ...camera.current, x: camera.current.x - event.deltaX, y: camera.current.y - event.deltaY }; applyCamera(); }
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [zoomAt, applyCamera]);

  function pointerDown(event: React.PointerEvent) {
    if ((event.target as HTMLElement).closest(".roadmap-map-panel, .roadmap-map-controls")) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 1) drag.current = { x: event.clientX, y: event.clientY, cx: camera.current.x, cy: camera.current.y, moved: false };
    if (pointers.current.size === 2 && drag.current) {
      const [a, b] = [...pointers.current.values()];
      drag.current.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: camera.current.k };
    }
  }
  function pointerMove(event: React.PointerEvent) {
    if (!pointers.current.has(event.pointerId) || !drag.current) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const state = drag.current;
    if (pointers.current.size === 2 && state.pinch) {
      const [a, b] = [...pointers.current.values()], box = viewport.current!.getBoundingClientRect();
      zoomAt(state.pinch.k * Math.hypot(a.x - b.x, a.y - b.y) / state.pinch.d / camera.current.k, (a.x + b.x) / 2 - box.left, (a.y + b.y) / 2 - box.top);
      state.moved = true;
      return;
    }
    const dx = event.clientX - state.x, dy = event.clientY - state.y;
    if (!state.moved && Math.hypot(dx, dy) < 5) return;
    if (!state.moved) { state.moved = true; viewport.current?.setPointerCapture?.(event.pointerId); viewport.current?.classList.add("is-panning"); }
    cancelAnimationFrame(cameraAnimation.current);
    camera.current = { ...camera.current, x: state.cx + dx, y: state.cy + dy };
    applyCamera();
  }
  function pointerUp(event: React.PointerEvent) {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2 && drag.current) delete drag.current.pinch;
    if (!pointers.current.size) {
      viewport.current?.classList.remove("is-panning");
      // A drag that ended on a step doesn't also open it.
      if (drag.current?.moved) window.setTimeout(() => { drag.current = null; }, 0);
      else drag.current = null;
    }
  }
  const swallowClickAfterDrag = (event: React.MouseEvent) => { if (drag.current?.moved) { event.stopPropagation(); event.preventDefault(); } };

  // ---- Tracing: what a hovered (or selected) step needs and what it unlocks ----
  const focus = hovered ?? selected;
  const trace = useMemo(() => {
    if (!focus) return null;
    const entry = graphs.get(focus.roadmapId); if (!entry) return null;
    const up = new Set<string>(), down = new Set<string>();
    const walk = (id: string, links: Map<string, string[]>, into: Set<string>) => { for (const next of links.get(id) ?? []) if (!into.has(next)) { into.add(next); walk(next, links, into); } };
    walk(focus.nodeId, entry.graph.needs, up);
    walk(focus.nodeId, entry.graph.neededBy, down);
    return { roadmapId: focus.roadmapId, all: new Set([focus.nodeId, ...up, ...down]), up };
  }, [focus, graphs]);

  // ---- Lines ----
  const lines = useMemo(() => {
    const result: { key: string; d: string; className: string }[] = [];
    for (const [roadmapId, { graph: current }] of graphs) {
      const order = new Map(current.stages.flatMap((stage) => stage.rows.flatMap((row) => row.nodeIds)).map((id, index) => [id, index]));
      const ignored = new Set(current.cycleEdges.map((edge) => `${edge.from}\0${edge.to}`));
      for (const edge of current.edges) {
        if (ignored.has(`${edge.from}\0${edge.to}`)) continue;
        const from = frame.get(mapStepKey(roadmapId, edge.to)), to = frame.get(mapStepKey(roadmapId, edge.from));
        if (!from || !to) continue;
        const before = current.nodesById.get(edge.to)!, after = current.nodesById.get(edge.from)!;
        const sameStage = before.stage === after.stage;
        const adjacent = sameStage && Math.abs((order.get(edge.to) ?? 0) - (order.get(edge.from) ?? 0)) === 1;
        const status = roadmapStatus(before);
        const lit = trace?.roadmapId === roadmapId && trace.all.has(edge.to) && trace.all.has(edge.from);
        result.push({ key: `${roadmapId}/${edge.to}>${edge.from}`, d: mapEdgePath(from, to, sameStage, adjacent),
          className: ["roadmap-map-line", sameStage ? "" : "is-across", status === "done" || status === "skipped" ? "is-finished" : "", lit ? "is-lit" : "",
            Math.min(from.o, to.o) < 1 ? "is-fading" : ""].filter(Boolean).join(" ") });
      }
    }
    for (const item of frame.values()) {
      if (item.kind !== "sub") continue;
      const step = frame.get(mapStepKey(item.parentRoadmapId!, item.id));
      if (step) result.push({ key: item.key, d: mapSubPath(step, item), className: "roadmap-map-line is-sub" });
    }
    return result;
  }, [graphs, frame, trace]);

  const title = (roadmapId: string, node: RoadmapNode) => {
    if (isWaiting(node)) return node.title ?? cloudTitles.get(node.target.docId) ?? "Loading…";
    const missing = graphs.get(roadmapId)?.graph.missing.has(node.id);
    return missing ? node.title ?? "Missing document" : roadmapNodeTitle(node, conversations);
  };

  function renderItem(item: MapItem & { o: number }) {
    const style = { transform: `translate(${item.x}px, ${item.y}px)`, width: item.w, height: item.h, opacity: item.o < 1 ? item.o : undefined, zIndex: item.depth * 10 + (item.kind === "sub" ? 0 : item.kind === "stage" ? 1 : 2) };
    if (item.kind === "stage") {
      const stage = graphs.get(item.roadmapId)?.graph.stages.find((entry) => (entry.id || "unstaged") === item.id);
      if (!stage) return null;
      const fraction = stage.total ? stage.finished / stage.total : 0, circumference = 2 * Math.PI * 6;
      return <section key={item.key} className="roadmap-map-stage" style={{ ...style, ["--roadmap-stage-hue" as string]: mapStageHue(stage.id || "unstaged") }} aria-label={stage.title}>
        <header>
          <h3 title={stage.title}>{stage.title}</h3>
          <span className="roadmap-map-count">{stage.finished}/{stage.total}</span>
          <svg className="roadmap-map-ring" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="6" /><circle cx="8" cy="8" r="6" className="is-fill" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - fraction)} transform="rotate(-90 8 8)" />
          </svg>
        </header>
      </section>;
    }
    if (item.kind === "sub") {
      const entry = graphs.get(item.roadmapId);
      const parent = graphs.get(item.parentRoadmapId!)?.graph.nodesById.get(item.id);
      return <section key={item.key} className="roadmap-map-sub" style={style} aria-label={`Roadmap of ${entry?.title ?? "step"}`}>
        <header>
          <span className="roadmap-map-kicker">Roadmap of</span>
          <strong title={entry?.title}>{entry?.title || (parent ? title(item.parentRoadmapId!, parent) : "Step")}</strong>
          {entry ? <span className="roadmap-map-count">{entry.graph.finished} of {entry.graph.total} done</span> : null}
          <button type="button" aria-label="Close this roadmap" title="Close" onClick={() => onToggle({ roadmapId: item.parentRoadmapId!, nodeId: item.id })}>×</button>
        </header>
      </section>;
    }
    const entry = graphs.get(item.roadmapId);
    const node = entry?.graph.nodesById.get(item.id);
    if (!entry || !node) return null;
    const status = roadmapStatus(node);
    const pending = isWaiting(node);
    const missing = entry.graph.missing.has(node.id) && !pending;
    const next = entry.graph.nextUp.has(node.id);
    const name = title(item.roadmapId, node);
    const sub = roadmapOfStep(node, conversations);
    const subGraph = sub ? graphs.get(sub.id)?.graph ?? buildRoadmapGraph(getRoadmap(sub), conversations) : null;
    const isOpen = open.has(openSubKey(item.roadmapId, node.id)) && Boolean(sub);
    const isSelected = selected?.roadmapId === item.roadmapId && selected.nodeId === node.id;
    const lit = trace?.roadmapId === item.roadmapId && trace.all.has(node.id);
    const writing = Boolean(writingIds?.[node.target.docId]);
    const step = { roadmapId: item.roadmapId, nodeId: node.id };
    return <div key={item.key} style={style} data-roadmap-map-step={item.key}
      className={["roadmap-map-step", `is-${status}`, next ? "is-next" : "", missing ? "is-missing" : "", pending ? "is-pending" : "",
        isSelected ? "is-selected" : "", lit ? "is-lit" : "", lit && trace!.up.has(node.id) ? "is-before" : ""].filter(Boolean).join(" ")}
      onPointerEnter={() => setHovered(step)} onPointerLeave={() => setHovered((current) => current?.nodeId === node.id ? null : current)}>
      {missing ? <span className="roadmap-map-mark" aria-hidden="true">?</span> : pending ? <span className="roadmap-map-mark" aria-hidden="true"><StatusMark status={status} /></span>
        : <button type="button" className="roadmap-map-mark" title={`Mark ${ROADMAP_STATUS_LABELS[NEXT_ROADMAP_STATUS[status]].toLowerCase()}`}
          aria-label={`${name}: ${ROADMAP_STATUS_LABELS[status]}. Mark ${ROADMAP_STATUS_LABELS[NEXT_ROADMAP_STATUS[status]].toLowerCase()}`}
          onClick={() => onStatus(step, NEXT_ROADMAP_STATUS[status])}><StatusMark status={status} /></button>}
      <button type="button" className="roadmap-map-open" aria-pressed={isSelected}
        aria-label={`${name}${missing ? ", target missing" : next ? ", next up" : ""}. Show details`}
        onClick={() => onSelect(isSelected ? null : step)} onFocus={() => setHovered(step)} onBlur={() => setHovered(null)}>
        <span className="roadmap-map-title" title={name}>{name}</span>
        {writing ? <span className="roadmap-map-writing" title="AI is writing in this step's document" /> : null}
        {next ? <span className="roadmap-map-tag">Next up</span> : null}
      </button>
      {subGraph ? <button type="button" className={`roadmap-map-chip${isOpen ? " is-open" : ""}`} aria-expanded={isOpen}
        title={isOpen ? "Close its roadmap" : "Open its roadmap beside this step"} aria-label={`${isOpen ? "Close" : "Open"} the roadmap of ${name} (${subGraph.finished} of ${subGraph.total} done)`}
        onClick={() => onToggle(step)}>
        {subGraph.finished}/{subGraph.total}
        <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 2l3 3-3 3" /></svg>
      </button> : null}
    </div>;
  }

  const nextKeys = useMemo(() => [...graphs].flatMap(([roadmapId, { graph: current }]) => [...current.nextUp].map((id) => mapStepKey(roadmapId, id))), [graphs]);

  return <div className={`roadmap-map${detail ? " has-panel" : ""}`} ref={viewport}
    onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onClickCapture={swallowClickAfterDrag}>
    <div className={`roadmap-map-world${trace && hovered ? " is-tracing" : ""}`} ref={world}>
      <svg className="roadmap-map-lines" aria-hidden="true">
        {lines.map((line) => <path key={line.key} d={line.d} className={line.className} />)}
      </svg>
      {[...frame.values()].map(renderItem)}
    </div>
    <div className="roadmap-map-controls">
      <button type="button" aria-label="Zoom out" onClick={() => { const el = viewport.current!; zoomAt(.8, el.clientWidth / 2, el.clientHeight / 2); }}>−</button>
      <button type="button" onClick={() => fit(undefined, 1)}>Fit</button>
      {nextKeys.length ? <button type="button" onClick={() => fit(nextKeys, 1.1)}>Next up</button> : null}
      <button type="button" aria-label="Zoom in" onClick={() => { const el = viewport.current!; zoomAt(1.25, el.clientWidth / 2, el.clientHeight / 2); }}>+</button>
    </div>
    {detail ? <div className="roadmap-map-panel">{detail}</div> : null}
  </div>;
}
