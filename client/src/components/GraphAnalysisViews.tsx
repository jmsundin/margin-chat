import { useMemo, useState } from "react";
import type { Conversation, ConversationGroup } from "../types";
import {
  getGraphAnalysisEdges, getGraphFlowSummary, getGraphTimelineEntries,
  type GraphAnalysisEdge, type GraphAnalysisRelationKind, type GraphFlowBand, type GraphFlowGroup,
} from "../lib/graphAnalysis";
import "./GraphAnalysisViews.css";

export interface GraphAnalysisViewsProps {
  mode: "timeline" | "matrix" | "flow";
  conversations: Record<string, Conversation>;
  groups: Record<string, ConversationGroup>;
  selectedConversationId: string | null;
  onOpenConversation: (id: string) => void;
  relationKinds?: GraphAnalysisRelationKind[];
}
type SourceProps = Pick<GraphAnalysisViewsProps, "conversations" | "selectedConversationId" | "onOpenConversation">;
const PAGE_SIZE = 40;
const MATRIX_SIZE = 16;
const FLOW_SIZE = 18;

function DocumentButton({ id, conversations, selectedConversationId, onOpenConversation }: SourceProps & { id: string }) {
  return <button type="button" className={`graph-analysis-document${selectedConversationId === id ? " is-selected" : ""}`}
    aria-current={selectedConversationId === id ? "true" : undefined} onClick={() => onOpenConversation(id)}>
    {conversations[id]?.title || "Untitled document"}
  </button>;
}

function Pagination({ label, page, pageSize, total, onChange }: {
  label: string; page: number; pageSize: number; total: number; onChange: (page: number) => void;
}) {
  const last = Math.max(0, Math.ceil(total / pageSize) - 1);
  return <div className="graph-analysis-pagination" aria-label={`${label} pagination`}>
    <span>{label}: {total ? page * pageSize + 1 : 0}–{Math.min((page + 1) * pageSize, total)} of {total}</span>
    <button type="button" aria-label={`Previous ${label.toLowerCase()}`} disabled={!page} onClick={() => onChange(page - 1)}>←</button>
    <button type="button" aria-label={`Next ${label.toLowerCase()}`} disabled={page >= last} onClick={() => onChange(page + 1)}>→</button>
  </div>;
}

function RelationshipSources({ edges, ...sourceProps }: SourceProps & { edges: GraphAnalysisEdge[] }) {
  const [limit, setLimit] = useState(PAGE_SIZE);
  return <div className="graph-analysis-relationship-sources">
    <ol>
      {edges.slice(0, limit).map((edge) => <li key={edge.id}>
        <DocumentButton id={edge.sourceId} {...sourceProps} />
        <span className={`graph-analysis-relation is-${edge.kind}`}>{edge.kind === "branch" ? "parent → child" : "links to →"}</span>
        <DocumentButton id={edge.targetId} {...sourceProps} />
      </li>)}
    </ol>
    {edges.length > limit && <button className="graph-analysis-more" type="button" onClick={() => setLimit((value) => value + PAGE_SIZE)}>
      Show more relationships ({limit} of {edges.length})
    </button>}
  </div>;
}

function Timeline({ conversations, ...sourceProps }: SourceProps) {
  const [basis, setBasis] = useState<"created" | "updated">("updated");
  const [page, setPage] = useState(0);
  const entries = useMemo(() => getGraphTimelineEntries(conversations, basis), [conversations, basis]);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(entries.length / PAGE_SIZE) - 1));
  const visibleEntries = entries.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const unknownCount = entries.filter((entry) => entry.timestamp === null).length;
  let previousDay = "";
  return <>
    <div className="graph-analysis-controls">
      <label>Document date <select value={basis} onChange={(event) => { setBasis(event.target.value as "created" | "updated"); setPage(0); }}>
        <option value="updated">Last edited</option><option value="created">Created</option>
      </select></label>
      <Pagination label="Documents" total={entries.length} page={currentPage} pageSize={PAGE_SIZE} onChange={setPage} />
    </div>
    <p className="graph-analysis-hint">Newest first, in your local time. These are document timestamps. {unknownCount > 0 && <>{unknownCount} with unknown dates appear at the end. </>}Select a document to read and edit it.</p>
    {!entries.length ? <p className="graph-analysis-empty">No documents in this view.</p> : <ol className="graph-analysis-timeline">
      {visibleEntries.map((entry) => {
        const date = entry.timestamp === null ? null : new Date(entry.timestamp);
        const day = date?.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }) ?? "Unknown date";
        const showHeading = day !== previousDay;
        previousDay = day;
        return <li key={entry.conversationId}>
          {showHeading && <h3>{day}</h3>}
          <div className="graph-analysis-timeline-entry">
            {date ? <time dateTime={date.toISOString()} title={date.toLocaleString()}>{date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</time> : <span className="graph-analysis-unknown-date">—</span>}
            <DocumentButton id={entry.conversationId} conversations={conversations} {...sourceProps} />
            <span className="graph-analysis-event">{date ? basis === "updated" ? "Last edited" : "Created" : "Date unavailable"}</span>
          </div>
        </li>;
      })}
    </ol>}
  </>;
}

