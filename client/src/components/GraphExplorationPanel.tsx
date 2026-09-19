import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { GraphConcept, GraphEvidenceRef } from "../lib/graphExploration";
import "./GraphExplorationPanel.css";

export interface GraphExplorationOverviewItem {
  id: string;
  label: string;
  kind: "Group" | "Category" | "Concept" | "Ungrouped";
  count: number;
  description?: string;
  examples: string[];
}

export interface GraphExplorationSourceItem {
  id: string;
  title: string;
  preview: string;
  sourceLabel: string;
  evidence: GraphEvidenceRef;
}

export interface GraphExplorationPanelProps {
  overviewItems: GraphExplorationOverviewItem[];
  sourceItems: GraphExplorationSourceItem[];
  concepts: GraphConcept[];
  scopeLabel: string;
  scopeKind: string;
  scopeKey?: string;
  selectedConversationTitle?: string;
  selectedConceptId?: string;
  query: string;
  onQueryChange: (query: string) => void;
  onOpenOverviewItem: (id: string) => void;
  onSelectSource: (source: GraphEvidenceRef) => void;
  onCreateConcept: (label: string, description: string) => void;
  onUpdateConcept: (concept: GraphConcept) => void;
  onDeleteConcept: (id: string) => void;
  onAddSelectionToConcept: (id: string) => void;
  onFocusSelection: () => void;
  onShowBranchSource?: () => void;
}

function ConceptForm({ label = "", description = "", onSave, onCancel, creating = false }: {
  label?: string;
  description?: string;
  onSave: (label: string, description: string) => void;
  onCancel: () => void;
  creating?: boolean;
}) {
  const [name, setName] = useState(label);
  const [summary, setSummary] = useState(description);
  const fieldId = useId();

  return <form className="graph-exploration-form" aria-label={creating ? "Create concept" : "Edit concept"}
    onSubmit={(event) => {
      event.preventDefault();
      if (name.trim()) onSave(name.trim(), summary.trim());
    }} onKeyDown={(event) => {
      if (event.key === "Escape") { event.stopPropagation(); onCancel(); }
    }}>
    <label htmlFor={`${fieldId}-name`}>Concept name</label>
    <input autoFocus id={`${fieldId}-name`} value={name} onChange={(event) => setName(event.target.value)}
      maxLength={120} required placeholder="e.g. Local-first privacy" />
    <label htmlFor={`${fieldId}-description`}>Description <span>(optional)</span></label>
    <textarea id={`${fieldId}-description`} value={summary} onChange={(event) => setSummary(event.target.value)}
      maxLength={1000} rows={3} placeholder="What connects these sources?" />
    <div className="graph-exploration-actions">
      <button className="graph-exploration-primary" type="submit" disabled={!name.trim()}>{creating ? "Create concept" : "Save changes"}</button>
      <button type="button" onClick={onCancel}>Cancel</button>
    </div>
  </form>;
}

const SOURCE_PAGE_SIZE = 40;

function SourceResults({ items, searching, scopeLabel, conceptScope, onSelect }: {
  items: GraphExplorationSourceItem[];
  searching: boolean;
  scopeLabel: string;
  conceptScope: boolean;
  onSelect: (evidence: GraphEvidenceRef) => void;
}) {
  const [limit, setLimit] = useState(SOURCE_PAGE_SIZE);
  const visibleItems = items.slice(0, limit);
  const countLabel = searching ? "results" : conceptScope ? "references" : "chats and notes";
  return <>
    <p className="graph-exploration-list-hint" role="status">
      Showing {visibleItems.length} of {items.length} {countLabel} in {scopeLabel}.
    </p>
    {items.length ? <>
      <ul className="graph-exploration-source-list">
        {visibleItems.map((item) => <li key={item.id}>
          <button className="graph-exploration-source-item" type="button" onClick={() => onSelect(item.evidence)}>
            <span className="graph-exploration-source-label">{item.sourceLabel}</span>
            <strong>{item.title}</strong>
            {item.preview ? <span className="graph-exploration-source-preview">{item.preview}</span> : null}
          </button>
        </li>)}
      </ul>
      {visibleItems.length < items.length ? <button className="graph-exploration-show-more" type="button"
        onClick={() => setLimit((current) => current + SOURCE_PAGE_SIZE)}>
        Show {Math.min(SOURCE_PAGE_SIZE, items.length - visibleItems.length)} more {countLabel}
      </button> : null}
    </> : <p className="graph-exploration-empty">{searching
      ? "No matching results in this view. Try a different phrase or return to the full map."
      : "There are no sources in this view yet. Add a selected chat or note to a concept below."}</p>}
  </>;
}

