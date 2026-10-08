import { useDeferredValue, useEffect, useState, type MouseEvent } from "react";
import type { VaultSearchDocumentHit, VaultSearchPassageHit, VaultSearchProvider, VaultSearchResults, VaultSearchScope } from "../lib/vaultSearch";
import { highlight, meta, type VaultSearchOpenMode } from "./VaultSearchPalette";
import "./SearchResultsPanel.css";

type Hit = { kind: "document"; hit: VaultSearchDocumentHit } | { kind: "passage"; hit: VaultSearchPassageHit };
type Grouping = "family" | "passage";

const SCOPE_LABELS: Record<VaultSearchScope, string> = { all: "Anywhere", family: "This family", documents: "Documents", notes: "Notes", recent: "Last 12 months" };
const PAGE = 40;

const yearOf = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).getFullYear() : null;
const familyOf = (hit: Hit) => hit.hit.familyTitle ?? hit.hit.title;

/** Results that stay open while you read: grouped by family, narrowed by year, opened beside. */
export default function SearchResultsPanel({ initialQuery, initialScope, provider, currentConversationId, openingPath, onOpenDocument, onOpenPassage, onClose }: {
  initialQuery: string;
  initialScope: VaultSearchScope;
  provider: VaultSearchProvider;
  currentConversationId?: string;
  openingPath?: string | null;
  onOpenDocument: (hit: VaultSearchDocumentHit, mode: VaultSearchOpenMode) => void;
  onOpenPassage: (hit: VaultSearchPassageHit, mode: VaultSearchOpenMode) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [scope, setScope] = useState(initialScope);
  const [year, setYear] = useState<number | null>(null);
  const [grouping, setGrouping] = useState<Grouping>("family");
  const [limit, setLimit] = useState(PAGE);
  const [openedKey, setOpenedKey] = useState<string | null>(null);
  const [results, setResults] = useState<VaultSearchResults | null>(null);
  const deferredQuery = useDeferredValue(query);

  useEffect(() => { setQuery(initialQuery); setScope(initialScope); setYear(null); }, [initialQuery, initialScope]);
  useEffect(() => provider.search({ query: deferredQuery, scope, currentConversationId }, setResults), [provider, deferredQuery, scope, currentConversationId]);
  useEffect(() => { setLimit(PAGE); }, [deferredQuery, scope, year, grouping]);

  const searching = !!deferredQuery.trim();
  const all: Hit[] = searching && results ? [
    ...results.documents.map((hit) => ({ kind: "document" as const, hit })),
    ...results.passages.map((hit) => ({ kind: "passage" as const, hit })),
  ] : [];
  const counts = new Map<number, number>();
  for (const item of all) { const value = yearOf(item.hit.updatedAt); if (value !== null) counts.set(value, (counts.get(value) ?? 0) + 1); }
  const years = [...counts.keys()].sort((left, right) => left - right);
  const tallest = Math.max(1, ...counts.values());
  const shown = year === null ? all : all.filter((item) => yearOf(item.hit.updatedAt) === year);
  const visible = shown.slice(0, limit);
  const groups: Array<{ name: string; items: Hit[] }> = [];
  if (grouping === "family") {
    const byName = new Map<string, Hit[]>();
    for (const item of visible) { const name = familyOf(item); byName.set(name, [...byName.get(name) ?? [], item]); }
    groups.push(...[...byName].map(([name, items]) => ({ name, items })));
  } else {
    groups.push({ name: "", items: [...visible].sort((left, right) => (right.hit.updatedAt ?? "").localeCompare(left.hit.updatedAt ?? "")) });
  }
  const documentCount = new Set(shown.map((item) => item.kind === "passage" ? item.hit.conversationId
    : item.hit.target.kind === "loaded" ? item.hit.target.conversationId : item.hit.target.path)).size;

  function open(item: Hit, event: MouseEvent) {
    const mode: VaultSearchOpenMode = event.metaKey || event.ctrlKey ? "here" : "beside";
    setOpenedKey(item.hit.key);
    if (item.kind === "document") onOpenDocument(item.hit, mode);
    else onOpenPassage(item.hit, mode);
  }

  return <aside aria-label={`Search results for ${query}`} className="search-results-panel">
    <header className="search-results-header">
      <label className="search-results-input">
        <span className="vault-search-hidden">Search your vault</span>
        <input onChange={(event) => setQuery(event.target.value)} placeholder="Search your vault…" type="search" value={query}/>
      </label>
      <button aria-label="Close search results" className="search-results-close" onClick={onClose} type="button">
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>
      </button>
    </header>
    <div className="search-results-controls">
      <div aria-label="Narrow the search" className="search-results-scopes" role="group">
        {(Object.keys(SCOPE_LABELS) as VaultSearchScope[]).map((option) => <button aria-pressed={scope === option} key={option} onClick={() => setScope(option)} type="button">{SCOPE_LABELS[option]}</button>)}
      </div>
      {years.length > 1 ? <div aria-label="Filter by year" className="search-results-years" role="group">
        {years.map((value) => <button aria-pressed={year === value} className={year === null || year === value ? "is-in" : ""} key={value}
          onClick={() => setYear((current) => current === value ? null : value)} title={`${counts.get(value)} results from ${value}`} type="button">
          <span aria-hidden="true" className="search-results-year-bar" style={{ height: `${Math.max(3, Math.round(32 * (counts.get(value) ?? 0) / tallest))}px` }}/>
          {value}
        </button>)}
      </div> : null}
      <div className="search-results-summary">
        <span role="status">{!searching ? "Type to search your vault." : `${shown.length} ${shown.length === 1 ? "result" : "results"} in ${documentCount} ${documentCount === 1 ? "document" : "documents"}${year ? ` from ${year}` : ""}`}</span>
        <div aria-label="Group results" className="search-results-grouping" role="group">
          <button aria-pressed={grouping === "family"} onClick={() => setGrouping("family")} type="button">By family</button>
          <button aria-pressed={grouping === "passage"} onClick={() => setGrouping("passage")} type="button">Newest</button>
        </div>
      </div>
    </div>
    <div className="search-results-list">
      {groups.map((group) => <section aria-label={group.name || "Results"} key={group.name || "all"}>
        {group.name ? <h3 className="search-results-family">{group.name}</h3> : null}
        <ul>
          {group.items.map((item) => {
            const cloudPath = item.kind === "document" && item.hit.target.kind === "cloud" ? item.hit.target.path : null;
            return <li key={item.hit.key}>
              <button aria-current={openedKey === item.hit.key ? "true" : undefined} className={`search-results-row${openedKey === item.hit.key ? " is-open" : ""}`}
                disabled={!!cloudPath && openingPath === cloudPath} onClick={(event) => open(item, event)} title="Open beside (⌘-click to open here)" type="button">
                <span className="vault-search-row-title">{item.kind === "document" ? highlight(item.hit.title, deferredQuery) : item.hit.title}
                  {cloudPath ? <span className="vault-search-cloud">{openingPath === cloudPath ? "Opening…" : "In cloud"}</span> : null}</span>
                <span className="vault-search-meta">{item.kind === "passage" ? item.hit.matchLabel : "Title"} · {meta(grouping === "family" ? { ...item.hit, familyTitle: undefined } : item.hit)}</span>
                {item.kind === "passage" ? <span className="vault-search-snippet">{highlight(item.hit.preview, deferredQuery)}</span> : null}
              </button>
            </li>;
          })}
        </ul>
      </section>)}
      {shown.length > visible.length ? <button className="vault-search-more" onClick={() => setLimit((current) => current + PAGE)} type="button">Show {Math.min(PAGE, shown.length - visible.length)} more</button> : null}
      {searching && results && !shown.length ? <p className="vault-search-empty">Nothing matches{year ? ` from ${year}` : ""}. {year ? "Pick another year." : scope === "all" ? "Try a shorter word." : "Try Anywhere."}</p> : null}
    </div>
  </aside>;
}
