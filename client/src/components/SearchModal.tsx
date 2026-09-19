import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { buildSearchExploration, type ChatSearchResult, type SearchEvidenceRef, type SearchFacet } from "../lib/conversationSearch";
import { applyJevSearchRanking, buildJevSearchSnapshot } from "../lib/jevSearch";
import { useJevSearch } from "../lib/useJevSearch";
import type { JevStatus } from "../lib/jevAssistance";
import { renderObsidianMarkdownToHtml } from "../lib/markdown";
import type { Conversation, ConversationGroup, ThreadCategoryId } from "../types";
import "./SearchModal.css";

export type { ChatSearchResult, SearchEvidenceRef } from "../lib/conversationSearch";
interface SearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  onQueryChange: (value: string) => void;
  onSelectResult: (conversationId: string) => void;
  query: string;
  results: ChatSearchResult[];
  conversations?: Record<string, Conversation>;
  currentConversation?: Conversation;
  groups?: Record<string, ConversationGroup>;
  categories?: Record<string, ThreadCategoryId>;
  jev?: { userId: string; enabled: boolean; ready: boolean; serviceStatus: JevStatus };
  onOpenSource?: (source: SearchEvidenceRef) => void;
}
type SearchView = "passages" | "connections";
type DisplayResult = ChatSearchResult & { id: string; facetIds: string[]; evidence?: SearchEvidenceRef; passage?: string; localOnly?: boolean };
interface SearchLocation { query: string; facetIds: string[]; contextual: boolean; view: SearchView; page: number; selectedId: string | null }
const PAGE_SIZE = 12;
const FACET_KINDS = ["topic", "group", "type", "purpose"] as const;
const FACET_LABELS = { topic: "Topic", group: "Group", type: "Type", purpose: "Purpose" };
function SearchIcon() { return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>; }
function highlightQuery(text: string, query: string): ReactNode {
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter((term) => term.length > 1).sort((a, b) => b.length - a.length);
  if (!terms.length) return text;
  return text.split(new RegExp(`(${terms.join("|")})`, "giu")).map((part, index) => terms.includes(part.toLowerCase()) ? <mark key={index}>{part}</mark> : part);
}
function sameLocation(left: SearchLocation, right: SearchLocation) { return JSON.stringify(left) === JSON.stringify(right); }

