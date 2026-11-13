import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Conversation, RoadmapNode, RoadmapStatus } from "../types";
import { buildRoadmapGraph, getRoadmap, roadmapNodeTitle, roadmapStatus, ROADMAP_STATUS_LABELS, type RoadmapGraph } from "../lib/roadmap";
import {
  layoutRoadmapList, layoutRoadmapMap, mapEdgePath, mapStageHue, mapStepKey, mapSubKey, mapSubPath, type MapItem, type MapLayoutRoadmap,
} from "../lib/roadmapMapLayout";
import StatusMark, { NEXT_ROADMAP_STATUS } from "./RoadmapStatusMark";
import "./RoadmapCanvas.css";

/** A step and the roadmap it is in. */
export interface RoadmapStep { roadmapId: string; nodeId: string }
export type RoadmapLayoutMode = "map" | "list";
export type RoadmapFilter = "all" | "next" | "open" | "done";

/** The roadmap a step's document holds, when it has one with steps; null otherwise. */
export function roadmapOfStep(node: RoadmapNode, conversations: Record<string, Conversation>): Conversation | null {
  if (node.target.blockId) return null;
  const target = conversations[node.target.docId];
  return target?.nodeType === "roadmap" && getRoadmap(target).nodes.length ? target : null;
}

export const openSubKey = (roadmapId: string, nodeId: string) => `${roadmapId}/${nodeId}`;