function Matrix({ conversations, edges, ...sourceProps }: SourceProps & { edges: GraphAnalysisEdge[] }) {
  const [rowPage, setRowPage] = useState(0);
  const [columnPage, setColumnPage] = useState(0);
  const [selectedCell, setSelectedCell] = useState<[string, string] | null>(null);
  const documents = useMemo(() => Object.values(conversations).sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id)), [conversations]);
  const lastPage = Math.max(0, Math.ceil(documents.length / MATRIX_SIZE) - 1);
  const currentRowPage = Math.min(rowPage, lastPage);
  const currentColumnPage = Math.min(columnPage, lastPage);
  const rows = documents.slice(currentRowPage * MATRIX_SIZE, (currentRowPage + 1) * MATRIX_SIZE);
  const columns = documents.slice(currentColumnPage * MATRIX_SIZE, (currentColumnPage + 1) * MATRIX_SIZE);
  const cells = useMemo(() => {
    const result = new Map<string, GraphAnalysisEdge[]>();
    for (const edge of edges) {
      const key = JSON.stringify([edge.sourceId, edge.targetId]);
      result.set(key, [...result.get(key) ?? [], edge]);
    }
    return result;
  }, [edges]);
  const selectedEdges = selectedCell ? cells.get(JSON.stringify(selectedCell)) ?? [] : [];
  const revealSelection = () => {
    const index = documents.findIndex((document) => document.id === sourceProps.selectedConversationId);
    if (index < 0) return;
    setRowPage(Math.floor(index / MATRIX_SIZE));
    setColumnPage(Math.floor(index / MATRIX_SIZE));
  };
  return <>
    <div className="graph-analysis-controls">
      <Pagination label="Rows" page={currentRowPage} total={documents.length} pageSize={MATRIX_SIZE} onChange={setRowPage} />
      <Pagination label="Columns" page={currentColumnPage} total={documents.length} pageSize={MATRIX_SIZE} onChange={setColumnPage} />
      {sourceProps.selectedConversationId && conversations[sourceProps.selectedConversationId] && <button type="button" onClick={revealSelection}>Find selected document</button>}
    </div>
    <p className="graph-analysis-hint">Read from row → column. <b className="is-branch">B</b> = parent → child; <b className="is-link">L</b> = authored link. Select a filled cell to inspect its sources. Both axes can be paged independently.</p>
    {!documents.length ? <p className="graph-analysis-empty">No documents in this view.</p> : <div className="graph-analysis-matrix-scroll" tabIndex={0} aria-label="Relationship matrix, scroll horizontally">
      <table className="graph-analysis-matrix">
        <caption>{edges.length} directed relationships among {documents.length} documents</caption>
        <thead><tr><th scope="col">Source ↓ / Target →</th>{columns.map((document) => <th scope="col" key={document.id} title={document.title}>
          <DocumentButton id={document.id} conversations={conversations} {...sourceProps} />
        </th>)}</tr></thead>
        <tbody>{rows.map((source) => <tr key={source.id} className={sourceProps.selectedConversationId === source.id ? "is-selected" : undefined}>
          <th scope="row"><DocumentButton id={source.id} conversations={conversations} {...sourceProps} /></th>
          {columns.map((target) => {
            const cellEdges = cells.get(JSON.stringify([source.id, target.id])) ?? [];
            const active = selectedCell?.[0] === source.id && selectedCell[1] === target.id;
            const kinds = cellEdges.map((edge) => edge.kind === "branch" ? "parent to child" : "authored link").join(" and ");
            return <td key={target.id} className={active ? "is-active" : undefined}>
              {cellEdges.length ? <button type="button" aria-pressed={active} aria-label={`${source.title} to ${target.title}: ${kinds}`}
                onClick={() => setSelectedCell([source.id, target.id])}>
                {cellEdges.map((edge) => <span key={edge.kind} className={`is-${edge.kind}`}>{edge.kind === "branch" ? "B" : "L"}</span>)}
              </button> : <span className="graph-analysis-matrix-blank" aria-label="No relationship">·</span>}
            </td>;
          })}
        </tr>)}</tbody>
      </table>
    </div>}
    {selectedCell && <section className="graph-analysis-inspector" aria-label="Selected matrix relationship" aria-live="polite">
      <h3>Selected relationship</h3>
      {selectedEdges.length ? <RelationshipSources key={JSON.stringify(selectedCell)} edges={selectedEdges} conversations={conversations} {...sourceProps} /> : <p className="graph-analysis-hint">This relationship is no longer in the current view.</p>}
    </section>}
  </>;
}

