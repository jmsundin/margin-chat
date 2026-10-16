import type { CSSProperties } from "react";
import "./MapNavigation.css";
import { MAP_COLOR_BY_OPTIONS, type MapColorBy, type MapColoring, type MapLegendItem } from "../lib/mapColorBy";
import type { PlacedLandmark, Signpost } from "../lib/mapNavigation";

const shorten = (text: string, length: number) => text.length > length ? `${text.slice(0, length - 1)}…` : text;

/** What the map's colors mean, with a picker; clicking a color filters the map to it. */
export function MapColorLegend({ coloring, colorBy, onColorBy, onFilter }: {
  coloring: MapColoring;
  colorBy: MapColorBy;
  onColorBy: (value: MapColorBy) => void;
  onFilter: (item: MapLegendItem) => void;
}) {
  return <section className="map-color-legend" aria-label="Map colors" data-graph-ui="true">
    <label className="map-color-legend-picker">Color by
      <select value={colorBy} onChange={(event) => onColorBy(event.target.value as MapColorBy)}>
        {MAP_COLOR_BY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
    <ul>
      {coloring.legend.map((item) => <li key={item.label}>
        <button type="button" disabled={!item.filter} onClick={() => onFilter(item)}
          title={item.filter ? `Show only: ${item.label}` : undefined}>
          <span className="map-color-swatch" style={{ "--swatch": item.color || "var(--muted)" } as CSSProperties} data-neutral={!item.color || undefined} />
          <span>{item.label}</span><small>{item.count.toLocaleString()}</small>
        </button>
      </li>)}
    </ul>
  </section>;
}

/**
 * Arrows on the edge of the screen toward the selected document's links that
 * are off screen. One leads to its document; a merged one fits them all.
 */
export function MapSignposts({ signposts, title, selectedId, onOpen }: {
  signposts: Signpost[];
  title: (id: string) => string;
  selectedId: string | null;
  onOpen: (signpost: Signpost) => void;
}) {
  return <div className="map-signposts" data-graph-ui="true">
    {signposts.map((signpost) => {
      const single = signpost.ids.length === 1;
      const self = single && signpost.ids[0] === selectedId;
      const text = self ? `Back to ${shorten(title(signpost.ids[0]), 22)}` : single ? shorten(title(signpost.ids[0]), 24) : `${signpost.ids.length} linked`;
      const label = self ? `Go back to ${title(signpost.ids[0])}, off screen`
        : single ? `Go to linked document ${title(signpost.ids[0])}, off screen`
        : `Show ${signpost.ids.length} linked documents off screen: ${signpost.ids.slice(0, 5).map(title).join(", ")}${signpost.ids.length > 5 ? "…" : ""}`;
      return <button type="button" key={signpost.ids.join("|")} className={`map-signpost${self ? " is-self" : ""}`}
        style={{ left: signpost.x, top: signpost.y, "--signpost-angle": `${signpost.angle}rad` } as CSSProperties}
        data-side={Math.abs(Math.cos(signpost.angle)) > Math.abs(Math.sin(signpost.angle)) ? Math.cos(signpost.angle) > 0 ? "right" : "left" : Math.sin(signpost.angle) > 0 ? "bottom" : "top"}
        aria-label={label} title={label} onPointerDown={(event) => event.stopPropagation()} onClick={() => onOpen(signpost)}>
        <span className="map-signpost-arrow" aria-hidden="true">➜</span><span>{text}</span>
      </button>;
    })}
  </div>;
}

/** Names over a zoomed-out map: families as regions, well-linked documents as places. */
export function MapLandmarks({ landmarks, onOpen }: { landmarks: PlacedLandmark[]; onOpen: (landmark: PlacedLandmark) => void }) {
  return <div className="map-landmarks" data-graph-ui="true">
    {landmarks.map((landmark) => <button type="button" key={landmark.id} className={`map-landmark${landmark.region ? " is-region" : ""}`}
      style={{ left: landmark.rect.x, top: landmark.rect.y, width: landmark.rect.width }}
      title={`Zoom to ${landmark.label}`} onPointerDown={(event) => event.stopPropagation()} onClick={() => onOpen(landmark)}>
      <strong>{landmark.label}</strong>{landmark.detail ? <span>{landmark.detail}</span> : null}
    </button>)}
  </div>;
}