export interface RoadmapCanvasProps {
  /** The roadmap the canvas shows; the roadmaps open inside it are drawn around it. */
  roadmap: Conversation;
  graph: RoadmapGraph;
  conversations: Record<string, Conversation>;
  layout: RoadmapLayoutMode;
  filter: RoadmapFilter;
  /** Sub-roadmaps open beside (Map) or under (List) their step, by `openSubKey(roadmapId, nodeId)`. */
  open: Set<string>;
  onToggle: (step: RoadmapStep) => void;
  /** Go into a step's own roadmap: it becomes the roadmap on the canvas. */
  onEnter: (step: RoadmapStep) => void;
  selected: RoadmapStep | null;
  onSelect: (step: RoadmapStep) => void;
  onStatus: (step: RoadmapStep, status: RoadmapStatus) => void;
  /** A step dropped into another stage of its roadmap. */
  onMove: (step: RoadmapStep, stageId: string) => void;
  /** A step's dot dropped on another step: that step needs this one first. */
  onLink: (prerequisite: RoadmapStep, step: RoadmapStep) => void;
  onAddStep: (roadmapId: string, stageId: string) => void;
  onRenameStage: (roadmapId: string, stageId: string, title: string) => void;
  onMoveStage: (roadmapId: string, stageId: string, direction: -1 | 1) => void;
  onRemoveStage: (roadmapId: string, stageId: string) => void;
  cloudTitles: Map<string, string>;
  /** Documents AI is writing in now. */
  writingIds?: Record<string, unknown>;
  /** How much of the canvas the open document covers, so steps are kept clear of it. */
  cover: { right: number; bottom: number };
  /** Changes when the whole roadmap should be fitted to the view again (a new layout or roadmap). */
  fitKey: string;
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
    const duration = reducedMotion() ? 0 : 400;
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

type Gesture =
  | { kind: "pan"; x: number; y: number; cx: number; cy: number; moved: boolean; pinch?: { d: number; k: number } }
  | { kind: "card"; step: RoadmapStep; key: string; x: number; y: number; moved: boolean }
  | { kind: "link"; step: RoadmapStep; key: string; x: number; y: number; moved: boolean };

/**
 * A roadmap drawn like the Map: stages are tinted boxes of steps with lines from
 * what a step needs to the step. Map lays the stages side by side; List stacks the
 * very same boxes one under another. Steps are dragged between stages, and a step's
 * dot is dragged onto a step that needs it.
 */
export default function RoadmapCanvas(props: RoadmapCanvasProps) {
  const { roadmap, graph, conversations, layout, filter, open, onToggle, onEnter, selected, onSelect, onStatus, cloudTitles, writingIds, cover, fitKey } = props;
  const viewport = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 900, height: 560 });
  const [hovered, setHovered] = useState<RoadmapStep | null>(null);

  // Every roadmap on the canvas: this one and each open sub-roadmap, once each.
  const { graphs, opened } = useMemo(() => {
    const graphs = new Map<string, { graph: RoadmapGraph; title: string }>([[roadmap.id, { graph, title: roadmap.title }]]);
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
    walk(roadmap.id, graph);
    return { graphs, opened };
  }, [roadmap.id, roadmap.title, graph, conversations, open]);

  const listCover = layout === "list" ? cover.right : 0;
  const isWaiting = useCallback((node: RoadmapNode) => !conversations[node.target.docId] && cloudTitles.has(node.target.docId), [conversations, cloudTitles]);

  const layoutResult = useMemo(() => {
    const input = (roadmapId: string): MapLayoutRoadmap => ({
      id: roadmapId, adds: true,
      stages: graphs.get(roadmapId)!.graph.stages.map((stage) => ({ id: stage.id || "unstaged", title: stage.title, nodeIds: stage.rows.flatMap((row) => row.nodeIds) })),
      sub: (nodeId) => { const id = opened.get(openSubKey(roadmapId, nodeId)); return id ? input(id) : null; },
    });
    // The list keeps to the part of the canvas the open document leaves free.
    if (layout === "list") return layoutRoadmapList(input(roadmap.id), Math.min(720, size.width - listCover - 32));
    // Rows wrap so the whole roadmap fits the canvas as large as it can.
    return layoutRoadmapMap(input(roadmap.id), Math.max(640, Math.min(1500, size.width * 1.15)), { width: size.width - 56, height: size.height - 80 });
  }, [graphs, opened, roadmap.id, size, layout, listCover]);

  const byKey = useMemo(() => new Map(layoutResult.items.map((item) => [item.key, item])), [layoutResult]);
  const frame = useTweenedLayout(layoutResult.items, (item) => item.kind === "sub" ? byKey.get(mapStepKey(item.parentRoadmapId!, item.id)) : undefined);

  // ---- Camera: drag to move, pinch or ⌘/Ctrl + scroll to zoom, scroll to move ----
  const camera = useRef<Camera>({ x: 24, y: 24, k: 1 });
  const cameraAnimation = useRef(0);
  const applyCamera = useCallback(() => {
    const el = world.current; if (!el) return;
    const { x, y, k } = camera.current;
    el.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
    el.style.setProperty("--roadmap-canvas-inv", Math.min(2.4, Math.max(1, 1 / k)).toFixed(3));
  }, []);
  const moveCamera = useCallback((to: Camera) => {
    cancelAnimationFrame(cameraAnimation.current);
    const from = { ...camera.current }, started = performance.now(), duration = reducedMotion() ? 0 : 380;
    const step = (now: number) => {
      const t = duration ? Math.min(1, (now - started) / duration) : 1, k = ease(t);
      camera.current = { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k, k: from.k + (to.k - from.k) * k };
      applyCamera();
      if (t < 1) cameraAnimation.current = requestAnimationFrame(step);
    };
    cameraAnimation.current = requestAnimationFrame(step);
  }, [applyCamera]);
  const coverRef = useRef(cover);
  coverRef.current = cover;
  const fit = useCallback((keys?: string[], maxZoom = 1) => {
    const el = viewport.current; if (!el) return;
    const boxes = (keys ?? [...byKey.keys()]).map((key) => byKey.get(key)).filter(Boolean) as MapItem[];
    const W = el.clientWidth - coverRef.current.right, H = el.clientHeight - coverRef.current.bottom;
    if (!boxes.length) { moveCamera({ x: 24, y: 24, k: 1 }); return; }
    const x1 = Math.min(...boxes.map((b) => b.x)), y1 = Math.min(...boxes.map((b) => b.y));
    const x2 = Math.max(...boxes.map((b) => b.x + b.w)), y2 = Math.max(...boxes.map((b) => b.y + b.h));
    // The list reads from the top at full width, like a page.
    if (layout === "list" && !keys) {
      const k = Math.max(MIN_ZOOM, Math.min(1, (W - 32) / (x2 - x1 || 1)));
      moveCamera({ k, x: (W - (x2 - x1) * k) / 2 - x1 * k, y: 16 - y1 * k });
      return;
    }
    const pad = 28, bottom = 56;
    const k = Math.max(MIN_ZOOM, Math.min(maxZoom, (W - pad * 2) / (x2 - x1 || 1), (H - pad - bottom) / (y2 - y1 || 1)));
    moveCamera({ k, x: (W - (x2 - x1) * k) / 2 - x1 * k, y: pad + Math.max(0, (H - pad - bottom - (y2 - y1) * k) / 2) - y1 * k });
  }, [byKey, moveCamera, layout]);
  /** Pan just enough to bring a box into view, or fit it when it is bigger than the view. */
  const reveal = useCallback((key: string) => {
    const el = viewport.current, box = byKey.get(key); if (!el || !box) return;
    const W = el.clientWidth - coverRef.current.right, H = el.clientHeight - coverRef.current.bottom;
    let { x, y } = camera.current; const { k } = camera.current;
    const sx = box.x * k + x, sy = box.y * k + y, sw = box.w * k, sh = box.h * k;
    if (sw > W - 40 || sh > H - 80) { if (layout === "map") fit([key]); else moveCamera({ x, y: 16 - box.y * k, k }); return; }
    if (sx + sw > W - 20) x -= sx + sw - (W - 20);
    if (sx < 20) x += 20 - sx;
    if (sy + sh > H - 60) y -= sy + sh - (H - 60);
    if (sy < 16) y += 16 - sy;
    if (x !== camera.current.x || y !== camera.current.y) moveCamera({ x, y, k });
  }, [byKey, fit, moveCamera, layout]);

  useLayoutEffect(() => {
    const el = viewport.current; if (!el) return;
    const measure = () => setSize((current) => current.width === el.clientWidth && current.height === el.clientHeight ? current : { width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(el);
    return () => observer?.disconnect();
  }, []);
  useEffect(() => { applyCamera(); }, [applyCamera]);
  // The whole roadmap, readable, when it first shows, after a new layout or roadmap, and when the canvas changes size.
  const lastFit = useRef("");
  useEffect(() => {
    if (!byKey.size) return;
    const key = `${fitKey}|${size.width}x${size.height}`;
    if (lastFit.current === key) return;
    const first = !lastFit.current;
    // Marked done only once it runs, so a re-render in between doesn't lose it.
    const timer = window.setTimeout(() => { lastFit.current = key; fit(); }, first ? 0 : 60);
    return () => window.clearTimeout(timer);
  }, [byKey, fit, fitKey, size]);
  // A newly opened sub-roadmap, or a newly selected step, comes into view once it has moved into place.
  const lastOpened = useRef(new Set(opened.keys()));
  useEffect(() => {
    const added = [...opened.keys()].filter((key) => !lastOpened.current.has(key));
    lastOpened.current = new Set(opened.keys());
    if (!added.length) return;
    const split = added[0].lastIndexOf("/");
    const timer = window.setTimeout(() => reveal(mapSubKey(added[0].slice(0, split), added[0].slice(split + 1))), 440);
    return () => window.clearTimeout(timer);
  }, [opened, reveal]);
  useEffect(() => {
    if (!selected) return;
    const timer = window.setTimeout(() => reveal(mapStepKey(selected.roadmapId, selected.nodeId)), 60);
    return () => window.clearTimeout(timer);
  }, [selected, reveal, cover.right, cover.bottom]);

  const zoomAt = useCallback((factor: number, px: number, py: number) => {
    cancelAnimationFrame(cameraAnimation.current);
    const { x, y, k } = camera.current, next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k * factor));
    camera.current = { k: next, x: px - (px - x) * (next / k), y: py - (py - y) * (next / k) };
    applyCamera();
  }, [applyCamera]);
  useEffect(() => {
    const el = viewport.current; if (!el) return;
    const wheel = (event: WheelEvent) => {
      if ((event.target as HTMLElement).closest(".roadmap-canvas-controls")) return;
      event.preventDefault();
      const box = el.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) zoomAt(Math.exp(-event.deltaY * .0035), event.clientX - box.left, event.clientY - box.top);
      else { cancelAnimationFrame(cameraAnimation.current); camera.current = { ...camera.current, x: camera.current.x - event.deltaX, y: camera.current.y - event.deltaY }; applyCamera(); }
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [zoomAt, applyCamera]);

  // ---- Pointer: pan, drag a step to another stage, drag its dot onto a step that needs it ----
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState<{ key: string; dx: number; dy: number; stageKey: string | null } | null>(null);
  const [linking, setLinking] = useState<{ from: string; x: number; y: number; target: string | null } | null>(null);
  const toWorld = (clientX: number, clientY: number) => {
    const box = viewport.current!.getBoundingClientRect(), { x, y, k } = camera.current;
    return { x: (clientX - box.left - x) / k, y: (clientY - box.top - y) / k };
  };
  /** The stage box of a roadmap under a point, innermost first. */
  const stageAt = (point: { x: number; y: number }, roadmapId: string) => {
    let found: MapItem | null = null;
    for (const item of layoutResult.items) {
      if (item.kind !== "stage" || item.roadmapId !== roadmapId) continue;
      if (point.x >= item.x && point.x <= item.x + item.w && point.y >= item.y && point.y <= item.y + item.h) found = item;
    }
    return found;
  };
  const stepAt = (clientX: number, clientY: number) => {
    const el = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-roadmap-step]");
    return el?.dataset.roadmapStep ?? null;
  };

  function pointerDown(event: React.PointerEvent) {
    const target = event.target as HTMLElement;
    if (target.closest(".roadmap-canvas-controls, input, .roadmap-canvas-menu")) return;
    if (event.button !== 0 && event.pointerType === "mouse") return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { kind: "pan", x: a.x, y: a.y, cx: camera.current.x, cy: camera.current.y, moved: true, pinch: { d: Math.hypot(a.x - b.x, a.y - b.y), k: camera.current.k } };
      setDragging(null); setLinking(null);
      return;
    }
    const card = target.closest<HTMLElement>("[data-roadmap-step]");
    const handle = target.closest("[data-roadmap-link]");
    if (card && handle) {
      const [roadmapId, nodeId] = card.dataset.roadmapStepId!.split("\0");
      gesture.current = { kind: "link", step: { roadmapId, nodeId }, key: card.dataset.roadmapStep!, x: event.clientX, y: event.clientY, moved: false };
    } else if (card && !target.closest("button:not(.roadmap-canvas-open)")) {
      const [roadmapId, nodeId] = card.dataset.roadmapStepId!.split("\0");
      gesture.current = { kind: "card", step: { roadmapId, nodeId }, key: card.dataset.roadmapStep!, x: event.clientX, y: event.clientY, moved: false };
    } else if (!target.closest("button")) {
      gesture.current = { kind: "pan", x: event.clientX, y: event.clientY, cx: camera.current.x, cy: camera.current.y, moved: false };
    } else gesture.current = null;
  }
  function pointerMove(event: React.PointerEvent) {
    const state = gesture.current;
    if (!pointers.current.has(event.pointerId) || !state) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (state.kind === "pan" && state.pinch) {
      if (pointers.current.size < 2) return;
      const [a, b] = [...pointers.current.values()], box = viewport.current!.getBoundingClientRect();
      zoomAt(state.pinch.k * Math.hypot(a.x - b.x, a.y - b.y) / state.pinch.d / camera.current.k, (a.x + b.x) / 2 - box.left, (a.y + b.y) / 2 - box.top);
      return;
    }
    const dx = event.clientX - state.x, dy = event.clientY - state.y;
    if (!state.moved && Math.hypot(dx, dy) < 6) return;
    if (!state.moved) {
      state.moved = true;
      viewport.current?.setPointerCapture?.(event.pointerId);
      if (state.kind === "pan") viewport.current?.classList.add("is-panning");
      setHovered(null);
    }
    if (state.kind === "pan") {
      cancelAnimationFrame(cameraAnimation.current);
      camera.current = { ...camera.current, x: state.cx + dx, y: state.cy + dy };
      applyCamera();
    } else if (state.kind === "card") {
      const over = stageAt(toWorld(event.clientX, event.clientY), state.step.roadmapId);
      setDragging({ key: state.key, dx: dx / camera.current.k, dy: dy / camera.current.k, stageKey: over?.key ?? null });
    } else {
      const point = toWorld(event.clientX, event.clientY), over = stepAt(event.clientX, event.clientY);
      const sameMap = over && over !== state.key && byKey.get(over)?.roadmapId === state.step.roadmapId;
      setLinking({ from: state.key, x: point.x, y: point.y, target: sameMap ? over : null });
    }
  }
  function pointerUp(event: React.PointerEvent) {
    pointers.current.delete(event.pointerId);
    const state = gesture.current;
    if (pointers.current.size) return;
    gesture.current = null;
    viewport.current?.classList.remove("is-panning");
    if (!state?.moved) return;
    // A drag that ended on a step doesn't also open it.
    suppressClick.current = true;
    window.setTimeout(() => { suppressClick.current = false; }, 0);
    if (state.kind === "card") {
      const over = stageAt(toWorld(event.clientX, event.clientY), state.step.roadmapId);
      const node = graphs.get(state.step.roadmapId)?.graph.nodesById.get(state.step.nodeId);
      if (over && node && over.id !== (node.stage || "unstaged")) props.onMove(state.step, over.id);
      setDragging(null);
    } else if (state.kind === "link") {
      const over = stepAt(event.clientX, event.clientY), item = over ? byKey.get(over) : null;
      if (item && item.kind === "step" && item.roadmapId === state.step.roadmapId && item.id !== state.step.nodeId) props.onLink(state.step, { roadmapId: item.roadmapId, nodeId: item.id });
      setLinking(null);
    }
  }
  const swallowClickAfterDrag = (event: React.MouseEvent) => { if (suppressClick.current) { event.stopPropagation(); event.preventDefault(); } };

  // ---- Tracing: what a hovered (or selected) step needs and what it unlocks ----
  const focus = hovered ?? (dragging || linking ? null : selected);
  const trace = useMemo(() => {
    if (!focus) return null;
    const entry = graphs.get(focus.roadmapId); if (!entry) return null;
    const up = new Set<string>(), down = new Set<string>();
    const walk = (id: string, links: Map<string, string[]>, into: Set<string>) => { for (const next of links.get(id) ?? []) if (!into.has(next)) { into.add(next); walk(next, links, into); } };
    walk(focus.nodeId, entry.graph.needs, up);
    walk(focus.nodeId, entry.graph.neededBy, down);
    return { roadmapId: focus.roadmapId, all: new Set([focus.nodeId, ...up, ...down]), up };
  }, [focus, graphs]);

  // ---- Lines, one layer per nesting depth so a map opened on top covers the lines under it ----
  const lineLayers = useMemo(() => {
    const layers: { key: string; d: string; className: string }[][] = [];
    const add = (depth: number, line: { key: string; d: string; className: string }) => { (layers[depth] ??= []).push(line); };
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
        // A list reads top to bottom, so lines between stages show only for the step in focus.
        const quiet = layout === "list" && !sameStage && !lit;
        add(from.depth, { key: `${roadmapId}/${edge.to}>${edge.from}`, d: layout === "list" && !adjacent ? mapEdgePath(from, to, true, false) : mapEdgePath(from, to, sameStage, adjacent),
          className: ["roadmap-canvas-line", sameStage ? "" : "is-across", status === "done" || status === "skipped" ? "is-finished" : "", lit ? "is-lit" : "",
            quiet ? "is-quiet" : "", Math.min(from.o, to.o) < 1 ? "is-fading" : ""].filter(Boolean).join(" ") });
      }
    }
    for (const item of frame.values()) {
      if (item.kind !== "sub") continue;
      const step = frame.get(mapStepKey(item.parentRoadmapId!, item.id));
      if (!step) continue;
      const d = layout === "list" ? `M${step.x + 14},${step.y + step.h}L${step.x + 14},${item.y + 21}L${item.x},${item.y + 21}` : mapSubPath(step, item);
      add(step.depth, { key: item.key, d, className: "roadmap-canvas-line is-sub" });
    }
    if (linking) {
      const from = frame.get(linking.from);
      if (from) add(from.depth, { key: "linking", d: `M${from.x + from.w},${from.y + from.h / 2}L${linking.x},${linking.y}`, className: "roadmap-canvas-line is-linking" });
    }
    return layers;
  }, [graphs, frame, trace, layout, linking]);

  const titleOf = (roadmapId: string, node: RoadmapNode) => {
    if (isWaiting(node)) return node.title ?? cloudTitles.get(node.target.docId) ?? "Loading…";
    const missing = graphs.get(roadmapId)?.graph.missing.has(node.id);
    return missing ? node.title ?? "Missing document" : roadmapNodeTitle(node, conversations);
  };

  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => { if (!(event.target as HTMLElement).closest(".roadmap-canvas-menu, .roadmap-canvas-stage-more")) setMenu(null); };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);

  function zIndex(item: MapItem) {
    return item.depth * 10 + ({ sub: 0, stage: 1, add: 3, step: 4 } as const)[item.kind];
  }

  function renderItem(item: MapItem & { o: number }) {
    const style = { transform: `translate(${item.x}px, ${item.y}px)`, width: item.w, height: item.h, opacity: item.o < 1 ? item.o : undefined, zIndex: zIndex(item) };
    if (item.kind === "stage") {
      const entry = graphs.get(item.roadmapId);
      const stages = entry?.graph.stages ?? [];
      const stage = stages.find((current) => (current.id || "unstaged") === item.id);
      if (!stage) return null;
      const saved = getRoadmap(conversations[item.roadmapId] ?? roadmap).stages;
      const index = saved.findIndex((current) => current.id === stage.id);
      const fraction = stage.total ? stage.finished / stage.total : 0, circumference = 2 * Math.PI * 6;
      const isDrop = dragging?.stageKey === item.key && byKey.get(dragging.key)?.roadmapId === item.roadmapId;
      return <section key={item.key} className={`roadmap-canvas-stage${isDrop ? " is-drop" : ""}`} style={{ ...style, ...(menu === item.key ? { zIndex: 940 } : {}), ["--roadmap-stage-hue" as string]: mapStageHue(stage.id || "unstaged") }}
        aria-label={stage.title} onDoubleClick={(event) => {
          if ((event.target as HTMLElement).closest("header, [data-roadmap-step]") || stage.unknown) return;
          props.onAddStep(item.roadmapId, stage.id);
        }}>
        <header>
          {renaming === item.key ? <input className="roadmap-canvas-stage-input" autoFocus defaultValue={stage.title} aria-label="Stage name"
            onBlur={(event) => { setRenaming(null); const title = event.target.value.trim(); if (title && title !== stage.title) props.onRenameStage(item.roadmapId, stage.id, title); }}
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { event.currentTarget.value = stage.title; event.currentTarget.blur(); } }} />
            : <h3 title={stage.unknown ? stage.title : `${stage.title} (double-click to rename)`}
              onDoubleClick={() => { if (!stage.unknown) setRenaming(item.key); }}>{stage.title}</h3>}
          <span className="roadmap-canvas-count">{stage.finished}/{stage.total}</span>
          <svg className="roadmap-canvas-ring" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="6" /><circle cx="8" cy="8" r="6" className="is-fill" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - fraction)} transform="rotate(-90 8 8)" />
          </svg>
          {stage.unknown ? null : <button type="button" className="roadmap-canvas-stage-more" aria-label={`More for ${stage.title}`} aria-expanded={menu === item.key}
            title="Rename, move or remove this stage" onClick={() => setMenu(menu === item.key ? null : item.key)}>⋯</button>}
        </header>
        {menu === item.key ? <div className="roadmap-canvas-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => { setMenu(null); setRenaming(item.key); }}>Rename</button>
          <button type="button" role="menuitem" disabled={index <= 0} onClick={() => { setMenu(null); props.onMoveStage(item.roadmapId, stage.id, -1); }}>Move earlier</button>
          <button type="button" role="menuitem" disabled={index < 0 || index >= saved.length - 1} onClick={() => { setMenu(null); props.onMoveStage(item.roadmapId, stage.id, 1); }}>Move later</button>
          <button type="button" role="menuitem" className="is-danger" onClick={() => { setMenu(null); props.onRemoveStage(item.roadmapId, stage.id); }}>Remove stage</button>
        </div> : null}
      </section>;
    }
    if (item.kind === "add") {
      const unknown = graphs.get(item.roadmapId)?.graph.stages.find((stage) => (stage.id || "unstaged") === item.id)?.unknown;
      if (unknown) return null;
      return <button key={item.key} type="button" className="roadmap-canvas-add" style={style} onClick={() => props.onAddStep(item.roadmapId, item.id)}>+ Add step</button>;
    }
    if (item.kind === "sub") {
      const entry = graphs.get(item.roadmapId);
      const parent = graphs.get(item.parentRoadmapId!)?.graph.nodesById.get(item.id);
      const step = { roadmapId: item.parentRoadmapId!, nodeId: item.id };
      return <section key={item.key} className="roadmap-canvas-sub" style={style} aria-label={`Roadmap of ${entry?.title ?? "step"}`}>
        <header>
          <span className="roadmap-canvas-kicker">Roadmap of</span>
          <strong title={entry?.title}>{entry?.title || (parent ? titleOf(item.parentRoadmapId!, parent) : "Step")}</strong>
          {entry ? <span className="roadmap-canvas-count">{entry.graph.finished}/{entry.graph.total}</span> : null}
          <button type="button" className="roadmap-canvas-go" title="Go into this roadmap" onClick={() => onEnter(step)}>Go in <span aria-hidden="true">↘</span></button>
          <button type="button" aria-label="Close this roadmap" title="Close" onClick={() => onToggle(step)}>×</button>
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
    const name = titleOf(item.roadmapId, node);
    const sub = roadmapOfStep(node, conversations);
    const subGraph = sub ? graphs.get(sub.id)?.graph ?? buildRoadmapGraph(getRoadmap(sub), conversations) : null;
    const isOpen = open.has(openSubKey(item.roadmapId, node.id)) && Boolean(sub);
    const isSelected = selected?.roadmapId === item.roadmapId && selected.nodeId === node.id;
    const lit = trace?.roadmapId === item.roadmapId && trace.all.has(node.id);
    const writing = Boolean(writingIds?.[node.target.docId]);
    const step = { roadmapId: item.roadmapId, nodeId: node.id };
    const finished = status === "done" || status === "skipped";
    const hidden = filter === "next" ? !next : filter === "open" ? finished : filter === "done" ? !finished : false;
    const moving = dragging?.key === item.key;
    const cardStyle = moving ? { ...style, transform: `translate(${item.x + dragging.dx}px, ${item.y + dragging.dy}px)`, zIndex: 900 } : style;
    return <div key={item.key} style={cardStyle} data-roadmap-step={item.key} data-roadmap-step-id={`${item.roadmapId}\0${node.id}`}
      className={["roadmap-canvas-step", `is-${status}`, next ? "is-next" : "", missing ? "is-missing" : "", pending ? "is-pending" : "", hidden ? "is-filtered" : "",
        isSelected ? "is-selected" : "", lit ? "is-lit" : "", lit && trace!.up.has(node.id) ? "is-before" : "", moving ? "is-dragging" : "",
        linking?.target === item.key ? "is-link-target" : ""].filter(Boolean).join(" ")}
      // Only a mouse hovers: a tap would otherwise leave the trace lit after the finger lifts.
      onPointerEnter={(event) => { if (event.pointerType === "mouse" && !gesture.current?.moved) setHovered(step); }} onPointerLeave={() => setHovered((current) => current?.nodeId === node.id ? null : current)}>
      {missing ? <span className="roadmap-canvas-mark" aria-hidden="true">?</span> : pending ? <span className="roadmap-canvas-mark" aria-hidden="true"><StatusMark status={status} /></span>
        : <button type="button" className="roadmap-canvas-mark" title={`Mark ${ROADMAP_STATUS_LABELS[NEXT_ROADMAP_STATUS[status]].toLowerCase()}`}
          aria-label={`${name}: ${ROADMAP_STATUS_LABELS[status]}. Mark ${ROADMAP_STATUS_LABELS[NEXT_ROADMAP_STATUS[status]].toLowerCase()}`}
          onClick={() => onStatus(step, NEXT_ROADMAP_STATUS[status])}><StatusMark status={status} /></button>}
      <button type="button" className="roadmap-canvas-open" aria-pressed={isSelected}
        aria-label={`${name}${missing ? ", target missing" : next ? ", next up" : ""}. Open its document`}
        onClick={() => onSelect(step)} onFocus={(event) => { if (event.currentTarget.matches(":focus-visible")) setHovered(step); }} onBlur={() => setHovered(null)}>
        <span className="roadmap-canvas-title" title={name}>{name}</span>
        {writing ? <span className="roadmap-canvas-writing" title="AI is writing in this step's document" /> : null}
        {next && !subGraph ? <span className="roadmap-canvas-tag">Next up</span> : null}
      </button>
      {subGraph ? <button type="button" className={`roadmap-canvas-chip${isOpen ? " is-open" : ""}`} aria-expanded={isOpen}
        title={isOpen ? "Close its roadmap" : layout === "list" ? "Open its roadmap under this step" : "Open its roadmap beside this step"}
        aria-label={`${isOpen ? "Close" : "Open"} the roadmap of ${name} (${subGraph.finished} of ${subGraph.total} done)`}
        onClick={() => onToggle(step)}>
        {subGraph.finished}/{subGraph.total}
        <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 2l3 3-3 3" /></svg>
      </button> : null}
      {missing || pending ? null : <span className="roadmap-canvas-handle" data-roadmap-link="" title="Drag onto a step that needs this one first" aria-hidden="true" />}
    </div>;
  }

  const nextKeys = useMemo(() => [...graphs].flatMap(([roadmapId, { graph: current }]) => [...current.nextUp].map((id) => mapStepKey(roadmapId, id))), [graphs]);
  const center = () => { const el = viewport.current!; return [(el.clientWidth - cover.right) / 2, (el.clientHeight - cover.bottom) / 2] as const; };

  return <div className={`roadmap-canvas is-${layout}${linking ? " is-linking" : ""}`} ref={viewport}
    style={{ ["--roadmap-cover-right" as string]: `${cover.right}px`, ["--roadmap-cover-bottom" as string]: `${cover.bottom}px` }}
    onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={(event) => { pointerUp(event); setDragging(null); setLinking(null); }}
    onClickCapture={swallowClickAfterDrag}>
    <div className={`roadmap-canvas-world${trace && hovered ? " is-tracing" : ""}`} ref={world}>
      {lineLayers.map((lines, depth) => lines ? <svg key={depth} className="roadmap-canvas-lines" aria-hidden="true" style={{ zIndex: depth * 10 + 2 }}>
        {lines.map((line) => <path key={line.key} d={line.d} className={line.className} />)}
      </svg> : null)}
      {[...frame.values()].map(renderItem)}
    </div>
    <div className="roadmap-canvas-controls">
      <button type="button" aria-label="Zoom out" onClick={() => zoomAt(.8, ...center())}>−</button>
      <button type="button" onClick={() => fit()}>Fit</button>
      {nextKeys.length ? <button type="button" onClick={() => fit(nextKeys, 1.1)}>Next up</button> : null}
      <button type="button" aria-label="Zoom in" onClick={() => zoomAt(1.25, ...center())}>+</button>
    </div>
  </div>;
}