function ConceptMembers({ concept, titles, onSelect, onUpdate }: {
  concept: GraphConcept;
  titles: ReadonlyMap<string, string>;
  onSelect: (evidence: GraphEvidenceRef) => void;
  onUpdate: (concept: GraphConcept) => void;
}) {
  const [limit, setLimit] = useState(SOURCE_PAGE_SIZE);
  const members = concept.members.slice(0, limit);
  return <>
    <p className="graph-exploration-member-count" role="status">Showing {members.length} of {concept.members.length} references.</p>
    <ul className="graph-exploration-member-list">
      {members.map((member, index) => <li key={`${member.conversationId}-${member.sourceKind}-${member.messageId ?? member.noteId ?? index}-${member.startOffset ?? ""}-${member.endOffset ?? ""}`}>
        <button type="button" className="graph-exploration-member-source" onClick={() => onSelect(member)}>
          <span>{titles.get(member.conversationId) ?? (member.sourceKind === "standalone-note" ? "Note source" : "Chat source")}</span>
          {member.quote ? <span className="graph-exploration-member-quote">“{member.quote}”</span> : null}
        </button>
        <button type="button" className="graph-exploration-member-remove" aria-label={`Remove source ${index + 1} from ${concept.label}`}
          onClick={() => onUpdate({ ...concept, members: concept.members.filter((_member, memberIndex) => memberIndex !== index) })}>×</button>
      </li>)}
    </ul>
    {members.length < concept.members.length ? <button className="graph-exploration-show-more" type="button"
      onClick={() => setLimit((current) => current + SOURCE_PAGE_SIZE)}>
      Show {Math.min(SOURCE_PAGE_SIZE, concept.members.length - members.length)} more references
    </button> : null}
  </>;
}