export default function SearchModal({ isOpen, onClose, onQueryChange, onSelectResult, query, results, conversations, currentConversation, groups, categories, jev, onOpenSource }: SearchModalProps) {
  const [facetIds, setFacetIds] = useState<string[]>([]);
  const [contextual, setContextual] = useState(false);
  const [view, setView] = useState<SearchView>("passages");
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [history, setHistory] = useState<SearchLocation[]>([]);
  const [expandedFacetKinds, setExpandedFacetKinds] = useState<string[]>([]);
  const [filtersOpen, setFiltersOpen] = useState(() => typeof window === "undefined" || window.innerWidth > 680);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const resultHeadingRef = useRef<HTMLHeadingElement>(null);
  const queryStartRef = useRef<SearchLocation | null>(null);
  const frozenRankingRef = useRef<{ key: string; scores: Record<string, number> }>({ key: "", scores: {} });
  const closeRef = useRef(onClose);
  const id = useId();
  closeRef.current = onClose;
  const exploration = useMemo(() => isOpen && conversations ? buildSearchExploration({ conversations, groups, categories, query, activeFacetIds: facetIds, currentConversationId: currentConversation?.id, contextual }) : null, [isOpen, conversations, groups, categories, query, facetIds, currentConversation?.id, contextual]);
  const jevSnapshot = useMemo(() => isOpen && jev?.enabled && jev.ready && exploration && conversations ? buildJevSearchSnapshot({ conversations, query, results: exploration.results, facets: exploration.facets, currentConversationId: contextual ? currentConversation?.id : undefined }) : null, [isOpen, jev?.enabled, jev?.ready, exploration, conversations, query, contextual, currentConversation?.id]);
  const assistance = useJevSearch({ userId: jev?.userId ?? "", enabled: jev?.enabled ?? false, ready: jev?.ready ?? false, active: isOpen, serviceStatus: jev?.serviceStatus ?? "off", snapshot: jevSnapshot });
  const rankingKey = JSON.stringify([query, facetIds, contextual, contextual ? currentConversation?.id : null]);
  // A late judgment must not move a passage while someone is reading it.
  if (!exploration?.results.some((result) => result.id === selectedId) || frozenRankingRef.current.key !== rankingKey) frozenRankingRef.current = { key: rankingKey, scores: assistance.scores };
  const entries: DisplayResult[] = exploration ? applyJevSearchRanking(exploration.results, frozenRankingRef.current.scores) : isOpen ? results.map((result, index) => ({ ...result, id: `legacy-${result.conversationId}-${index}`, facetIds: [] })) : [];
  const facets = exploration?.facets ?? [];
  const selectedFacets = facets.filter((facet) => facetIds.includes(facet.id));
  const total = exploration?.totalCount ?? entries.length;
  const pageCount = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const visiblePage = Math.min(page, pageCount - 1);
  const pageEntries = entries.slice(visiblePage * PAGE_SIZE, (visiblePage + 1) * PAGE_SIZE);
  const selected = pageEntries.find((entry) => entry.id === selectedId) ?? null;
  const topicFacets = facets.filter((facet) => facet.kind === "topic" && facet.count > 0);
  const neighborhoods = topicFacets.length ? topicFacets : facets.filter((facet) => facet.kind === "group" && facet.count > 0);

  function location(): SearchLocation { return { query, facetIds: [...facetIds], contextual, view, page: visiblePage, selectedId }; }
  function remember(previous: SearchLocation) { setHistory((current) => current.length && sameLocation(current[current.length - 1], previous) ? current : [...current.slice(-29), previous]); }
  function commitQuery() { const previous = queryStartRef.current; queryStartRef.current = null; if (previous && previous.query !== query) remember(previous); }
  function navigate(next: Partial<SearchLocation>) {
    commitQuery();
    const previous = location(), destination = { ...previous, ...next };
    if (sameLocation(previous, destination)) return;
    remember(previous); setFacetIds(destination.facetIds); setContextual(destination.contextual); setView(destination.view); setPage(destination.page); setSelectedId(destination.selectedId);
    if (destination.query !== query) onQueryChange(destination.query);
  }
  function goBack() {
    const pending = queryStartRef.current; queryStartRef.current = null;
    const previous = pending && pending.query !== query ? pending : history.at(-1);
    if (!previous) return;
    if (previous !== pending) setHistory((current) => current.slice(0, -1));
    setFacetIds(previous.facetIds); setContextual(previous.contextual); setView(previous.view); setPage(previous.page); setSelectedId(previous.selectedId); onQueryChange(previous.query);
  }
  function chooseTopic(facet: SearchFacet) { navigate({ facetIds: [...facetIds.filter((item) => !item.startsWith(`${facet.kind}:`)), facet.id], view: "passages", page: 0, selectedId: null }); }
  function toggleFacet(facet: SearchFacet) { navigate({ facetIds: facetIds.includes(facet.id) ? facetIds.filter((item) => item !== facet.id) : [...facetIds, facet.id], page: 0, selectedId: null }); }
  function openSource(result: DisplayResult) {
    if (result.evidence && onOpenSource) { onOpenSource(result.evidence); onClose(); }
    else onSelectResult(result.conversationId);
  }
  useEffect(() => {
    if (!isOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden"; inputRef.current?.focus();
    return () => { document.body.style.overflow = previousOverflow; if (previousFocus?.isConnected) previousFocus.focus(); };
  }, [isOpen]);
  if (!isOpen) return null;
  const modal = <div className="search-modal-backdrop search-explore-backdrop" role="presentation" onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }}>
    <section aria-labelledby={`${id}-title`} aria-modal="true" className="search-modal search-explore" ref={dialogRef} role="dialog" onKeyDown={(event) => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); closeRef.current(); return; }
      if (event.key !== "Tab") return;
      const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]') ?? []).filter((element) => {
        if (element.tabIndex < 0 || element.closest('[hidden], [inert], fieldset:disabled')) return false;
        for (let parent: HTMLElement | null = element; parent && parent !== dialogRef.current; parent = parent.parentElement) if (getComputedStyle(parent).display === "none" || getComputedStyle(parent).visibility === "hidden") return false;
        return true;
      });
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    }}>
      <header className="search-explore-header"><div><h2 id={`${id}-title`}>Search &amp; explore</h2><p>Find a passage. Follow a connection. Pick up a thought.</p></div><button aria-label="Close search" className="search-explore-close" onClick={onClose} type="button"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header>
      <form className="search-explore-query" onSubmit={(event) => { event.preventDefault(); event.stopPropagation(); commitQuery(); resultHeadingRef.current?.focus(); }}>
        <label className="search-explore-input-shell"><SearchIcon/><span className="search-visually-hidden">Search titles, messages, and notes</span><input ref={inputRef} onBlur={commitQuery} onChange={(event) => { queryStartRef.current ??= location(); onQueryChange(event.target.value); setPage(0); setSelectedId(null); }} placeholder="Search an idea, phrase, or question…" type="search" value={query}/></label>
        {currentConversation && conversations ? <label className="search-context-toggle" title={`Give passages near “${currentConversation.title}” more weight while keeping the whole workspace searchable.`}><input checked={contextual} onChange={(event) => navigate({ contextual: event.target.checked, page: 0, selectedId: null })} type="checkbox"/><span>Use current chat<small>{currentConversation.title}</small></span></label> : null}
      </form>
      <div className="search-explore-toolbar"><button aria-label="Back in search" className="search-back-button" disabled={!history.length && !queryStartRef.current} onClick={goBack} type="button"><span aria-hidden="true">←</span> Back</button><div aria-label="Search views" className="search-view-tabs" role="tablist">{(["passages", "connections"] as const).map((candidate) => <button aria-controls={`${id}-content`} aria-selected={view === candidate} id={`${id}-${candidate}`} key={candidate} role="tab" tabIndex={view === candidate ? 0 : -1} onClick={() => navigate({ view: candidate })} onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return; event.preventDefault();
        const next = event.key === "Home" ? "passages" : event.key === "End" ? "connections" : view === "passages" ? "connections" : "passages";
        navigate({ view: next }); document.getElementById(`${id}-${next}`)?.focus();
      }} type="button">{candidate === "passages" ? "Passages" : "Connections"}</button>)}</div>{exploration ? <button aria-controls={`${id}-filters`} aria-expanded={filtersOpen} className={`search-filter-toggle${facetIds.length ? " has-filters" : ""}`} onClick={() => setFiltersOpen((value) => !value)} type="button">Filters{facetIds.length ? ` · ${facetIds.length}` : ""}<span aria-hidden="true">{filtersOpen ? "−" : "+"}</span></button> : null}</div>
      <div className="search-explore-scroll">
        {exploration && filtersOpen ? <section aria-label="Temporary search filters" className="search-explore-filters" id={`${id}-filters`}><div className="search-filter-heading"><p>Counts include all matching passages. Your groups stay unchanged.</p><button disabled={!facetIds.length} onClick={() => navigate({ facetIds: [], page: 0, selectedId: null })} type="button">Clear filters</button></div>{FACET_KINDS.map((kind) => {
          const options = facets.filter((facet) => facet.kind === kind); if (!options.length) return null;
          const shown = expandedFacetKinds.includes(kind) ? options : options.filter((facet, index) => index < 7 || facetIds.includes(facet.id));
          return <fieldset className="search-facet-row" key={kind}><legend>{FACET_LABELS[kind]}</legend><div>{shown.map((facet) => <button aria-pressed={facetIds.includes(facet.id)} className="search-facet-chip" disabled={!facet.count && !facetIds.includes(facet.id)} key={facet.id} onClick={() => toggleFacet(facet)} type="button"><span>{facet.label}</span>{assistance.suggestedFacetIds.includes(facet.id) ? <span className="search-facet-suggestion">Jev suggests</span> : null}<span className="search-facet-count">{facet.count}</span></button>)}{options.length > 7 ? <button className="search-facet-more" onClick={() => setExpandedFacetKinds((current) => current.includes(kind) ? current.filter((item) => item !== kind) : [...current, kind])} type="button">{expandedFacetKinds.includes(kind) ? "Show fewer" : `+${options.length - shown.length} more`}</button> : null}</div></fieldset>;
        })}</section> : null}
        {!filtersOpen && selectedFacets.length ? <div aria-label="Active search filters" className="search-active-filters">{selectedFacets.map((facet) => <button key={facet.id} onClick={() => toggleFacet(facet)} type="button" aria-label={`Remove ${facet.label} filter`}>{facet.label}<span aria-hidden="true">×</span></button>)}<button onClick={() => navigate({ facetIds: [], page: 0, selectedId: null })} type="button">Clear all</button></div> : null}
        {exploration?.directions.length ? <section aria-label="Directions to explore" className="search-directions"><div className="search-section-heading"><h3>A few ways in</h3><span>From passages in your workspace</span></div><div>{exploration.directions.slice(0, 3).map((direction) => <button className="search-direction-card" key={direction.id} onClick={() => navigate({ facetIds: direction.facetIds, view: "passages", page: 0, selectedId: null })} type="button"><span className="search-direction-count">{direction.count} {direction.count === 1 ? "passage" : "passages"}<span aria-hidden="true">↗</span></span><strong>{direction.label}</strong><span>{direction.description}</span></button>)}</div></section> : null}
        <section aria-labelledby={`${id}-${view}`} className="search-explore-content" id={`${id}-content`} role="tabpanel"><div className="search-section-heading search-result-heading"><h3 ref={resultHeadingRef} tabIndex={-1}>{view === "passages" ? `${total} ${total === 1 ? "passage" : "passages"}` : "Explore nearby topics"}</h3><span role="status">{contextual ? "Current chat given more weight" : query.trim() ? "Across your workspace" : "Start with a phrase or explore below"}</span></div>
          {!entries.length ? <div className="search-explore-empty"><SearchIcon/><h3>{exploration?.workspaceCount === 0 ? "Your workspace is ready for ideas" : "No passages match this search"}</h3><p>{exploration?.workspaceCount === 0 ? "Add a chat or note, then find and connect its ideas here." : facetIds.length ? "Remove a filter or try a broader phrase." : "Try a shorter phrase or a different word from the passage."}</p>{facetIds.length ? <button onClick={() => navigate({ facetIds: [], page: 0, selectedId: null })} type="button">Clear filters</button> : query.trim() ? <button onClick={() => navigate({ query: "", page: 0, selectedId: null })} type="button">Explore all passages</button> : null}</div> : view === "connections" ? <div className="search-connections"><div className="search-connections-center"><span>Your starting point</span><strong>{query.trim() || (contextual ? currentConversation?.title : "Your workspace")}</strong><span>{total} passages · {exploration?.matchedConversationIds.length ?? new Set(entries.map((entry) => entry.conversationId)).size} sources</span></div><p>Follow a shared topic to its passages. Connections describe shared topics, not agreement between sources.</p>{neighborhoods.length ? <div className="search-topic-neighborhood" aria-label="Topics connected to this search">{neighborhoods.map((facet) => {
            const titles = [...new Set(entries.filter((entry) => entry.facetIds.includes(facet.id)).map((entry) => entry.title))].slice(0, 2);
            return <button className="search-topic-node" key={facet.id} onClick={() => chooseTopic(facet)} type="button"><span><strong>{facet.label}</strong><span className="search-topic-count">{facet.count}</span></span><span>{titles.length ? titles.join(" · ") : "Explore matching passages"}</span><span className="search-topic-action">View passages <span aria-hidden="true">→</span></span></button>;
          })}</div> : <div className="search-connections-fallback"><p>These passages do not have a shared topic yet.</p><button onClick={() => navigate({ view: "passages" })} type="button">View matching passages</button></div>}</div> : <><div className="search-passage-list">{pageEntries.map((result) => {
            const expanded = selected?.id === result.id, passage = result.passage ?? result.evidence?.quote ?? result.preview;
            return <article className={`search-passage-card${expanded ? " is-selected" : ""}`} data-search-result={result.id} key={result.id}><button aria-expanded={expanded} aria-controls={expanded ? `${id}-passage-detail` : undefined} className="search-passage-select" onClick={() => setSelectedId(expanded ? null : result.id)} type="button"><span className="search-passage-meta"><span>{result.matchLabel}</span>{result.localOnly ? <span className="search-passage-private">Private note</span> : null}<time>{result.updatedLabel}</time></span><strong>{highlightQuery(result.title, query)}</strong>{!expanded ? <span className="search-passage-excerpt">{highlightQuery(result.preview, query)}</span> : null}<span className="search-passage-location">{result.rootTitle !== result.title ? `${result.rootTitle} / ` : ""}{result.locationLabel}<span aria-hidden="true">{expanded ? "−" : "+"}</span></span></button>{expanded ? <div className="search-passage-detail" id={`${id}-passage-detail`}><span className="search-passage-detail-label">{result.evidence?.sourceKind === "conversation" ? "Title match" : "Source passage"}</span><blockquote>{typeof window === "undefined" ? passage : <div className="search-passage-markdown" dangerouslySetInnerHTML={{ __html: renderObsidianMarkdownToHtml(passage) }} />}</blockquote><div className="search-passage-actions"><span>{result.localOnly ? "Only included in AI context when you choose to share it." : "Read this passage in its original context."}</span><button className="search-open-source" onClick={() => openSource(result)} type="button">Open source <span aria-hidden="true">↗</span></button></div></div> : null}</article>;
          })}</div><nav aria-label="Search result pages" className="search-pagination"><span>{visiblePage * PAGE_SIZE + 1}–{Math.min((visiblePage + 1) * PAGE_SIZE, entries.length)} of {total}</span><div><button disabled={visiblePage === 0} onClick={() => { navigate({ page: visiblePage - 1, selectedId: null }); resultHeadingRef.current?.focus(); }} type="button">Previous</button><span>Page {visiblePage + 1} of {pageCount}</span><button disabled={visiblePage + 1 >= pageCount} onClick={() => { navigate({ page: visiblePage + 1, selectedId: null }); resultHeadingRef.current?.focus(); }} type="button">Next</button></div></nav></>}
        </section>
      </div>
      <footer className="search-explore-footer"><span>Filters apply only to this search.</span>{jev?.enabled && jevSnapshot ? <span className="search-jev-status" role="status">{assistance.status === "loading" || assistance.status === "checking" ? "Jev is refining relevance…" : assistance.status === "ready" && assistance.analyzedCount ? `Jev reviewed ${assistance.analyzedCount} passages` : assistance.status === "unavailable" || assistance.status === "unconfigured" ? "Jev unavailable · local results shown" : "Local results shown"}</span> : null}<span><kbd>Esc</kbd> close</span></footer>
    </section>
  </div>;
  return typeof document !== "undefined" ? createPortal(modal, document.body) : modal;
}
