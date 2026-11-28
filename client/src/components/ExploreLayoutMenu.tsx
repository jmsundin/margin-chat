import type { ReactElement } from "react";
import DismissibleDetails from "./DismissibleDetails";
import { EXPLORE_LAYOUTS, EXPLORE_LAYOUT_LABELS, type ExploreLayout } from "../lib/exploreLibrary";

/** Around one note, Explore can also draw Rings: the note in the middle with its neighbours around it. */
export type ExploreMenuLayout = ExploreLayout | "rings";
const LABELS: Record<ExploreMenuLayout, { name: string; description: string }> = {
  ...EXPLORE_LAYOUT_LABELS,
  rings: { name: "Around this note", description: "This note in the middle, your linked notes and public topics around it. Tap a topic to go there." },
};

const ICONS: Record<ExploreMenuLayout, ReactElement> = {
  rings: <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><circle cx="12" cy="12" r="6.5" strokeDasharray="2 2.5" /><circle cx="12" cy="12" r="10" strokeDasharray="3 3" /></svg>,
  tiles: <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="3" width="10" height="18" rx="1.5" /><rect x="15" y="3" width="6" height="8" rx="1.5" /><rect x="15" y="13" width="6" height="8" rx="1.5" /></svg>,
  clusters: <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="8" cy="9" r="5" /><circle cx="17.5" cy="7.5" r="3.5" /><circle cx="15" cy="17.5" r="4" /></svg>,
  canvas: <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="4" width="7" height="5" rx="1" /><rect x="14" y="9" width="7" height="5" rx="1" /><rect x="5" y="15" width="7" height="5" rx="1" /><path d="M10 7h2.5a1.5 1.5 0 0 1 1.5 1.5V9M8.5 15v-1.5a1.5 1.5 0 0 1 1.5-1.5h4" /></svg>,
};

/** Explore's Layout menu: the same notes drawn as Tiles, Clusters or the free Canvas. */
export default function ExploreLayoutMenu({ value, onChange, publicSource = false, layouts = EXPLORE_LAYOUTS }: {
  value: ExploreMenuLayout; onChange: (layout: ExploreMenuLayout) => void;
  /** The layouts to offer; around one note Rings comes first. */
  layouts?: readonly ExploreMenuLayout[];
  /** On Wikipedia or an AI topic, Canvas grows a graph from the topic you are on. */
  publicSource?: boolean;
}) {
  return <DismissibleDetails className="explore-layout-menu" onKeyDown={(event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus();
  }}>
    <summary aria-label={`Layout: ${LABELS[value].name}`} title="Layout: how Explore draws your notes">
      {ICONS[value]}<span className="explore-layout-name">{LABELS[value].name}</span><span aria-hidden="true">▾</span>
    </summary>
    <div role="menu" aria-label="Layout">
      {layouts.map((layout) => <button type="button" role="menuitemradio" key={layout} aria-checked={layout === value}
        onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onChange(layout); }}>
        {ICONS[layout]}<span>{LABELS[layout].name}<small>{publicSource && layout === "canvas" ? "A graph you grow from the topic you are on" : LABELS[layout].description}</small></span>
      </button>)}
    </div>
  </DismissibleDetails>;
}
