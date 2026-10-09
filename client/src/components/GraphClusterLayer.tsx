import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { ConversationGraphNodePlacement } from "../lib/conversationGraph";
import type { GraphViewport } from "../lib/graphInteractions";
import { formatClusterPeriod, type GravityCluster, type GravityClusterGroup, type GravityClusterLevel } from "../lib/gravityClusters";

/** Below this zoom the Clusters view shows topic labels and dots instead of document cards. */
export const CLUSTER_DOT_SCALE = 0.45;
/** A level is shown once its typical member is at least this big on screen, in pixels. */
const MIN_SCREEN_RADIUS = 12;
const MAX_RENDERED_DOTS = 50_000;
const MAX_RENDERED_LINKS = 6_000;
const LABEL_HEIGHT = 46;
const HIT_RADIUS = 9;

type Connection = { sourceId: string; targetId: string };
type Rect = { x: number; y: number; width: number; height: number };
type Labels = Record<string, { label: string; generated: boolean }>;
type Circle = GravityCluster | GravityClusterGroup;

const isUnlinked = (cluster: Circle) => cluster.hubId === null && !("level" in cluster);

/** Golden-angle hues by size rank keep neighboring clusters visibly distinct. */
function hueMap(circles: Circle[]) {
  const ranked = [...circles].sort((a, b) => b.memberIds.length - a.memberIds.length || (a.id < b.id ? -1 : 1));
  return new Map(ranked.map((circle, rank) => [circle.id, isUnlinked(circle) ? null : Math.round((210 + rank * 137.508) % 360)]));
}

function overlaps(a: Rect, b: Rect) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function medianRadius(circles: Circle[]) {
  if (!circles.length) return 0;
  const radii = circles.map((circle) => circle.radius).sort((a, b) => a - b);
  return radii[Math.floor(radii.length / 2)];
}

/**
 * Which level to draw: 0 is clusters with their documents as dots, 1 and up
 * are groups of clusters. The lowest level whose typical member is readable
 * on screen wins, so zooming out trades many small things for fewer big ones.
 */
export function clusterDisplayLevel(clusters: GravityCluster[], levels: GravityClusterLevel[], scale: number) {
  if (medianRadius(clusters) * scale >= MIN_SCREEN_RADIUS) return 0;
  for (const level of levels) if (medianRadius(level.groups) * scale >= MIN_SCREEN_RADIUS) return level.level;
  return levels.at(-1)?.level ?? 0;
}

/**
 * Fills labels for groups of clusters: unlinked date runs are named by their
 * dates, and groups without a generated name borrow their biggest member's.
 */
export function labelClusterGroups(labels: Labels, clusters: GravityCluster[], levels: GravityClusterLevel[], unlinkedLabel = "Unlinked") {
  const result: Labels = { ...labels };
  for (const cluster of clusters) {
    if (cluster.hubId === null && cluster.period) result[cluster.id] = { label: `${unlinkedLabel} · ${formatClusterPeriod(cluster.period)}`, generated: false };
  }
  const sizes = new Map<string, number>(clusters.map((cluster) => [cluster.id, cluster.memberIds.length]));
  for (const level of levels) for (const group of level.groups) {
    sizes.set(group.id, group.memberIds.length);
    if (result[group.id]?.generated) continue;
    const biggest = [...group.childIds].sort((a, b) => (sizes.get(b) ?? 0) - (sizes.get(a) ?? 0))
      .find((id) => result[id] && !id.includes("__unlinked__")) ?? group.childIds[0];
    const borrowed = result[biggest]?.label;
    result[group.id] = { label: borrowed ?? (group.period ? formatClusterPeriod(group.period) : "Topics"), generated: false };
  }
  return result;
}

function cssVar(element: Element, name: string, fallback: string) {
  return getComputedStyle(element).getPropertyValue(name).trim() || fallback;
}

