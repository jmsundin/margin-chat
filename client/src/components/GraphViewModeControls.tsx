import { GRAPH_VIEW_MODES, type GraphContentLens, type GraphViewMode } from "../lib/graphViewModes";

interface Props {
  mode: GraphViewMode;
  lens: GraphContentLens;
  onModeChange: (mode: GraphViewMode) => void;
  onLensChange: (lens: GraphContentLens) => void;
}

/** Primary view tabs, rendered inline in the map toolbar. */
export function GraphViewModeTabs({ mode, lens, onModeChange }: Pick<Props, "mode" | "lens" | "onModeChange">) {
  return <div className="graph-view-mode-tabs" role="group" aria-label="Map mode">
    {GRAPH_VIEW_MODES.slice(0, 5).map((item) => <button key={item.id} type="button" aria-label={`${item.label} view`}
      aria-pressed={mode === item.id && lens === "documents"} title={item.description}
      onClick={() => onModeChange(item.id)}>{item.label}</button>)}
    <span className="graph-view-purpose" aria-live="polite">{lens === "concepts" ? "Collect concepts across documents and open their exact sources."
      : GRAPH_VIEW_MODES.find((item) => item.id === mode)?.description}</span>
  </div>;
}

/** Secondary view choices, rendered inside the map view options menu. */
export function GraphViewModeSelects({ mode, lens, onModeChange, onLensChange }: Props) {
  const advanced = GRAPH_VIEW_MODES.slice(5);
  return <div className="graph-view-mode-selects" aria-label="Graph views">
    <label className="graph-view-mode-select"><span>More views</span>
      <select aria-label="More graph views" value={advanced.some((item) => item.id === mode) && lens === "documents" ? mode : ""}
        onChange={(event) => { if (event.target.value) onModeChange(event.target.value as GraphViewMode); }}>
        <option value="" disabled>Choose a view…</option>
        {advanced.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select>
    </label>
    <label className="graph-view-mode-select"><span>Content</span>
      <select aria-label="Graph content lens" value={mode === "evidence" && lens === "documents" ? "evidence" : lens}
        onChange={(event) => event.target.value === "evidence" ? onModeChange("evidence") : onLensChange(event.target.value as GraphContentLens)}>
        <option value="documents">Documents</option><option value="concepts">Concepts</option><option value="evidence">Claims &amp; evidence</option>
      </select>
    </label>
  </div>;
}
