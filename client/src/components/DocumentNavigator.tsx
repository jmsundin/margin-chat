import { useState, type ReactElement } from "react";
import type { Conversation } from "../types";
import { getDocumentKind } from "../lib/documentBreadcrumbs";
import { DOCUMENT_NAVIGATION_STYLES, type DocumentNavigationStyle, type DocumentNeighbors } from "../lib/documentNeighbors";
import { getDocumentPreview } from "../lib/documentSources";
import "./DocumentNavigator.css";

export type NeighborRelation = "parent" | "sibling" | "child" | "linked";
type OpenNeighbor = (id: string, relation: NeighborRelation) => void;

const STYLE_ICONS: Record<DocumentNavigationStyle, string> = {
  compass: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM15.5 8.5l-2 5-5 2 2-5z",
  graph: "M12 5.5a2 2 0 1 0 0-.01M5 18.5a2 2 0 1 0 0-.01M19 18.5a2 2 0 1 0 0-.01M11 7l-5 9.5M13 7l5 9.5M7 18.5h10",
  outline: "M4 6h2M9 6h11M7 12h2M12 12h8M7 18h2M12 18h8",
  reading: "M5 4h10l4 4v12H5zM9 12h6M9 16h4M14 20l3-3",
};

function Icon({ path, className = "document-navigator-icon" }: { path: string; className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={path} /></svg>;
}

function titleOf(document: Conversation) {
  return document.title || "Untitled document";
}

/** Four ways to show the documents around the focused one; the choice is remembered in this browser. */
export function DocumentNavigationSwitcher({ value, onChange }: { value: DocumentNavigationStyle; onChange: (style: DocumentNavigationStyle) => void }) {
  return <div className="document-navigation-switcher" role="radiogroup" aria-label="Show documents around this one as">
    {DOCUMENT_NAVIGATION_STYLES.map((style) => <button key={style.id} type="button" role="radio"
      aria-checked={value === style.id} aria-label={style.label} title={`${style.label}: ${style.description}`}
      className="document-navigation-switcher-option" onClick={() => onChange(style.id)}>
      <Icon path={STYLE_ICONS[style.id]} />
      <span className="document-navigation-switcher-label">{style.label}</span>
    </button>)}
  </div>;
}

function Chip({ document, relation, onOpen, current }: { document: Conversation; relation: NeighborRelation; onOpen: OpenNeighbor; current?: boolean }) {
  return <button type="button" className={`document-navigator-chip is-${relation}${current ? " is-current" : ""}`}
    aria-current={current ? "page" : undefined} title={titleOf(document)} onClick={() => onOpen(document.id, relation)}>
    <span className={`document-navigator-kind is-${getDocumentKind(document)}`} aria-hidden="true" />
    <span className="document-navigator-chip-label">{titleOf(document)}</span>
  </button>;
}

/** E: a strip above the documents with every direction you can go. */
export function DocumentCompass({ neighbors, onOpen }: { neighbors: DocumentNeighbors; onOpen: OpenNeighbor }) {
  const { parent, siblings, index, children, linked } = neighbors;
  const previous = siblings[index - 1];
  const next = siblings[index + 1];
  if (!parent && siblings.length < 2 && !children.length && !linked.length) return null;
  return <nav className="document-compass" aria-label="Documents around this one">
    {parent ? <div className="document-compass-group">
      <span className="document-compass-heading">Up</span>
      <Chip document={parent} relation="parent" onOpen={onOpen} />
    </div> : null}
    {siblings.length > 1 ? <div className="document-compass-group">
      <span className="document-compass-heading">{parent ? "Siblings" : "Peers"}</span>
      <button type="button" className="document-compass-step" disabled={!previous} onClick={() => previous && onOpen(previous.id, "sibling")}
        aria-label={previous ? `Previous: ${titleOf(previous)}` : "No previous document"} title={previous ? titleOf(previous) : undefined}>‹</button>
      <span className="document-compass-position">{index + 1} of {siblings.length}</span>
      <button type="button" className="document-compass-step" disabled={!next} onClick={() => next && onOpen(next.id, "sibling")}
        aria-label={next ? `Next: ${titleOf(next)}` : "No next document"} title={next ? titleOf(next) : undefined}>›</button>
      {next ? <Chip document={next} relation="sibling" onOpen={onOpen} /> : null}
    </div> : null}
    {children.length ? <div className="document-compass-group">
      <span className="document-compass-heading">Children</span>
      {children.slice(0, 4).map((child) => <Chip key={child.id} document={child} relation="child" onOpen={onOpen} />)}
      {children.length > 4 ? <span className="document-compass-more">+{children.length - 4}</span> : null}
    </div> : null}
    {linked.length ? <div className="document-compass-group">
      <span className="document-compass-heading">Linked</span>
      {linked.slice(0, 3).map((document) => <Chip key={document.id} document={document} relation="linked" onOpen={onOpen} />)}
      {linked.length > 3 ? <span className="document-compass-more">+{linked.length - 3}</span> : null}
    </div> : null}
    <span className="document-compass-hint" aria-hidden="true">Ctrl ⌥ + arrows</span>
  </nav>;
}

interface GraphNode { document: Conversation; relation: NeighborRelation | "here"; x: number; y: number }

function spread(count: number, center: number, gap: number) {
  return Array.from({ length: count }, (_, index) => center + (index - (count - 1) / 2) * gap);
}

/** F: a small map with the parent above, siblings beside, children below and links dashed. */
export function DocumentLocalGraph({ neighbors, onOpen, onOpenMap }: { neighbors: DocumentNeighbors; onOpen: OpenNeighbor; onOpenMap?: () => void }) {
  const [collapsed, setCollapsed] = useState(false);
  const { focused, parent, siblings, index, children, linked } = neighbors;
  const width = 300;
  const height = 230;
  const nodes: GraphNode[] = [{ document: focused, relation: "here", x: width / 2, y: 112 }];
  if (parent) nodes.push({ document: parent, relation: "parent", x: width / 2, y: 30 });
  const previous = siblings[index - 1];
  const next = siblings[index + 1];
  if (previous) nodes.push({ document: previous, relation: "sibling", x: 52, y: 112 });
  if (next) nodes.push({ document: next, relation: "sibling", x: width - 52, y: 112 });
  const shownChildren = children.slice(0, 4);
  spread(shownChildren.length, width / 2, shownChildren.length > 2 ? 72 : 120).forEach((x, at) => nodes.push({ document: shownChildren[at], relation: "child", x, y: 192 }));
  const shownLinked = linked.slice(0, 2);
  [[46, 34], [width - 46, 34]].slice(0, shownLinked.length).forEach(([x, y], at) => nodes.push({ document: shownLinked[at], relation: "linked", x, y }));
  const center = nodes[0];
  return <aside className={`document-local-graph${collapsed ? " is-collapsed" : ""}`} aria-label="Map around this document">
    <div className="document-local-graph-header">
      <span>Around this document</span>
      {onOpenMap ? <button type="button" className="document-local-graph-link" onClick={onOpenMap}>Open in Map</button> : null}
      <button type="button" className="document-local-graph-toggle" aria-expanded={!collapsed}
        aria-label={collapsed ? "Show the map around this document" : "Hide the map around this document"}
        onClick={() => setCollapsed((value) => !value)}>{collapsed ? "+" : "–"}</button>
    </div>
    {collapsed ? null : <>
      <svg className="document-local-graph-canvas" viewBox={`0 0 ${width} ${height}`} role="group" aria-label="Neighbouring documents">
        {nodes.slice(1).map((node) => <line key={`edge-${node.document.id}`} x1={center.x} y1={center.y} x2={node.x} y2={node.y}
          className={`document-local-graph-edge is-${node.relation}`} />)}
        {nodes.map((node) => {
          const label = titleOf(node.document);
          const room = node.relation === "child" && shownChildren.length > 2 ? 10 : 16;
          const short = label.length > room ? `${label.slice(0, room - 1).trimEnd()}…` : label;
          return <g key={node.document.id} className={`document-local-graph-node is-${node.relation}`} transform={`translate(${node.x} ${node.y})`}
            role={node.relation === "here" ? undefined : "button"} tabIndex={node.relation === "here" ? undefined : 0}
            aria-label={node.relation === "here" ? undefined : `Go to ${label}`}
            onClick={() => node.relation !== "here" && onOpen(node.document.id, node.relation)}
            onKeyDown={(event) => {
              if (node.relation !== "here" && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onOpen(node.document.id, node.relation); }
            }}>
            <title>{label}</title>
            <circle r={node.relation === "here" ? 9 : 6} />
            <text y={node.relation === "child" ? 18 : -13} textAnchor="middle">{short}</text>
          </g>;
        })}
      </svg>
      <p className="document-local-graph-legend">Up parent · beside siblings · down children · dashed linked</p>
    </>}
  </aside>;
}

/** G: the family as an outline beside the documents, with links underneath. */
export function DocumentTopicOutline({ neighbors, onOpen }: { neighbors: DocumentNeighbors; onOpen: (id: string) => void }) {
  const { focused, childrenByParent, linked } = neighbors;
  const roots = childrenByParent.get(null) ?? [];
  const seen = new Set<string>();
  function branch(documents: Conversation[], depth: number): ReactElement | null {
    const unseen = documents.filter((document) => !seen.has(document.id));
    if (!unseen.length || depth > 12) return null;
    return <ul className="document-topic-outline-list">
      {unseen.map((document) => {
        seen.add(document.id);
        const here = document.id === focused.id;
        return <li key={document.id}>
          <button type="button" className={`document-topic-outline-item${here ? " is-here" : ""}`} aria-current={here ? "page" : undefined}
            style={{ paddingLeft: `${8 + depth * 14}px` }} title={titleOf(document)} onClick={() => !here && onOpen(document.id)}>
            <span className={`document-navigator-kind is-${getDocumentKind(document)}`} aria-hidden="true" />
            <span className="document-topic-outline-label">{titleOf(document)}</span>
          </button>
          {branch(childrenByParent.get(document.id) ?? [], depth + 1)}
        </li>;
      })}
    </ul>;
  }
  return <nav className="document-topic-outline" aria-label="Document family outline">
    <div className="document-topic-outline-heading">{roots[0] ? titleOf(roots[0]) : "This family"}</div>
    {branch(roots, 0)}
    {linked.length ? <>
      <div className="document-topic-outline-heading">Linked to this document</div>
      <ul className="document-topic-outline-list">
        {linked.map((document) => <li key={document.id}>
          <button type="button" className="document-topic-outline-item is-linked" title={titleOf(document)} onClick={() => onOpen(document.id)}>
            <span className={`document-navigator-kind is-${getDocumentKind(document)}`} aria-hidden="true" />
            <span className="document-topic-outline-label">{titleOf(document)}</span>
          </button>
        </li>)}
      </ul>
    </> : null}
  </nav>;
}

/** H: where to go next, at the end of the document you just read. */
export function DocumentKeepReading({ neighbors, onOpen }: { neighbors: DocumentNeighbors; onOpen: OpenNeighbor }) {
  const { siblings, index, children, linked, parent } = neighbors;
  const previous = siblings[index - 1];
  const next = siblings[index + 1];
  if (!previous && !next && !children.length && !linked.length && !parent) return null;
  const card = (document: Conversation, relation: NeighborRelation, label: string) => <button key={`${relation}-${document.id}`} type="button"
    className={`document-keep-reading-card is-${relation}`} onClick={() => onOpen(document.id, relation)}>
    <span className="document-keep-reading-label">{label}</span>
    <strong className="document-keep-reading-title">{titleOf(document)}</strong>
    <span className="document-keep-reading-preview">{getDocumentPreview(document, 110)}</span>
  </button>;
  return <nav className="document-keep-reading" aria-label="Keep reading">
    <div className="document-keep-reading-heading">Keep reading</div>
    <div className="document-keep-reading-cards">
      {children.slice(0, 3).map((child) => card(child, "child", "Go deeper"))}
      {next ? card(next, "sibling", `Next · ${index + 2} of ${siblings.length}`) : null}
      {previous ? card(previous, "sibling", "Previous") : null}
      {!next && parent ? card(parent, "parent", "Back up") : null}
    </div>
    {linked.length ? <p className="document-keep-reading-linked">Also linked: {linked.slice(0, 5).map((document, at) => <span key={document.id}>
      {at ? ", " : ""}<button type="button" className="document-keep-reading-link" onClick={() => onOpen(document.id, "linked")}>{titleOf(document)}</button>
    </span>)}</p> : null}
  </nav>;
}
