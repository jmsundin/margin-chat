import DismissibleDetails from "./DismissibleDetails";

export type MapGrouping = "topics" | "groups" | "none";

export const MAP_GROUPING_OPTIONS: Array<{ value: MapGrouping; label: string; description: string }> = [
  { value: "topics", label: "Topics", description: "Found from links and meaning, named by AI" },
  { value: "groups", label: "My groups", description: "The groups in your sidebar" },
  { value: "none", label: "None", description: "One free canvas you arrange yourself" },
];

const labelOf = (value: MapGrouping) => MAP_GROUPING_OPTIONS.find((option) => option.value === value)!.label;

/** The Map's one grouping choice: what its boxes hold. A chip in the toolbar that opens three choices. */
export function MapGroupingMenu({ value, onChange }: { value: MapGrouping; onChange: (value: MapGrouping) => void }) {
  return <DismissibleDetails className="graph-map-grouping">
    <summary aria-label={`Group documents by: ${labelOf(value)}`} title="What the Map's boxes hold">
      <span className="graph-map-grouping-prefix">Group:</span> {labelOf(value)}
      <svg aria-hidden="true" viewBox="0 0 12 12"><path d="m3 4.5 3 3 3-3" /></svg>
    </summary>
    <div role="radiogroup" aria-label="Group documents by">
      {MAP_GROUPING_OPTIONS.map((option) => <button key={option.value} type="button" role="radio" aria-checked={option.value === value}
        onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); if (option.value !== value) onChange(option.value); }}>
        <strong>{option.label}</strong><span>{option.description}</span>
      </button>)}
    </div>
  </DismissibleDetails>;
}

/** The same choice as a row of buttons, for the phone map menu where there's no room for the chip. */
export function MapGroupingButtons({ value, onChange }: { value: MapGrouping; onChange: (value: MapGrouping) => void }) {
  return <div className="graph-map-grouping-buttons" role="group" aria-label="Group documents by">
    <span>Group</span>
    {MAP_GROUPING_OPTIONS.map((option) => <button key={option.value} type="button" aria-pressed={option.value === value}
      title={option.description} onClick={() => onChange(option.value)}>{option.label}</button>)}
  </div>;
}
