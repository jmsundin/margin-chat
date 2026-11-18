import type { ReactElement } from "react";
import DismissibleDetails from "./DismissibleDetails";
import { EXPLORE_LAYOUTS, EXPLORE_LAYOUT_LABELS, type ExploreLayout } from "../lib/exploreLibrary";

const ICONS: Record<ExploreLayout, ReactElement> = {
  tiles: <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="3" width="10" height="18" rx="1.5" /><rect x="15" y="3" width="6" height="8" rx="1.5" /><rect x="15" y="13" width="6" height="8" rx="1.5" /></svg>,
  clusters: <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="8" cy="9" r="5" /><circle cx="17.5" cy="7.5" r="3.5" /><circle cx="15" cy="17.5" r="4" /></svg>,
  canvas: <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="4" width="7" height="5" rx="1" /><rect x="14" y="9" width="7" height="5" rx="1" /><rect x="5" y="15" width="7" height="5" rx="1" /><path d="M10 7h2.5a1.5 1.5 0 0 1 1.5 1.5V9M8.5 15v-1.5a1.5 1.5 0 0 1 1.5-1.5h4" /></svg>,
};

/** Explore's Layout menu: the same notes drawn as Tiles, Clusters or the free Canvas. */
export default function ExploreLayoutMenu({ value, onChange, publicSource = false }: {
  value: ExploreLayout; onChange: (layout: ExploreLayout) => void;
  /** On Wikipedia or an AI topic, Canvas grows a graph from the topic you are on. */
  publicSource?: boolean;
}) {
  return <DismissibleDetails className="explore-layout-menu" onKeyDown={(event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus();
  }}>
    <summary aria-label={`Layout: ${EXPLORE_LAYOUT_LABELS[value].name}`} title="Layout: how Explore draws your notes">
      {ICONS[value]}<span className="explore-layout-name">{EXPLORE_LAYOUT_LABELS[value].name}</span><span aria-hidden="true">▾</span>
    </summary>
    <div role="menu" aria-label="Layout">
      {EXPLORE_LAYOUTS.map((layout) => <button type="button" role="menuitemradio" key={layout} aria-checked={layout === value}
        onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onChange(layout); }}>
        {ICONS[layout]}<span>{EXPLORE_LAYOUT_LABELS[layout].name}<small>{publicSource && layout === "canvas" ? "A graph you grow from the topic you are on" : EXPLORE_LAYOUT_LABELS[layout].description}</small></span>
      </button>)}
    </div>
  </DismissibleDetails>;
}
