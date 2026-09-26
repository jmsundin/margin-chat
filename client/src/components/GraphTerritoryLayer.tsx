import { Fragment, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { GraphViewport } from "../lib/graphInteractions";
import { curvedGraphConnection } from "../lib/graphConnectionCurve";
import { getMapTerritoryScreenBounds, layoutMapTerritoryOverview, mapTerritoryHeadingWidth, placeMapTerritoryHeadings, readableNodeSize, territoryConnections, type MapTerritory, type MapTerritoryBounds, type MapConnections, type MapNodeFootprint } from "../lib/graphPresentation";

export default function GraphTerritoryLayer({ territories, conversations, viewport, onOpen, itemLabel = "chats and notes",
  mode = "overview", activeTerritoryId = null, selectedNodeId = null, nodeFootprint, semanticLabels }: {
  territories: MapTerritory[];
  conversations: MapConnections;
  itemLabel?: string;
  viewport: GraphViewport;
  onOpen: (territory: MapTerritory) => void;
  mode?: "overview" | "canvas";
  activeTerritoryId?: string | null;
  selectedNodeId?: string | null;
  nodeFootprint?: MapNodeFootprint;
  semanticLabels?: Record<string, string>;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const [layerWidth, setLayerWidth] = useState(0);
  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const measure = () => setLayerWidth(layer.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(layer);
    return () => observer.disconnect();
  }, []);
  // Panning translates an existing arrangement; only zoom or content changes
  // need to solve label collisions again. Using a fixed origin also avoids
  // floating-point tie changes making headings jump during a pan.
  const layoutViewport = useMemo(() => ({ x: 0, y: 0, scale: viewport.scale }), [viewport.scale]);
  const placements = useMemo<Array<MapTerritory & { bounds: MapTerritoryBounds; screenX: number; screenY: number; contentsVisible?: boolean; headerBounds?: MapTerritoryBounds }>>(() => mode === "overview" ? layoutMapTerritoryOverview(territories, layoutViewport, layerWidth || 1000) : territories.map((territory) => ({ ...territory,
    bounds: getMapTerritoryScreenBounds(territory, layoutViewport, selectedNodeId, nodeFootprint),
    screenX: territory.x * layoutViewport.scale,
    screenY: territory.y * layoutViewport.scale,
  })), [territories, layoutViewport, selectedNodeId, nodeFootprint, mode, layerWidth]);
  const headings = useMemo(() => mode === "overview" ? placements.map((placement) => placement.contentsVisible && placement.headerBounds
    ? placement.headerBounds : ({ x: placement.bounds.x + 12, y: placement.bounds.y + 10,
      width: placement.bounds.width - 24, height: placement.bounds.height - 24 })) : placeMapTerritoryHeadings(placements.map((placement) => placement.bounds), mode, {
    priorityIndex: placements.findIndex((territory) => territory.id === activeTerritoryId),
    maxWidth: layerWidth > 0 ? mapTerritoryHeadingWidth(layerWidth) : undefined,
    obstacles: mode === "canvas" ? territories.flatMap((territory) => territory.nodes.map((node) => {
      const factor = layoutViewport.scale * readableNodeSize(layoutViewport.scale, node.conversationId === selectedNodeId);
      const footprint = typeof nodeFootprint === "function" ? nodeFootprint(node) : nodeFootprint;
      const width = footprint?.width ?? node.width * factor;
      const height = footprint?.height ?? node.height * factor;
      return { x: (node.x + node.width / 2) * layoutViewport.scale - width / 2,
        y: (node.y + node.height / 2) * layoutViewport.scale - height / 2, width, height };
    })) : undefined,
  }), [placements, mode, activeTerritoryId, territories, layoutViewport, selectedNodeId, nodeFootprint, layerWidth]);
  const connections = useMemo(() => territoryConnections(territories, conversations), [territories, conversations]);
  const byId = new Map(placements.map((placement) => [placement.id, placement]));
  return <div ref={layerRef} className={`graph-territories graph-territories--${mode}`} data-mode={mode} data-territory-mode={mode}
    aria-label={mode === "overview" ? "Groups overview" : "Map groups"}>
    <svg className="graph-territory-links" aria-label="Connections between groups" style={{ transform: `translate(${viewport.x}px, ${viewport.y}px)` }}>
      {mode === "overview" && connections.map((connection) => {
        const from = byId.get(connection.from)!;
        const to = byId.get(connection.to)!;
        return <g key={`${from.id}:${to.id}`}>
          <path d={curvedGraphConnection({ startX: from.screenX, startY: from.screenY, endX: to.screenX, endY: to.screenY }).path} />
          <title>{`${from.label} and ${to.label}: ${connection.count} connections`}</title>
        </g>;
      })}
      {mode === "canvas" && placements.map((territory, index) => {
        const heading = headings[index];
        const anchor = { x: territory.bounds.x + 24, y: territory.bounds.y + 31 };
        if (heading.x === territory.bounds.x + 12 && heading.y === territory.bounds.y + 10) return null;
        return <path key={`heading:${territory.id}`} className="graph-territory-leader" aria-hidden="true"
          d={curvedGraphConnection({ startX: anchor.x, startY: anchor.y, endX: heading.x + 12, endY: heading.y + heading.height / 2 }).path} />;
      })}
    </svg>
    {placements.map((territory, index) => ({ territory, index }))
      .sort((a, b) => b.territory.bounds.width * b.territory.bounds.height - a.territory.bounds.width * a.territory.bounds.height)
      .map(({ territory, index }) => {
      const { bounds } = territory;
      const active = territory.id === activeTerritoryId;
      const hasContents = "contentsVisible" in territory && territory.contentsVisible;
      const countLabel = `${territory.nodes.length} ${itemLabel === "chats and notes" && territory.nodes.length === 1 ? "chat or note" : itemLabel}`;
      const heading = headings[index];
      return <Fragment key={territory.id}>{(mode === "overview" || active) && <div className={`graph-territory-region${active ? " is-active" : ""}`}
        data-territory-id={territory.id}
        style={{ left: viewport.x + bounds.x, top: viewport.y + bounds.y, width: bounds.width, height: bounds.height,
          "--territory-color": territory.color } as CSSProperties} />}
        <button type="button" data-graph-ui="true" data-territory-id={territory.id} className={`graph-territory${hasContents ? " has-contents" : ""}${hasContents && viewport.scale < 0.5 ? " is-distant" : ""}`}
          style={{ left: viewport.x + heading.x, top: viewport.y + heading.y, width: heading.width, height: heading.height,
            "--territory-color": territory.color,
            "--territory-title-size": `${Math.max(10, Math.min(13, viewport.scale * 20))}px`,
            "--territory-count-size": `${Math.max(10, Math.min(11, viewport.scale * 16))}px` } as CSSProperties}
          aria-label={`Explore ${territory.label}, ${territory.nodes.length} ${itemLabel}`} aria-pressed={active}
          title={`Zoom into ${territory.label}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); onOpen(territory); }}>
          <span className="graph-territory-label"><strong>{territory.label}</strong><span>{countLabel}</span>
            {mode === "overview" && !hasContents && semanticLabels?.[territory.id] ? <small className="graph-territory-topic" title="Topic categorized by Jev">{semanticLabels[territory.id]}</small> : null}
          </span>
          <svg className="graph-territory-enter" viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m12.5 12.5 4.5 4.5M6 8.5h5M8.5 6v5" /></svg>
        </button>
      </Fragment>;
    })}
  </div>;
}
