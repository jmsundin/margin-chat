import type { ReactElement } from "react";
import type { Conversation } from "../types";
import { getDocumentKind } from "../lib/documentBreadcrumbs";
import { DOCUMENT_NAVIGATION_STYLES, type DocumentNavigationStyle, type DocumentNeighbors } from "../lib/documentNeighbors";
import type { DocumentMapSplitEdge } from "../lib/documentMapPanel";
import { getDocumentPreview } from "../lib/documentSources";
import "./DocumentNavigator.css";

export type NeighborRelation = "parent" | "sibling" | "child" | "linked";
type OpenNeighbor = (id: string, relation: NeighborRelation) => void;

const STYLE_ICONS: Record<DocumentNavigationStyle, string> = {
  compass: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM15.5 8.5l-2 5-5 2 2-5z",
  outline: "M4 6h2M9 6h11M7 12h2M12 12h8M7 18h2M12 18h8",
};
const MAP_ICON = "M12 5.5a2 2 0 1 0 0-.01M5 18.5a2 2 0 1 0 0-.01M19 18.5a2 2 0 1 0 0-.01M11 7l-5 9.5M13 7l5 9.5M7 18.5h10";
const SPLIT_TOP_ICON = "M5 4h14a1.5 1.5 0 0 1 1.5 1.5v13A1.5 1.5 0 0 1 19 20H5a1.5 1.5 0 0 1-1.5-1.5v-13A1.5 1.5 0 0 1 5 4zM3.5 12h17";
const SPLIT_LEFT_ICON = "M5 4h14a1.5 1.5 0 0 1 1.5 1.5v13A1.5 1.5 0 0 1 19 20H5a1.5 1.5 0 0 1-1.5-1.5v-13A1.5 1.5 0 0 1 5 4zM12 4v16";
const POPUP_ICON = "M5 4h14a1.5 1.5 0 0 1 1.5 1.5v13A1.5 1.5 0 0 1 19 20H5a1.5 1.5 0 0 1-1.5-1.5v-13A1.5 1.5 0 0 1 5 4zM9 9h6v6H9z";
const OPEN_MAP_ICON = "M14 4h6v6M20 4l-8 8M10 5H5v14h14v-5";

function Icon({ path, className = "document-navigator-icon" }: { path: string; className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={path} /></svg>;
}

function titleOf(document: Conversation) {
  return document.title || "Untitled document";
}

/** Ways to show the documents around the focused one; the choice is remembered in this browser. Labelled, it reads as tabs. */
export function DocumentNavigationSwitcher({ value, onChange, labelled }: { value: DocumentNavigationStyle; onChange: (style: DocumentNavigationStyle) => void; labelled?: boolean }) {
  return <div className={`document-navigation-switcher${labelled ? " is-labelled" : ""}`} role="radiogroup" aria-label="Show documents around this one as">
    {DOCUMENT_NAVIGATION_STYLES.map((style) => <button key={style.id} type="button" role="radio"
      aria-checked={value === style.id} aria-label={style.label} title={`${style.label}: ${style.description}`}
      className="document-navigation-switcher-option" onClick={() => onChange(style.id)}>
      <Icon path={STYLE_ICONS[style.id]} />
      <span className="document-navigation-switcher-label">{labelled ? style.shortLabel : style.label}</span>
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

/** E: every direction you can go from here. Beside the path, which already lists the parent and children, it shows only siblings and links. */
export function DocumentCompass({ neighbors, onOpen, besidePath = false }: { neighbors: DocumentNeighbors; onOpen: OpenNeighbor; besidePath?: boolean }) {
  const { siblings, index, linked } = neighbors;
  const parent = besidePath ? null : neighbors.parent;
  const children = besidePath ? [] : neighbors.children;
  const previous = siblings[index - 1];
  const next = siblings[index + 1];
  if (!parent && siblings.length < 2 && !children.length && !linked.length) return null;
  return <nav className="document-compass" aria-label="Documents around this one" title="Ctrl ⌥ + arrows moves between them">
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
  </nav>;
}

/** The header's map button: one tap shows the map around this document, another puts it away to its pill. */
export function DocumentMapButton({ open, onToggle, split, onToggleSplit, splitEdge = "left" }: {
  open: boolean; onToggle: () => void; split?: boolean; onToggleSplit?: () => void; splitEdge?: DocumentMapSplitEdge;
}) {
  const label = open ? "Minimize the map" : "Show the map around this document";
  return <div className="document-map-buttons" role="group" aria-label="Map">
    <button type="button" className="document-map-button" aria-pressed={open} aria-label={label} title={label} onClick={onToggle}>
      <Icon path={MAP_ICON} />
    </button>
    {onToggleSplit ? <button type="button" className="document-map-button is-split" aria-pressed={open && split}
      aria-label={open && split ? "Show the map as a popup" : "Show the map beside the document"}
      title={open && split ? "Show the map as a popup" : "Show the map beside the document"} onClick={onToggleSplit}>
      <Icon path={splitEdge === "top" ? SPLIT_TOP_ICON : SPLIT_LEFT_ICON} />
    </button> : null}
  </div>;
}

/** The open map's own header: split or popup, the full Map view, and minimize. */
export function DocumentMapHeader({ split, splitEdge = "left", onToggleSplit, onMinimize, onOpenMap }: {
  split: boolean; splitEdge?: DocumentMapSplitEdge; onToggleSplit: () => void; onMinimize: () => void; onOpenMap?: () => void;
}) {
  const splitLabel = split ? "Show the map as a popup" : "Show the map beside the document";
  return <div className="document-local-graph-header">
    <span id="document-map-modal-title">Around this document</span>
    <button type="button" className="document-local-graph-action" aria-label={splitLabel} title={splitLabel} onClick={onToggleSplit}>
      <Icon path={split ? POPUP_ICON : splitEdge === "top" ? SPLIT_TOP_ICON : SPLIT_LEFT_ICON} />
    </button>
    {onOpenMap ? <button type="button" className="document-local-graph-action" aria-label="Open in Map view" title="Open in Map view" onClick={onOpenMap}>
      <Icon path={OPEN_MAP_ICON} />
    </button> : null}
    <button type="button" className="document-local-graph-action" aria-label="Minimize the map" title="Minimize (Esc)" onClick={onMinimize}>
      <svg className="document-navigator-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 12h12" /></svg>
    </button>
  </div>;
}

/** Minimized, the map waits as a pill in the corner that brings it straight back, with its place and zoom kept. */
export function DocumentMapPill({ nearby, onRestore, onClose }: { nearby: number; onRestore: () => void; onClose: () => void }) {
  return <aside className="document-map-pill" aria-label="Map around this document">
    <button type="button" className="document-map-pill-restore" onClick={onRestore} title="Show the map again">
      <svg className="document-map-pill-graph" viewBox="0 0 40 32" aria-hidden="true">
        <g stroke="currentColor" strokeOpacity=".35" strokeWidth="1.2"><path d="M20 16V5M20 16 8 25M20 16l12 9" /></g>
        <circle cx="20" cy="16" r="4.5" fill="var(--accent)" /><circle cx="20" cy="5" r="3" fill="currentColor" fillOpacity=".55" />
        <circle cx="8" cy="25" r="3" fill="currentColor" fillOpacity=".55" /><circle cx="32" cy="25" r="3" fill="currentColor" fillOpacity=".55" />
      </svg>
      <span className="document-map-pill-label">Map</span>
      {nearby ? <span className="document-map-pill-count">{nearby} nearby</span> : null}
    </button>
    <button type="button" className="document-map-pill-close" aria-label="Put the map away" title="Put the map away" onClick={onClose}>×</button>
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