export default function GraphClusterLayer({ clusters, levels = [], placements, connections, labels, viewport, size, showDots,
  selectedId, titles, onOpenCluster, onSelectDocument, itemLabel = ["document", "documents"] }: {
  clusters: GravityCluster[];
  /** Groups of clusters, smallest first. */
  levels?: GravityClusterLevel[];
  placements: Map<string, ConversationGraphNodePlacement>;
  connections: Connection[];
  labels: Labels;
  viewport: GraphViewport;
  size: { width: number; height: number };
  showDots: boolean;
  selectedId: string | null;
  titles: (id: string) => string;
  onOpenCluster: (cluster: GravityCluster) => void;
  onSelectDocument: (id: string) => void;
  /** Singular and plural names for the clustered items. */
  itemLabel?: [string, string];
}) {
  const { x: panX, y: panY, scale } = viewport;
  const width = size.width || 1000, height = size.height || 700;
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hovered, setHovered] = useState<{ id: string; x: number; y: number } | null>(null);
  // Visible world rectangle, with a margin so dots don't pop in at the edges.
  const margin = 80 / scale;
  const view = { left: -panX / scale - margin, top: -panY / scale - margin,
    right: (width - panX) / scale + margin, bottom: (height - panY) / scale + margin };
  const inView = (circle: Circle) => circle.center.x + circle.radius >= view.left && circle.center.x - circle.radius <= view.right
    && circle.center.y + circle.radius >= view.top && circle.center.y - circle.radius <= view.bottom;
  const level = showDots ? clusterDisplayLevel(clusters, levels, scale) : 0;
  const shownCircles: Circle[] = level === 0 ? clusters : levels[level - 1].groups;
  const innerCircles: Circle[] = level <= 1 ? (level === 1 ? clusters : []) : levels[level - 2].groups;
  const hues = useMemo(() => hueMap(shownCircles), [shownCircles]);
  const parentHue = useMemo(() => {
    if (!level) return new Map<string, number | null>();
    const result = new Map<string, number | null>();
    for (const group of levels[level - 1].groups) for (const child of group.childIds) result.set(child, hues.get(group.id) ?? null);
    return result;
  }, [level, levels, hues]);
  const hue = (id: string) => hues.get(id) ?? null;
  const visible = shownCircles.filter(inView);

  const dots = useMemo(() => {
    if (!showDots || level !== 0) return [];
    const result: Array<{ id: string; cx: number; cy: number; hub: boolean; hue: number | null }> = [];
    for (const cluster of clusters) {
      if (!inView(cluster)) continue;
      const clusterHue = hues.get(cluster.id) ?? null;
      for (const id of cluster.memberIds) {
        const placement = placements.get(id);
        if (!placement) continue;
        const cx = placement.x + placement.width / 2, cy = placement.y + placement.height / 2;
        if (cx < view.left || cx > view.right || cy < view.top || cy > view.bottom) continue;
        result.push({ id, cx, cy, hub: id === cluster.hubId, hue: clusterHue });
        if (result.length >= MAX_RENDERED_DOTS) return result;
      }
    }
    return result;
  // The visible rectangle is derived from the viewport and size below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDots, level, clusters, placements, hues, panX, panY, scale, width, height]);

  const links = useMemo(() => {
    if (!showDots) return [];
    const result: Array<{ x1: number; y1: number; x2: number; y2: number; weight: number }> = [];
    if (level === 0) {
      const shown = new Set(dots.map((dot) => dot.id));
      for (const { sourceId, targetId } of connections) {
        if (!shown.has(sourceId) || !shown.has(targetId)) continue;
        const a = placements.get(sourceId)!, b = placements.get(targetId)!;
        result.push({ x1: a.x + a.width / 2, y1: a.y + a.height / 2, x2: b.x + b.width / 2, y2: b.y + b.height / 2, weight: 1 });
        if (result.length >= MAX_RENDERED_LINKS) break;
      }
      return result;
    }
    // Groups: one line per pair of linked groups, thicker for more links.
    const byId = new Map(levels[level - 1].groups.map((group) => [group.id, group]));
    for (const link of levels[level - 1].links) {
      const a = byId.get(link.a), b = byId.get(link.b);
      if (!a || !b || (!inView(a) && !inView(b))) continue;
      result.push({ x1: a.center.x, y1: a.center.y, x2: b.center.x, y2: b.center.y, weight: link.weight });
      if (result.length >= MAX_RENDERED_LINKS) break;
    }
    return result;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDots, level, levels, dots, connections, placements, panX, panY, scale, width, height]);

  // Everything but labels is drawn on one canvas: thousands of SVG circles
  // made each frame of zooming slow.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !showDots) return;
    const ratio = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    }
    const context = canvas.getContext("2d");
    if (!context) return;
    const muted = cssVar(canvas, "--muted", "#8a8a8a");
    const ink = cssVar(canvas, "--ink", "#f2f2f2");
    const panel = cssVar(canvas, "--panel-strong", "#ffffff");
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.translate(panX, panY);
    context.scale(scale, scale);
    const pixel = 1 / scale;
    // Members of the shown groups, faint, so you can see what a group holds.
    for (const circle of innerCircles) {
      if (!inView(circle)) continue;
      const tint = parentHue.get(circle.id);
      context.beginPath();
      context.arc(circle.center.x, circle.center.y, circle.radius, 0, Math.PI * 2);
      context.fillStyle = tint == null ? muted : `hsl(${tint} 55% 55%)`;
      context.globalAlpha = 0.12;
      context.fill();
    }
    for (const circle of visible) {
      const circleHue = hue(circle.id);
      context.beginPath();
      context.arc(circle.center.x, circle.center.y, circle.radius, 0, Math.PI * 2);
      context.globalAlpha = 1;
      context.fillStyle = circleHue === null ? muted : `hsl(${circleHue} 55% 55%)`;
      context.globalAlpha = circleHue === null ? 0.07 : level ? 0.06 : 0.09;
      context.fill();
      context.globalAlpha = circleHue === null ? 0.3 : 0.28;
      context.strokeStyle = circleHue === null ? muted : `hsl(${circleHue} 50% 50%)`;
      context.lineWidth = pixel * (level ? 1.5 : 1);
      context.setLineDash(circleHue === null ? [4 * pixel, 5 * pixel] : []);
      context.stroke();
    }
    context.setLineDash([]);
    context.strokeStyle = muted;
    for (const link of links) {
      context.globalAlpha = level ? 0.32 : 0.22;
      context.lineWidth = pixel * (level ? Math.min(10, 1 + Math.log2(link.weight) * 1.5) : 1);
      context.beginPath();
      context.moveTo(link.x1, link.y1);
      context.lineTo(link.x2, link.y2);
      context.stroke();
    }
    context.globalAlpha = 1;
    // Dots sharing a color are drawn as one path: one fill per color rather
    // than one per dot. Hubs go on top, and the selected dot last.
    const radius = 4.5 * pixel;
    const batches = new Map<string, { hue: number | null; hub: boolean; dots: typeof dots }>();
    let selectedDot: (typeof dots)[number] | undefined;
    for (const dot of dots) {
      if (dot.id === selectedId) { selectedDot = dot; continue; }
      const key = `${dot.hub ? 1 : 0}:${dot.hue}`;
      const batch = batches.get(key);
      if (batch) batch.dots.push(dot); else batches.set(key, { hue: dot.hue, hub: dot.hub, dots: [dot] });
    }
    const drawDots = (batch: { hue: number | null; hub: boolean; dots: typeof dots }, selected = false) => {
      const size = batch.hub ? radius * 1.7 : radius;
      context.beginPath();
      for (const dot of batch.dots) { context.moveTo(dot.cx + size, dot.cy); context.arc(dot.cx, dot.cy, size, 0, Math.PI * 2); }
      context.fillStyle = batch.hue === null ? muted : `hsl(${batch.hue} 58% 48%)`;
      context.globalAlpha = batch.hue === null ? 0.55 : 1;
      context.fill();
      context.globalAlpha = 1;
      context.strokeStyle = selected ? ink : panel;
      context.lineWidth = pixel * (selected ? 3 : batch.hub ? 2 : 1);
      context.stroke();
    };
    for (const batch of [...batches.values()].sort((a, b) => Number(a.hub) - Number(b.hub))) drawDots(batch);
    if (selectedDot) drawDots({ hue: selectedDot.hue, hub: selectedDot.hub, dots: [selectedDot] }, true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDots, dots, links, visible.length, level, panX, panY, scale, width, height, selectedId, hues]);

  // The canvas lets pointer events through so the map still pans; clicks and
  // hovers are matched to the nearest dot here instead.
  useEffect(() => {
    const host = rootRef.current?.parentElement;
    if (!host || !showDots || !dots.length) { setHovered(null); return; }
    const nearest = (event: MouseEvent) => {
      const bounds = rootRef.current!.getBoundingClientRect();
      const x = event.clientX - bounds.left, y = event.clientY - bounds.top;
      let best: { id: string; x: number; y: number } | null = null, bestDistance = HIT_RADIUS * HIT_RADIUS;
      for (const dot of dots) {
        const dx = panX + dot.cx * scale - x, dy = panY + dot.cy * scale - y;
        const distance = dx * dx + dy * dy;
        if (distance <= bestDistance) { best = { id: dot.id, x: panX + dot.cx * scale, y: panY + dot.cy * scale }; bestDistance = distance; }
      }
      return best;
    };
    let frame = 0;
    const move = (event: PointerEvent) => {
      if (frame || event.buttons) return;
      frame = window.setTimeout(() => { frame = 0; setHovered(nearest(event)); }, 16);
    };
    const click = (event: MouseEvent) => {
      const hit = nearest(event);
      if (!hit) return;
      event.stopPropagation();
      onSelectDocument(hit.id);
    };
    const leave = () => setHovered(null);
    host.addEventListener("pointermove", move);
    host.addEventListener("pointerleave", leave);
    host.addEventListener("click", click);
    return () => {
      window.clearTimeout(frame);
      host.removeEventListener("pointermove", move);
      host.removeEventListener("pointerleave", leave);
      host.removeEventListener("click", click);
    };
  }, [showDots, dots, panX, panY, scale, onSelectDocument]);

  // Larger clusters claim label space first; a smaller label that would collide
  // stays hidden until zooming in gives it room.
  const placedLabels = useMemo(() => {
    const taken: Rect[] = [];
    const result: Array<{ cluster: Circle; rect: Rect; fontSize: number }> = [];
    const ordered = [...visible].sort((a, b) => (isUnlinked(a) ? 1 : 0) - (isUnlinked(b) ? 1 : 0)
      || b.memberIds.length - a.memberIds.length);
    for (const cluster of ordered) {
      const text = labels[cluster.id]?.label ?? "";
      const fontSize = showDots && isUnlinked(cluster) ? 14 : showDots ? Math.min(level ? 20 : 22, 12 + Math.log2(cluster.memberIds.length) * (level ? 0.9 : 2)) : 14;
      const countLength = ("level" in cluster ? 14 : 0) + String(cluster.memberIds.length).length + itemLabel[1].length + 2;
      const labelWidth = Math.min(showDots ? 300 : 320, Math.max(90, text.length * fontSize * 0.56 + 28, countLength * 6.4 + 24));
      const centerX = panX + cluster.center.x * scale;
      const anchorY = showDots ? panY + cluster.center.y * scale - LABEL_HEIGHT / 2
        : panY + (cluster.center.y - cluster.radius) * scale - LABEL_HEIGHT - 6;
      const rect = { x: centerX - labelWidth / 2, y: anchorY, width: labelWidth, height: LABEL_HEIGHT };
      if (rect.x > width || rect.y > height || rect.x + rect.width < 0 || rect.y + rect.height < 0) continue;
      if (taken.some((other) => overlaps(rect, other))) continue;
      taken.push(rect);
      result.push({ cluster, rect, fontSize });
    }
    return result;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownCircles, labels, panX, panY, scale, width, height, showDots, level]);

  const plural = (count: number, names: [string, string]) => `${count.toLocaleString("en-US")} ${names[count === 1 ? 0 : 1]}`;
  return <div ref={rootRef} className={`graph-clusters${showDots ? " is-dots" : ""}`} data-cluster-display={showDots ? "dots" : "cards"}
    data-cluster-level={showDots ? level : undefined} data-rendered-dot-count={dots.length}
    aria-label={`${itemLabel[0][0].toUpperCase()}${itemLabel[0].slice(1)} clusters`}>
    {showDots ? <canvas ref={canvasRef} className="graph-cluster-canvas" style={{ width, height }} aria-hidden="true" /> : null}
    {hovered ? <span className="graph-cluster-dot-tip" style={{ left: hovered.x, top: hovered.y }}>{titles(hovered.id)}</span> : null}
    {placedLabels.map(({ cluster, rect, fontSize }) => {
      const label = labels[cluster.id];
      const clusterHue = hue(cluster.id);
      const groups = "level" in cluster ? `${plural(cluster.childIds.length, cluster.level === 1 ? ["topic", "topics"] : ["area", "areas"])} · ` : "";
      const count = `${groups}${plural(cluster.memberIds.length, itemLabel)}`;
      return <button key={`${level}:${cluster.id}`} type="button" data-graph-ui="true" data-cluster-id={cluster.id}
        className={`graph-cluster-label${label?.generated ? " is-generated" : ""}${level ? " is-group" : ""}`}
        data-unlinked={clusterHue === null || undefined}
        style={{ left: rect.x, top: rect.y, width: rect.width, "--cluster-hue": clusterHue ?? 0, "--cluster-label-size": `${fontSize}px` } as CSSProperties}
        title={label?.generated ? `Topic named by Luna. Zoom into ${label.label}` : `Zoom into ${label?.label ?? "this cluster"}`}
        aria-label={`Zoom into ${label?.label ?? "cluster"}, ${count}`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => { event.stopPropagation(); onOpenCluster(cluster); }}>
        <strong>{label?.label}</strong>
        <span>{count}</span>
      </button>;
    })}
  </div>;
}

/** Documents beyond the card budget, drawn as dots behind the cards. */
export function GraphOverflowDots({ placements, viewport, size }: {
  placements: ConversationGraphNodePlacement[];
  viewport: GraphViewport;
  size: { width: number; height: number };
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const width = size.width || 1000, height = size.height || 700;
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle = cssVar(canvas, "--muted", "#8a8a8a");
    context.globalAlpha = 0.6;
    context.beginPath();
    for (const placement of placements) {
      const x = viewport.x + (placement.x + placement.width / 2) * viewport.scale, y = viewport.y + (placement.y + placement.height / 2) * viewport.scale;
      if (x < -3 || y < -3 || x > width + 3 || y > height + 3) continue;
      context.moveTo(x + 3, y);
      context.arc(x, y, 3, 0, Math.PI * 2);
    }
    context.fill();
  }, [placements, viewport, width, height]);
  return <canvas ref={canvasRef} className="graph-cluster-canvas graph-overflow-dots" style={{ width, height }} aria-hidden="true"
    data-overflow-count={placements.length} />;
}
