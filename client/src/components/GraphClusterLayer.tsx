import { useMemo, type CSSProperties } from "react";
import type { ConversationGraphNodePlacement } from "../lib/conversationGraph";
import type { GraphViewport } from "../lib/graphInteractions";
import { UNLINKED_CLUSTER_ID, type GravityCluster } from "../lib/gravityClusters";

/** Below this zoom the Clusters view shows topic labels and dots instead of document cards. */
export const CLUSTER_DOT_SCALE = 0.45;
const MAX_RENDERED_DOTS = 20_000;
const MAX_RENDERED_LINKS = 6_000;
const LABEL_HEIGHT = 46;

type Connection = { sourceId: string; targetId: string };
type Rect = { x: number; y: number; width: number; height: number };

/** Golden-angle hues by size rank keep neighboring clusters visibly distinct. */
function clusterHues(clusters: GravityCluster[]) {
  return new Map(clusters.map((cluster, rank) => [cluster.id, cluster.id === UNLINKED_CLUSTER_ID ? null : Math.round((210 + rank * 137.508) % 360)]));
}

function overlaps(a: Rect, b: Rect) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

export default function GraphClusterLayer({ clusters, placements, connections, labels, viewport, size, showDots,
  selectedId, titles, onOpenCluster, onSelectDocument }: {
  clusters: GravityCluster[];
  placements: Map<string, ConversationGraphNodePlacement>;
  connections: Connection[];
  labels: Record<string, { label: string; generated: boolean }>;
  viewport: GraphViewport;
  size: { width: number; height: number };
  showDots: boolean;
  selectedId: string | null;
  titles: (id: string) => string;
  onOpenCluster: (cluster: GravityCluster) => void;
  onSelectDocument: (id: string) => void;
}) {
  const { x: panX, y: panY, scale } = viewport;
  const width = size.width || 1000, height = size.height || 700;
  // Visible world rectangle, with a margin so dots don't pop in at the edges.
  const margin = 80 / scale;
  const view = { left: -panX / scale - margin, top: -panY / scale - margin,
    right: (width - panX) / scale + margin, bottom: (height - panY) / scale + margin };
  const hues = useMemo(() => clusterHues(clusters), [clusters]);
  const hue = (id: string) => hues.get(id) ?? null;
  const visibleClusters = clusters.filter((cluster) => cluster.center.x + cluster.radius >= view.left && cluster.center.x - cluster.radius <= view.right
    && cluster.center.y + cluster.radius >= view.top && cluster.center.y - cluster.radius <= view.bottom);

  const dots = useMemo(() => {
    if (!showDots) return [];
    const result: Array<{ id: string; cx: number; cy: number; hub: boolean; hue: number | null }> = [];
    for (const cluster of visibleClusters) {
      const clusterHue = hue(cluster.id);
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
  }, [showDots, clusters, placements, panX, panY, scale, width, height]);

  const links = useMemo(() => {
    if (!showDots || !dots.length) return [];
    const shown = new Set(dots.map((dot) => dot.id));
    const result: Array<{ key: string; x1: number; y1: number; x2: number; y2: number }> = [];
    for (const { sourceId, targetId } of connections) {
      if (!shown.has(sourceId) || !shown.has(targetId)) continue;
      const a = placements.get(sourceId)!, b = placements.get(targetId)!;
      result.push({ key: `${sourceId}>${targetId}`, x1: a.x + a.width / 2, y1: a.y + a.height / 2, x2: b.x + b.width / 2, y2: b.y + b.height / 2 });
      if (result.length >= MAX_RENDERED_LINKS) break;
    }
    return result;
  }, [showDots, dots, connections, placements]);

  // Larger clusters claim label space first; a smaller label that would collide
  // stays hidden until zooming in gives it room.
  const placedLabels = useMemo(() => {
    const taken: Rect[] = [];
    const result: Array<{ cluster: GravityCluster; rect: Rect; fontSize: number }> = [];
    const ordered = [...visibleClusters].sort((a, b) => (a.id === UNLINKED_CLUSTER_ID ? 1 : 0) - (b.id === UNLINKED_CLUSTER_ID ? 1 : 0)
      || b.memberIds.length - a.memberIds.length);
    for (const cluster of ordered) {
      const text = labels[cluster.id]?.label ?? "";
      const fontSize = showDots ? Math.min(22, 12 + Math.log2(cluster.memberIds.length) * 2) : 14;
      const labelWidth = Math.min(showDots ? 260 : 320, Math.max(90, text.length * fontSize * 0.56 + 28));
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
  }, [clusters, labels, panX, panY, scale, width, height, showDots]);

  const dotRadius = 4.5 / scale;
  return <div className={`graph-clusters${showDots ? " is-dots" : ""}`} data-cluster-display={showDots ? "dots" : "cards"}
    aria-label="Document clusters">
    {showDots ? <svg className="graph-cluster-dots" width={width} height={height} aria-hidden="true">
      <g transform={`translate(${panX} ${panY}) scale(${scale})`}>
        {visibleClusters.map((cluster) => {
          const clusterHue = hue(cluster.id);
          return <circle key={cluster.id} className="graph-cluster-halo" cx={cluster.center.x} cy={cluster.center.y} r={cluster.radius}
            style={{ "--cluster-hue": clusterHue ?? 0 } as CSSProperties} data-unlinked={clusterHue === null || undefined} />;
        })}
        {links.map((link) => <line key={link.key} className="graph-cluster-link" x1={link.x1} y1={link.y1} x2={link.x2} y2={link.y2} />)}
        {dots.map((dot) => <circle key={dot.id} data-graph-ui="true" data-conversation-id={dot.id}
          className={`graph-cluster-dot${dot.hub ? " is-hub" : ""}${dot.id === selectedId ? " is-selected" : ""}`}
          data-unlinked={dot.hue === null || undefined}
          style={{ "--cluster-hue": dot.hue ?? 0 } as CSSProperties}
          cx={dot.cx} cy={dot.cy} r={dot.hub ? dotRadius * 1.7 : dotRadius}
          onClick={(event) => { event.stopPropagation(); onSelectDocument(dot.id); }}>
          <title>{titles(dot.id)}</title>
        </circle>)}
      </g>
    </svg> : null}
    {placedLabels.map(({ cluster, rect, fontSize }) => {
      const label = labels[cluster.id];
      const clusterHue = hue(cluster.id);
      const count = `${cluster.memberIds.length} document${cluster.memberIds.length === 1 ? "" : "s"}`;
      return <button key={cluster.id} type="button" data-graph-ui="true" data-cluster-id={cluster.id}
        className={`graph-cluster-label${label?.generated ? " is-generated" : ""}`}
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