export default function GraphExplorationPanel({
  overviewItems, sourceItems, concepts, scopeLabel, scopeKind, scopeKey, selectedConversationTitle, selectedConceptId,
  query, onQueryChange, onOpenOverviewItem, onSelectSource, onCreateConcept, onUpdateConcept,
  onDeleteConcept, onAddSelectionToConcept, onFocusSelection, onShowBranchSource,
}: GraphExplorationPanelProps) {
  const panelId = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [creatingConcept, setCreatingConcept] = useState(false);
  const [editingConceptId, setEditingConceptId] = useState<string | null>(null);
  const [deletingConceptId, setDeletingConceptId] = useState<string | null>(null);
  const [expandedConceptId, setExpandedConceptId] = useState<string | null | undefined>(undefined);
  const searching = Boolean(query.trim());
  const overviewVisible = scopeKind === "all" && !searching;
  const showSources = sourcesOpen || searching || !overviewVisible;
  const sourcePageKey = JSON.stringify([scopeKey ?? scopeKind, scopeLabel, selectedConceptId, query]);
  const sourceTitles = useMemo(() => new Map(sourceItems.map((item) => [item.evidence.conversationId, item.title])), [sourceItems]);
  useEffect(() => {
    // A new search or scope starts with its first result. Adding more results
    // and selecting a source leave the reader's current list position intact.
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [sourcePageKey]);

  function exploreConcept(concept: GraphConcept) {
    const item = overviewItems.find((candidate) => candidate.kind === "Concept" &&
      (candidate.id === concept.id || candidate.id === `concept:${concept.id}`));
    onOpenOverviewItem(item?.id ?? `concept:${concept.id}`);
  }

  return <aside className="graph-exploration-panel" aria-label="Explore the map" data-graph-ui="true">
    <header className="graph-exploration-heading">
      <span className="graph-exploration-eyebrow">Explore</span>
      <h2>{scopeLabel}</h2>
      <p>Follow a topic to its chats, notes, and source passages.</p>
    </header>

    <div className="graph-exploration-search">
      <label htmlFor={`${panelId}-search`}>Search this view</label>
      <div className="graph-exploration-search-field">
        <input id={`${panelId}-search`} type="search" value={query}
          onChange={(event) => onQueryChange(event.target.value)} placeholder="Find a title or passage…"
          aria-controls={`${panelId}-sources`} />
        {query ? <button type="button" onClick={() => onQueryChange("")} aria-label="Clear map search">×</button> : null}
      </div>
    </div>

    <div className="graph-exploration-content" ref={contentRef} tabIndex={0} role="region" aria-label="Map exploration lists">
      {selectedConversationTitle ? <section className="graph-exploration-selection" aria-label="Selected source">
      <span className="graph-exploration-eyebrow">Selected</span>
      <strong>{selectedConversationTitle}</strong>
      <div className="graph-exploration-actions">
        <button type="button" onClick={onFocusSelection}>Focus neighborhood</button>
        {onShowBranchSource ? <button type="button" onClick={onShowBranchSource}>Show branch source</button> : null}
      </div>
      </section> : null}
      {overviewVisible ? <section className="graph-exploration-section" aria-labelledby={`${panelId}-overview-heading`}>
        <div className="graph-exploration-section-heading"><h3 id={`${panelId}-overview-heading`}>Start with a topic</h3></div>
        {overviewItems.length ? <ul className="graph-exploration-overview-list">
          {overviewItems.map((item) => <li key={item.id}>
            <button className="graph-exploration-overview-item" type="button" onClick={() => onOpenOverviewItem(item.id)}>
              <span className="graph-exploration-item-meta"><span>{item.kind}</span><span>{item.count} {item.count === 1 ? "chat or note" : "chats and notes"}</span></span>
              <strong>{item.label}</strong>
              {item.description ? <span className="graph-exploration-description">{item.description}</span> : null}
              {item.examples.length ? <span className="graph-exploration-examples">{item.examples.slice(0, 2).join(" · ")}</span> : null}
              <span className="graph-exploration-explore-label">Explore <span aria-hidden="true">→</span></span>
            </button>
          </li>)}
        </ul> : <p className="graph-exploration-empty">Your chats and notes will appear here. Create a concept to connect sources around an idea.</p>}
      </section> : null}

      <section className="graph-exploration-section" aria-labelledby={`${panelId}-sources-heading`}>
        <div className="graph-exploration-section-heading">
          <h3 id={`${panelId}-sources-heading`}>{searching ? "Search results" : scopeKind === "concept" ? "Source references" : "Sources"} <span>{sourceItems.length}</span></h3>
          {overviewVisible ? <button type="button" className="graph-exploration-text-button" aria-expanded={showSources}
            aria-controls={`${panelId}-sources`} onClick={() => setSourcesOpen(!sourcesOpen)}>{showSources ? "Hide list" : "Show list"}</button> : null}
        </div>
        <div id={`${panelId}-sources`} hidden={!showSources}>
          {showSources ? <SourceResults key={sourcePageKey} items={sourceItems} searching={searching}
            scopeLabel={scopeLabel} conceptScope={scopeKind === "concept"} onSelect={onSelectSource} /> : null}
        </div>
      </section>

      <section className="graph-exploration-section graph-exploration-concepts" aria-labelledby={`${panelId}-concepts-heading`}>
        <div className="graph-exploration-section-heading">
          <h3 id={`${panelId}-concepts-heading`}>Your concepts <span>{concepts.length}</span></h3>
          <button type="button" className="graph-exploration-text-button" aria-expanded={creatingConcept}
            onClick={() => setCreatingConcept(!creatingConcept)}>{creatingConcept ? "Close" : "+ New"}</button>
        </div>
        <p className="graph-exploration-list-hint">Connect sources around your own ideas. Concepts are saved on this device.</p>
        {creatingConcept ? <ConceptForm creating onCancel={() => setCreatingConcept(false)} onSave={(label, description) => {
          onCreateConcept(label, description);
          setCreatingConcept(false);
        }} /> : null}
        {!concepts.length && !creatingConcept ? <p className="graph-exploration-empty">Create an idea such as “Privacy tradeoffs,” then add its supporting chats and notes.</p> : null}
        <ul className="graph-exploration-concept-list">
          {concepts.map((concept) => {
            const isExpanded = expandedConceptId === concept.id ||
              (expandedConceptId === undefined && selectedConceptId === concept.id);
            const isEditing = editingConceptId === concept.id;
            const isDeleting = deletingConceptId === concept.id;
            const membersId = `${panelId}-members-${encodeURIComponent(concept.id)}`;
            return <li key={concept.id} className={selectedConceptId === concept.id ? "is-current" : undefined}>
              <div className="graph-exploration-concept-heading">
                <button type="button" className="graph-exploration-concept-open" onClick={() => exploreConcept(concept)}
                  aria-current={selectedConceptId === concept.id ? "true" : undefined}>
                  <strong>{concept.label}</strong><span>{concept.members.length} {concept.members.length === 1 ? "reference" : "references"}</span>
                </button>
                <button type="button" className="graph-exploration-text-button" aria-label={`Edit ${concept.label}`}
                  aria-expanded={isEditing} onClick={() => { setEditingConceptId(isEditing ? null : concept.id); setDeletingConceptId(null); }}>Edit</button>
              </div>
              {!isEditing && concept.description ? <p className="graph-exploration-concept-description">{concept.description}</p> : null}
              {isEditing ? <ConceptForm key={concept.id} label={concept.label} description={concept.description}
                onCancel={() => setEditingConceptId(null)} onSave={(label, description) => {
                  onUpdateConcept({ ...concept, label, description }); setEditingConceptId(null);
                }} /> : null}
              <div className="graph-exploration-actions">
                <button type="button" disabled={!selectedConversationTitle} onClick={() => onAddSelectionToConcept(concept.id)}
                  title={selectedConversationTitle ? `Add ${selectedConversationTitle}` : "Select a chat or note on the map first"}>Add selected source</button>
                {concept.members.length ? <button type="button" aria-expanded={isExpanded} aria-controls={membersId}
                  onClick={() => setExpandedConceptId(isExpanded ? null : concept.id)}>
                  {isExpanded ? "Hide sources" : "View sources"}</button> : null}
              </div>
              <div id={membersId} hidden={!isExpanded}>
                {isExpanded ? <ConceptMembers key={`${concept.id}:${sourcePageKey}`} concept={concept} titles={sourceTitles}
                  onSelect={onSelectSource} onUpdate={onUpdateConcept} /> : null}
              </div>
              {isEditing || isDeleting ? <div className="graph-exploration-delete">
                {isDeleting ? <>
                  <p>Delete “{concept.label}”? Its chats and notes will be kept.</p>
                  <div className="graph-exploration-actions"><button type="button" onClick={() => {
                    onDeleteConcept(concept.id); setDeletingConceptId(null); setEditingConceptId(null);
                  }}>Delete concept</button><button type="button" onClick={() => setDeletingConceptId(null)}>Keep concept</button></div>
                </> : <button type="button" className="graph-exploration-text-button" onClick={() => setDeletingConceptId(concept.id)}>Delete concept…</button>}
              </div> : null}
            </li>;
          })}
        </ul>
      </section>
    </div>
  </aside>;
}