function FlowDiagram({ bands, groups, selectedBandId, onSelect }: {
  bands: GraphFlowBand[]; groups: GraphFlowGroup[]; selectedBandId: string; onSelect: (id: string) => void;
}) {
  const groupsById = new Map(groups.map((group) => [group.id, group]));
  const sourceIds = [...new Set(bands.map((band) => band.sourceGroupId))];
  const targetIds = [...new Set(bands.map((band) => band.targetGroupId))];
  const count = bands.reduce((sum, band) => sum + band.count, 0);
  const gap = 14;
  const padding = 30;
  const height = Math.max(300, Math.max(sourceIds.length, targetIds.length) * 38 + padding * 2);
  const unit = (height - padding * 2 - gap * Math.max(sourceIds.length - 1, targetIds.length - 1)) / Math.max(1, count);
  const positions = (ids: string[], side: "sourceGroupId" | "targetGroupId") => {
    let cursor = padding;
    return new Map(ids.map((id) => {
      const size = bands.filter((band) => band[side] === id).reduce((sum, band) => sum + band.count, 0) * unit;
      const position = { y: cursor, height: size, cursor };
      cursor += size + gap;
      return [id, position];
    }));
  };
  const sources = positions(sourceIds, "sourceGroupId");
  const targets = positions(targetIds, "targetGroupId");
  const shortLabel = (value: string) => value.length > 25 ? `${value.slice(0, 24)}…` : value;
  return <div className="graph-analysis-flow-scroll">
    <svg className="graph-analysis-flow-diagram" viewBox={`0 0 820 ${height}`} role="img" aria-label="Directed relationship counts between document groups; wider ribbons represent more relationships">
      <text x="208" y="16" textAnchor="end" className="graph-analysis-flow-axis">Source groups</text>
      <text x="612" y="16" className="graph-analysis-flow-axis">Target groups</text>
      {bands.map((band) => {
        const source = sources.get(band.sourceGroupId)!;
        const target = targets.get(band.targetGroupId)!;
        const y1 = source.cursor;
        const y2 = target.cursor;
        const size = band.count * unit;
        source.cursor += size;
        target.cursor += size;
        const label = `${groupsById.get(band.sourceGroupId)!.label} to ${groupsById.get(band.targetGroupId)!.label}: ${band.count} relationships`;
        return <path key={band.id} className={band.id === selectedBandId ? "is-selected" : undefined}
          d={`M 230 ${y1} C 385 ${y1}, 435 ${y2}, 590 ${y2} L 590 ${y2 + size} C 435 ${y2 + size}, 385 ${y1 + size}, 230 ${y1 + size} Z`}
          role="button" tabIndex={0} aria-label={`Inspect ${label}`} aria-pressed={band.id === selectedBandId} onClick={() => onSelect(band.id)}
          onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(band.id); } }}><title>{label}</title></path>;
      })}
      {([{ values: sources, x: 220, labelX: 208, anchor: "end" }, { values: targets, x: 590, labelX: 612, anchor: "start" }] as const).map((side) =>
        [...side.values].map(([id, position]) => <g key={`${side.x}:${id}`}><title>{groupsById.get(id)!.label}</title>
          <rect x={side.x} y={position.y} width="10" height={position.height} rx="2" />
          <text x={side.labelX} y={position.y + position.height / 2} dominantBaseline="middle" textAnchor={side.anchor}>{shortLabel(groupsById.get(id)!.label)}</text>
        </g>))}
    </svg>
  </div>;
}

