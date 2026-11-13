import { MAP_ZOOM_LEVEL_LABELS, type MapZoomLevel } from "../lib/mapZoomLevels";
import "./MapZoomLevels.css";

const LEVEL_HINTS: Record<MapZoomLevel, string> = {
  themes: "Broad themes, each holding several topics",
  topics: "One tile per topic",
  blocks: "Circles, with each block of alike documents named",
  notes: "Every document with its title",
  previews: "Each document's opening lines",
};

/**
 * The Map's zoom ladder: one rung per level of detail, broadest at the top. The lit rung is the
 * level on screen; pressing another flies there, staying on whatever is in the middle of the map.
 */
export function MapZoomLadder({ levels, level, onPick }: {
  /** The levels this map has, broadest first. */
  levels: MapZoomLevel[];
  level: MapZoomLevel;
  onPick: (level: MapZoomLevel) => void;
}) {
  if (levels.length < 2) return null;
  return <div className="map-zoom-ladder" data-graph-ui="true" role="toolbar" aria-label="Zoom levels" aria-orientation="vertical"
    onPointerDown={(event) => event.stopPropagation()}>
    {levels.map((item) => <button key={item} type="button" className={item === level ? "is-current" : undefined} aria-pressed={item === level}
      title={LEVEL_HINTS[item]} onClick={() => onPick(item)}>
      <i aria-hidden="true" /><span>{MAP_ZOOM_LEVEL_LABELS[item]}</span>
    </button>)}
  </div>;
}

export interface MapZoomCrumb { id: string; label: string; onOpen: () => void }

/**
 * Where the middle of the map is: the theme, topic and block around it, outermost first, with one
 * sentence on the innermost. Each step zooms back out to it.
 */
export function MapZoomTrail({ crumbs, summary }: { crumbs: MapZoomCrumb[]; summary?: string }) {
  if (crumbs.length < 2) return null;
  return <nav className="map-zoom-trail" data-graph-ui="true" aria-label="Where you are on the map" onPointerDown={(event) => event.stopPropagation()}>
    <ol>
      {crumbs.map((crumb, index) => <li key={crumb.id}>
        <button type="button" aria-current={index === crumbs.length - 1 ? "location" : undefined} title={`Zoom to ${crumb.label}`} onClick={crumb.onOpen}>{crumb.label}</button>
      </li>)}
    </ol>
    {summary ? <p>{summary}</p> : null}
  </nav>;
}
