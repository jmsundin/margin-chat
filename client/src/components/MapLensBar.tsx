import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import "./MapLensBar.css";
import type { Conversation, ConversationGroup } from "../types";
import {
  describeLensFilter, lensTimeline, lensValueCounts, MAP_DOCUMENT_TYPES, MAP_LENS_CONNECTIONS, MAP_LENS_FILTER_KINDS, MAP_LENS_HAS,
  MAP_LENS_LENGTHS, MAP_LENS_NEAR_DEPTHS, newLensFilter, type MapLens, type MapLensDateField, type MapLensFilter, type MapLensFilterKind, type SavedMapLens,
} from "../lib/mapLens";

const DAY = 86_400_000;
const dateInput = (value: number | null) => value === null ? "" : new Date(value).toISOString().slice(0, 10);
const fromDateInput = (value: string) => value ? Date.parse(`${value}T00:00:00Z`) : null;
const monthLabel = (value: number) => new Date(value).toLocaleDateString(undefined, { month: "short", year: "numeric" });

function Checklist({ options, values, onChange, empty }: {
  options: Array<{ value: string; label: string; count?: number }>; values: string[]; onChange: (values: string[]) => void; empty: string;
}) {
  if (!options.length) return <p className="map-lens-empty">{empty}</p>;
  return <div className="map-lens-checklist">
    {options.map((option) => <label key={option.value}>
      <input type="checkbox" checked={values.includes(option.value)}
        onChange={(event) => onChange(event.target.checked ? [...values, option.value] : values.filter((value) => value !== option.value))} />
      <span>{option.label}</span>{option.count !== undefined ? <small>{option.count.toLocaleString()}</small> : null}
    </label>)}
  </div>;
}