function Flow({ conversations, groups, edges, ...sourceProps }: SourceProps & { groups: Record<string, ConversationGroup>; edges: GraphAnalysisEdge[] }) {
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const summary = useMemo(() => getGraphFlowSummary(conversations, groups, edges), [conversations, groups, edges]);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(summary.bands.length / FLOW_SIZE) - 1));
  const bands = summary.bands.slice(currentPage * FLOW_SIZE, (currentPage + 1) * FLOW_SIZE);
  const selectedBand = bands.find((band) => band.id === selectedId) ?? bands[0];
  const byId = new Map(summary.groups.map((group) => [group.id, group]));
  return <>
    <div className="graph-analysis-controls">
      <strong>{summary.totalCount} directed relationships</strong>
      <Pagination label="Group pairs" page={currentPage} total={summary.bands.length} pageSize={FLOW_SIZE} onChange={setPage} />
    </div>
    <p className="graph-analysis-hint">Metric: count of parent → child relationships and authored links. Each relationship is counted once. Documents in several groups appear under their combined membership, such as “Research + Design”. Ribbon widths share one scale within this page.</p>
    {!bands.length ? <p className="graph-analysis-empty">Connect documents or create branches to see relationships between groups.</p> : <>
      <FlowDiagram bands={bands} groups={summary.groups} selectedBandId={selectedBand.id} onSelect={setSelectedId} />
      <div className="graph-analysis-flow-pairs" aria-label="Group relationship pairs">
        {bands.map((band) => <button type="button" key={band.id} aria-pressed={selectedBand.id === band.id} onClick={() => setSelectedId(band.id)}>
          <span>{byId.get(band.sourceGroupId)!.label} <span aria-hidden="true">→</span> {byId.get(band.targetGroupId)!.label}</span>
          <strong>{band.count}</strong>
        </button>)}
      </div>
      <section className="graph-analysis-inspector" aria-label="Selected flow sources" aria-live="polite">
        <h3>{byId.get(selectedBand.sourceGroupId)!.label} → {byId.get(selectedBand.targetGroupId)!.label}</h3>
        <p className="graph-analysis-hint">{selectedBand.branchCount} parent → child relationships · {selectedBand.linkCount} authored links. Open either document to inspect the source.</p>
        <RelationshipSources key={selectedBand.id} edges={selectedBand.edges} conversations={conversations} {...sourceProps} />
      </section>
    </>}
  </>;
}

const MODE_COPY = {
  timeline: { title: "Documents through time", description: "Follow creation and editing activity across your documents." },
  matrix: { title: "Relationships at a glance", description: "Inspect dense connections without overlapping lines." },
  flow: { title: "Connections between groups", description: "See where recorded relationships connect your areas of work." },
};

export function GraphAnalysisViews({ mode, conversations, groups, selectedConversationId, onOpenConversation, relationKinds }: GraphAnalysisViewsProps) {
  const allEdges = useMemo(() => getGraphAnalysisEdges(conversations), [conversations]);
  const edges = useMemo(() => relationKinds ? allEdges.filter((edge) => relationKinds.includes(edge.kind)) : allEdges, [allEdges, relationKinds]);
  const sourceProps = { conversations, selectedConversationId, onOpenConversation };
  return <section className={`graph-analysis-view graph-analysis-${mode}`} aria-label={`${mode[0].toUpperCase()}${mode.slice(1)} view`}>
    <header className="graph-analysis-heading"><span>{mode}</span><h2>{MODE_COPY[mode].title}</h2><p>{MODE_COPY[mode].description}</p></header>
    {mode === "timeline" ? <Timeline {...sourceProps} /> : mode === "matrix" ? <Matrix {...sourceProps} edges={edges} /> : <Flow {...sourceProps} groups={groups} edges={edges} />}
  </section>;
}

export default GraphAnalysisViews;