function FilterEditor({ filter, onChange, conversations, groups }: {
  filter: MapLensFilter; onChange: (filter: MapLensFilter) => void;
  conversations: Record<string, Conversation>; groups: Record<string, ConversationGroup>;
}) {
  const tags = useMemo(() => filter.kind === "tag" ? lensValueCounts(Object.values(conversations), (conversation) => conversation.tags) : [], [filter.kind, conversations]);
  const nodeTypes = useMemo(() => filter.kind === "nodeType" ? lensValueCounts(Object.values(conversations),
    (conversation) => conversation.nodeType ? [conversation.nodeType] : undefined) : [], [filter.kind, conversations]);
  switch (filter.kind) {
    case "edited":
    case "created": {
      const preset = (days: number | null) => onChange({ ...filter, from: days === null ? null : Math.floor((Date.now() - days * DAY) / DAY) * DAY, to: null });
      return <div className="map-lens-editor-body">
        <div className="map-lens-presets">
          <button type="button" onClick={() => preset(7)}>Past week</button>
          <button type="button" onClick={() => preset(30)}>Past month</button>
          <button type="button" onClick={() => preset(90)}>Past 3 months</button>
          <button type="button" onClick={() => preset(365)}>Past year</button>
        </div>
        <label>From <input type="date" value={dateInput(filter.from)} onChange={(event) => onChange({ ...filter, from: fromDateInput(event.target.value) })} /></label>
        <label>To <input type="date" value={dateInput(filter.to === null ? null : filter.to - DAY)}
          onChange={(event) => { const to = fromDateInput(event.target.value); onChange({ ...filter, to: to === null ? null : to + DAY }); }} /></label>
        <small>Or drag across the timeline below.</small>
      </div>;
    }
    case "connections":
      return <div className="map-lens-editor-body map-lens-options">
        {MAP_LENS_CONNECTIONS.map((option) => <label key={option.label}><input type="radio" name={filter.id} checked={filter.min === option.min && filter.max === option.max}
          onChange={() => onChange({ ...filter, min: option.min, max: option.max })} /> {option.label}</label>)}
        <small>Branch lines, links and typed relations all count.</small>
      </div>;
    case "words":
      return <div className="map-lens-editor-body map-lens-options">
        {MAP_LENS_LENGTHS.map((option) => <label key={option.label}><input type="radio" name={filter.id} checked={filter.min === option.min && filter.max === option.max}
          onChange={() => onChange({ ...filter, min: option.min, max: option.max })} /> {option.label}</label>)}
      </div>;
    case "has":
      return <div className="map-lens-editor-body map-lens-options">
        {MAP_LENS_HAS.map((option) => <label key={option.value}><input type="radio" name={filter.id} checked={filter.value === option.value}
          onChange={() => onChange({ ...filter, value: option.value })} /> {option.label}</label>)}
      </div>;
    case "type":
      return <div className="map-lens-editor-body"><Checklist options={MAP_DOCUMENT_TYPES} values={filter.values} empty=""
        onChange={(values) => onChange({ ...filter, values: values as typeof filter.values })} /></div>;
    case "tag":
      return <div className="map-lens-editor-body"><Checklist options={tags.slice(0, 40).map(([tag, count]) => ({ value: tag, label: `#${tag}`, count }))}
        values={filter.values} empty="No documents have tags yet." onChange={(values) => onChange({ ...filter, values })} /></div>;
    case "nodeType":
      return <div className="map-lens-editor-body"><Checklist options={nodeTypes.slice(0, 40).map(([type, count]) => ({ value: type, label: type, count }))}
        values={filter.values} empty="No documents set a type: property yet." onChange={(values) => onChange({ ...filter, values })} /></div>;
    case "group":
      return <div className="map-lens-editor-body"><Checklist options={Object.values(groups).map((group) => ({ value: group.id, label: group.name, count: group.conversationIds.length }))}
        values={filter.values} empty="You have no groups yet." onChange={(values) => onChange({ ...filter, values })} /></div>;
    case "near":
      return <div className="map-lens-editor-body map-lens-options">
        {MAP_LENS_NEAR_DEPTHS.map((depth) => <label key={depth}><input type="radio" name={filter.id} checked={filter.depth === depth}
          onChange={() => onChange({ ...filter, depth })} /> Within {depth} {depth === 1 ? "step" : "steps"}</label>)}
        <small>Steps follow branch lines, links and typed relations. Everything farther away greys out.</small>
      </div>;
    case "text":
      return <div className="map-lens-editor-body">
        <label>Words in the title or text <input type="search" autoFocus value={filter.query} placeholder="e.g. vector index"
          onChange={(event) => onChange({ ...filter, query: event.target.value })} /></label>
      </div>;
  }
}

/** The map's lens: filter chips, a match count, a timeline brush and saved lenses. */
export default function MapLensBar({ lens, onChange, ids, matched, conversations, groups, saved, onSave, onApplySaved, onDeleteSaved, onFitMatches,
  selectedId = null, matchPosition = null, onStepMatch }: {
  lens: MapLens;
  onChange: (lens: MapLens) => void;
  /** Documents in the current map scope. */
  ids: string[];
  matched: Set<string> | null;
  conversations: Record<string, Conversation>;
  groups: Record<string, ConversationGroup>;
  saved: SavedMapLens[];
  onSave: (name: string) => void;
  onApplySaved: (lens: SavedMapLens) => void;
  onDeleteSaved: (id: string) => void;
  onFitMatches: () => void;
  /** The selected document, which "Near the selected document" centers on. */
  selectedId?: string | null;
  /** Which match is selected, counting from 1, while stepping through them. */
  matchPosition?: number | null;
  /** Selects the next (1) or previous (-1) match and moves the map to it. */
  onStepMatch?: (direction: 1 | -1) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [field, setField] = useState<MapLensDateField>(() => lens.filters.some((filter) => filter.kind === "created") ? "created" : "edited");
  const [saveName, setSaveName] = useState("");
  const timelineRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const bins = useMemo(() => lensTimeline(ids, conversations, field, matched), [ids, conversations, field, matched]);
  const maxBin = Math.max(1, ...bins.map((bin) => bin.total));
  const dateFilter = lens.filters.find((filter): filter is Extract<MapLensFilter, { kind: MapLensDateField }> => filter.kind === field);

  const update = (filter: MapLensFilter) => onChange({ filters: lens.filters.map((item) => item.id === filter.id ? filter : item) });
  const remove = (id: string) => { onChange({ filters: lens.filters.filter((item) => item.id !== id) }); if (editingId === id) setEditingId(null); };
  const add = (kind: MapLensFilterKind) => {
    if (kind === "near" && !selectedId) return;
    const filter = newLensFilter(kind, Date.now(), selectedId ?? "");
    onChange({ filters: [...lens.filters, filter] });
    setEditingId(filter.id);
    if (kind === "edited" || kind === "created") setField(kind);
  };

  const binAt = (event: ReactPointerEvent) => {
    const rect = timelineRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min(bins.length - 1, Math.floor((event.clientX - rect.left) / rect.width * bins.length)));
  };
  const commitRange = (from: number, to: number) => {
    const [first, last] = from <= to ? [from, to] : [to, from];
    const range = { from: bins[first].start, to: bins[last].end };
    if (dateFilter) update({ ...dateFilter, ...range });
    else onChange({ filters: [...lens.filters, { ...newLensFilter(field), ...range } as MapLensFilter] });
  };
  const selection = drag ? { first: Math.min(drag.from, drag.to), last: Math.max(drag.from, drag.to) } : dateFilter && bins.length ? {
    first: Math.max(0, bins.findIndex((bin) => dateFilter.from === null || bin.end > dateFilter.from)),
    last: (() => { const index = bins.findIndex((bin) => dateFilter.to !== null && bin.end >= dateFilter.to); return index < 0 ? bins.length - 1 : index; })(),
  } : null;

  return <section className="map-lens" aria-label="Filter the map" data-graph-ui="true">
    <div className="map-lens-row">
      <ul className="map-lens-chips" aria-label="Active filters">
        {lens.filters.map((filter) => <li key={filter.id} className="map-lens-chip">
          <button type="button" aria-expanded={editingId === filter.id} onClick={() => setEditingId(editingId === filter.id ? null : filter.id)}>
            {describeLensFilter(filter, groups, conversations)}
          </button>
          <button type="button" className="map-lens-chip-remove" aria-label={`Remove filter: ${describeLensFilter(filter, groups, conversations)}`} onClick={() => remove(filter.id)}>×</button>
          {editingId === filter.id ? <div className="map-lens-editor" role="dialog" aria-label={describeLensFilter(filter, groups, conversations)}
            onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setEditingId(null); } }}>
            <FilterEditor filter={filter} onChange={update} conversations={conversations} groups={groups} />
            <button type="button" className="map-lens-done" onClick={() => setEditingId(null)}>Done</button>
          </div> : null}
        </li>)}
        <li>
          <details className="map-lens-add">
            <summary>+ Add filter</summary>
            <div role="menu">
              {MAP_LENS_FILTER_KINDS.map((option) => <button type="button" role="menuitem" key={option.kind}
                disabled={option.kind === "near" && !selectedId} title={option.kind === "near" && !selectedId ? "Select a document on the map first" : undefined}
                onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); add(option.kind); }}>{option.label}</button>)}
            </div>
          </details>
        </li>
      </ul>
      <strong className="map-lens-count" role="status">
        {matched ? <>{matched.size.toLocaleString()} <span>of {ids.length.toLocaleString()} match</span></> : <span>{ids.length.toLocaleString()} documents · add a filter to narrow them</span>}
      </strong>
      <div className="map-lens-actions">
        {matched?.size && onStepMatch ? <div className="map-lens-step" role="group" aria-label="Step through matches">
          <button type="button" aria-label="Previous match" title="Previous match (Shift+N)" onClick={() => onStepMatch(-1)}>‹</button>
          <span aria-live="polite">{matchPosition ? `${matchPosition.toLocaleString()} / ${matched.size.toLocaleString()}` : "Step"}</span>
          <button type="button" aria-label="Next match" title="Next match (N)" onClick={() => onStepMatch(1)}>›</button>
        </div> : null}
        {matched?.size ? <button type="button" onClick={onFitMatches}>Fit to matches</button> : null}
        <details className="map-lens-saved">
          <summary>Saved{saved.length ? ` · ${saved.length}` : ""}</summary>
          <div>
            {saved.length ? <ul>{saved.map((item) => <li key={item.id}>
              <button type="button" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onApplySaved(item); }}>{item.name}</button>
              <button type="button" aria-label={`Delete saved filter ${item.name}`} onClick={() => onDeleteSaved(item.id)}>×</button>
            </li>)}</ul> : <p className="map-lens-empty">No saved filters yet.</p>}
            {lens.filters.length ? <form onSubmit={(event) => { event.preventDefault(); if (!saveName.trim()) return; onSave(saveName.trim()); setSaveName(""); event.currentTarget.closest("details")?.removeAttribute("open"); }}>
              <label>Save these filters as <input value={saveName} onChange={(event) => setSaveName(event.target.value)} placeholder="e.g. Launch work" /></label>
              <button type="submit" disabled={!saveName.trim()}>Save</button>
            </form> : null}
          </div>
        </details>
        {lens.filters.length ? <button type="button" onClick={() => { onChange({ filters: [] }); setEditingId(null); }}>Clear</button> : null}
      </div>
    </div>
    {bins.length > 1 ? <div className="map-lens-timeline">
      <div className="map-lens-timeline-head">
        <div className="map-lens-field" role="group" aria-label="Timeline shows">
          <button type="button" aria-pressed={field === "edited"} onClick={() => setField("edited")}>Last edited</button>
          <button type="button" aria-pressed={field === "created"} onClick={() => setField("created")}>Created</button>
        </div>
        <span>Drag across the bars to filter by date</span>
      </div>
      <div ref={timelineRef} className="map-lens-bars" role="slider" tabIndex={0} aria-label={`Filter by ${field === "edited" ? "last edited" : "created"} date`}
        aria-valuemin={0} aria-valuemax={bins.length - 1} aria-valuenow={selection?.first ?? 0}
        aria-valuetext={dateFilter ? describeLensFilter(dateFilter) : "Any time"}
        onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); const bin = binAt(event); setDrag({ from: bin, to: bin }); }}
        onPointerMove={(event) => { if (drag) setDrag({ ...drag, to: binAt(event) }); }}
        onPointerUp={() => { if (drag) commitRange(drag.from, drag.to); setDrag(null); }}
        onPointerCancel={() => setDrag(null)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const step = event.key === "ArrowLeft" ? -1 : 1;
          const first = Math.max(0, Math.min(bins.length - 1, (selection?.first ?? bins.length - 1) + step));
          const last = Math.max(first, Math.min(bins.length - 1, (selection?.last ?? bins.length - 1) + (event.shiftKey ? 0 : step)));
          commitRange(event.shiftKey ? selection?.first ?? first : first, last);
        }}>
        {bins.map((bin, index) => {
          const selected = !!selection && index >= selection.first && index <= selection.last;
          return <span key={bin.start} className={selected ? "is-selected" : undefined} title={`${monthLabel(bin.start)}: ${bin.total.toLocaleString()} documents`}>
            <i style={{ height: `${Math.max(bin.total ? 4 : 0, bin.total / maxBin * 100)}%` }} />
            <b style={{ height: `${Math.max(bin.matched ? 4 : 0, bin.matched / maxBin * 100)}%` }} />
          </span>;
        })}
      </div>
      <div className="map-lens-axis" aria-hidden="true"><span>{monthLabel(bins[0].start)}</span><span>{monthLabel(bins.at(-1)!.end - 1)}</span></div>
    </div> : null}
  </section>;
}
