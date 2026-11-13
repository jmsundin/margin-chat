import { useDeferredValue, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { getCurrentDocumentText } from "../lib/documentSources";
import {
  vaultSearchTerms, type VaultSearchDocumentHit, type VaultSearchPassageHit, type VaultSearchProvider,
  type VaultSearchResults, type VaultSearchScope,
} from "../lib/vaultSearch";
import { spotlightFromSearch } from "../lib/mapSpotlight";
import { prepareSearchSources } from "../lib/searchExploration";
import type { Conversation } from "../types";
import MarkdownLivePreview from "./MarkdownLivePreview";
import "./VaultSearchPalette.css";

export type VaultSearchOpenMode = "here" | "beside";
type Entry = { kind: "document"; hit: VaultSearchDocumentHit } | { kind: "passage"; hit: VaultSearchPassageHit } | { kind: "answer"; hit: { key: string } };
const ANSWER_ENTRY: Entry = { kind: "answer", hit: { key: "answer:vault" } };

const PASSAGE_PAGE = 30;
const TYPING_PAUSE_MS = 120;
const SCOPES: Array<{ id: VaultSearchScope; label: string }> = [
  { id: "all", label: "Anywhere" },
  { id: "family", label: "This family" },
  { id: "documents", label: "Documents" },
  { id: "notes", label: "Notes" },
  { id: "recent", label: "Last 12 months" },
];

function SearchIcon() { return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>; }

export function highlight(text: string, query: string): ReactNode {
  const terms = [...new Set(vaultSearchTerms(query))].filter((term) => term.length > 1).sort((a, b) => b.length - a.length);
  if (!terms.length) return text;
  const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return text.split(new RegExp(`(${escaped.join("|")})`, "giu")).map((part, index) => terms.includes(part.toLocaleLowerCase()) ? <mark key={index}>{part}</mark> : part);
}

function dateLabel(value?: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return "";
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function meta(hit: { kindLabel: string; familyTitle?: string; updatedAt?: string }) {
  return [hit.kindLabel, hit.familyTitle, dateLabel(hit.updatedAt)].filter(Boolean).join(" · ");
}

function documentPreview(conversation: Conversation | undefined) {
  if (!conversation) return "";
  const text = conversation.document ? getCurrentDocumentText(conversation) : conversation.messages.at(-1)?.content ?? "";
  return text.trim() ? text : "";
}

const entryKey = (entry: Entry) => entry.hit.key;
/** Where a result still in the cloud downloads from before it opens. */
export const cloudPathOf = (entry: Entry) => entry.kind === "document"
  ? entry.hit.target.kind === "cloud" ? entry.hit.target.path : null
  : entry.kind === "passage" ? entry.hit.cloudPath ?? null : null;
const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Cmd+K: one box over the whole vault. Titles first, then passages; Enter opens here, Cmd+Enter beside. */
export default function VaultSearchPalette({ isOpen, onClose: closePalette, query: savedQuery, onQueryChange, provider, conversations, currentConversationId, currentFamilyTitle, openingPath, onOpenDocument, onOpenPassage, onExplore, onKeepOpen, onAnswer, onShowOnMap }: {
  isOpen: boolean;
  onClose: () => void;
  query: string;
  onQueryChange: (value: string) => void;
  provider: VaultSearchProvider;
  conversations: Record<string, Conversation>;
  currentConversationId?: string;
  currentFamilyTitle?: string;
  openingPath?: string | null;
  onOpenDocument: (hit: VaultSearchDocumentHit, mode: VaultSearchOpenMode) => void;
  onOpenPassage: (hit: VaultSearchPassageHit, mode: VaultSearchOpenMode) => void;
  /** Opens the filters-and-connections view with the same query. */
  onExplore?: () => void;
  /** Keeps these results open beside the documents. */
  onKeepOpen?: (query: string, scope: VaultSearchScope) => void;
  /** Answers the search from passages of the vault, citing them. */
  onAnswer?: (question: string) => void;
  /** Lights what was found on the Map, brightest the strongest match. */
  onShowOnMap?: (query: string, scores: Record<string, number>) => void;
}) {
  // What is typed stays here, so a keystroke redraws only the search box and not
  // the whole workspace; the workspace hears the query when search closes or hands off.
  const [query, setQuery] = useState(savedQuery);
  const [shownSavedQuery, setShownSavedQuery] = useState(savedQuery);
  if (savedQuery !== shownSavedQuery) { setShownSavedQuery(savedQuery); setQuery(savedQuery); }
  const keepQuery = () => { if (query !== savedQuery) onQueryChange(query); };
  const onClose = () => { keepQuery(); closePalette(); };
  const [scope, setScope] = useState<VaultSearchScope>("all");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [passageLimit, setPassageLimit] = useState(PASSAGE_PAGE);
  const [documentLimit, setDocumentLimit] = useState(PASSAGE_PAGE);
  const [results, setResults] = useState<VaultSearchResults | null>(null);
  const deferredQuery = useDeferredValue(query);
  // Each keystroke would otherwise search the vault again; a short pause lets fast typing finish first.
  const [searchedQuery, setSearchedQuery] = useState(query);
  useEffect(() => {
    if (deferredQuery === searchedQuery) return;
    // Clearing the box or the first letter answer at once.
    if (!deferredQuery.trim() || !searchedQuery.trim()) { setSearchedQuery(deferredQuery); return; }
    const timer = setTimeout(() => setSearchedQuery(deferredQuery), TYPING_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [deferredQuery, searchedQuery]);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const mod = isMac() ? "⌘" : "Ctrl";

  useEffect(() => {
    if (!isOpen) return;
    return provider.search({ query: searchedQuery, scope, currentConversationId }, setResults);
  }, [isOpen, provider, searchedQuery, scope, currentConversationId]);
  useEffect(() => { setPassageLimit(PASSAGE_PAGE); setDocumentLimit(PASSAGE_PAGE); setSelectedKey(null); }, [searchedQuery, scope]);
  // Reads the vault's documents while the box waits for the first letter, in short idle slices.
  useEffect(() => {
    if (!isOpen) return;
    let handle = 0;
    const idle = typeof window.requestIdleCallback === "function";
    const step = (deadline?: IdleDeadline) => {
      const until = performance.now() + 8;
      const done = prepareSearchSources(conversations, () => deadline && !deadline.didTimeout ? deadline.timeRemaining() > 2 : performance.now() < until);
      if (!done) handle = idle ? window.requestIdleCallback(step, { timeout: 500 }) : window.setTimeout(step, 16);
    };
    handle = idle ? window.requestIdleCallback(step, { timeout: 500 }) : window.setTimeout(step, 16);
    return () => { if (idle) window.cancelIdleCallback(handle); else window.clearTimeout(handle); };
  }, [isOpen, conversations]);
  useEffect(() => {
    if (!isOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    inputRef.current?.focus();
    inputRef.current?.select();
    return () => { document.body.style.overflow = previousOverflow; if (previousFocus?.isConnected) previousFocus.focus(); };
  }, [isOpen]);

  const searching = !!query.trim();
  const documents = results?.documents ?? [];
  const passages = results?.passages ?? [];
  const related = searching ? results?.related ?? [] : [];
  const found = searching ? results?.found ?? null : null;
  const foundEntries = found?.hits ?? [];
  const canAnswer = !!onAnswer && query.trim().length >= 3;
  // A question puts the answer first; otherwise it follows what was found.
  const answerFirst = canAnswer && (found?.question ?? /\?\s*$/u.test(query));
  const shownPassages = passages.slice(0, passageLimit);
  // A one-letter search can match thousands of titles; drawing them all would stall typing.
  const shownDocuments = documents.slice(0, documentLimit);
  const entries: Entry[] = [
    ...(answerFirst ? [ANSWER_ENTRY] : []),
    ...foundEntries,
    ...(canAnswer && !answerFirst ? [ANSWER_ENTRY] : []),
    ...shownDocuments.map((hit) => ({ kind: "document" as const, hit })),
    ...related.map((hit) => ({ kind: "passage" as const, hit })),
    ...shownPassages.map((hit) => ({ kind: "passage" as const, hit })),
  ];
  const selected = entries.find((entry) => entryKey(entry) === selectedKey) ?? entries[0] ?? null;
  const selectedIndex = selected ? entries.indexOf(selected) : -1;
  const highlightTerms = vaultSearchTerms(searchedQuery);
  const stale = searchedQuery !== query || (results !== null && results.query !== searchedQuery);

  const selectedEntryKey = selected ? entryKey(selected) : null;
  useEffect(() => {
    if (!selectedEntryKey) return;
    [...listRef.current?.querySelectorAll<HTMLElement>("[data-search-key]") ?? []]
      .find((element) => element.dataset.searchKey === selectedEntryKey)?.scrollIntoView?.({ block: "nearest" });
  }, [selectedEntryKey]);

  if (!isOpen) return null;

  function open(entry: Entry, mode: VaultSearchOpenMode) {
    if (entry.kind === "answer") { onAnswer?.(query.trim()); return; }
    if (entry.kind === "document") onOpenDocument(entry.hit, mode);
    else onOpenPassage(entry.hit, mode);
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!entries.length) return;
      event.preventDefault();
      const next = event.key === "ArrowDown" ? Math.min(selectedIndex + 1, entries.length - 1) : Math.max(selectedIndex - 1, 0);
      setSelectedKey(entryKey(entries[next]));
      return;
    }
    if (event.key === "Enter" && event.shiftKey && onKeepOpen && query.trim()) {
      event.preventDefault();
      keepQuery();
      onKeepOpen(query, scope);
      return;
    }
    if (event.key === "Enter" && selected && (event.target === inputRef.current || (event.target as HTMLElement).dataset.searchKey)) {
      event.preventDefault();
      open(selected, event.metaKey || event.ctrlKey ? "beside" : "here");
      return;
    }
    if (event.key !== "Tab") return;
    const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input") ?? []).filter((element) => element.tabIndex >= 0);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }

  const row = (entry: Entry, content: ReactNode) => {
    const key = entryKey(entry);
    const isSelected = key === selectedEntryKey;
    const cloudPath = cloudPathOf(entry);
    return <li key={key}>
      <button aria-selected={isSelected} className={`vault-search-row${isSelected ? " is-selected" : ""}`} data-search-key={key} id={`${id}-${key}`}
        disabled={!!cloudPath && openingPath === cloudPath} onClick={(event) => open(entry, event.metaKey || event.ctrlKey ? "beside" : "here")}
        onMouseMove={() => { if (!isSelected) setSelectedKey(key); }} role="option" tabIndex={-1} type="button">{content}</button>
    </li>;
  };

  const preview = (() => {
    if (!selected) return null;
    if (selected.kind === "answer") {
      return <>
        <p className="vault-search-preview-crumb">Answer from my vault</p>
        <h3>{query.trim()}</h3>
        <p className="vault-search-preview-text">AI writes a short answer using only passages from your vault, and lists the documents it cites. Nothing is saved unless you save it. Uses your AI allowance, like Ask AI.</p>
      </>;
    }
    if (selected.kind === "passage") {
      const hit = selected.hit;
      return <>
        <p className="vault-search-preview-crumb">{hit.familyTitle ? `${hit.familyTitle} › ` : ""}{hit.title}</p>
        <h3>{hit.title}</h3>
        <p className="vault-search-meta">{hit.matchLabel} · {meta(hit)}</p>
        <MarkdownLivePreview className="vault-search-preview-passage" highlightTerms={highlightTerms} source={hit.passage}/>
        {hit.localOnly ? <p className="vault-search-meta">Private note. Only shared with AI when you choose to.</p> : null}
        {hit.cloudPath ? <p className="vault-search-preview-text">This document is still in your cloud vault. Opening it downloads it to this device.</p> : null}
      </>;
    }
    const hit = selected.hit;
    const cloud = hit.target.kind === "cloud";
    const text = hit.target.kind === "loaded" ? documentPreview(conversations[hit.target.conversationId]) : "";
    return <>
      <p className="vault-search-preview-crumb">{hit.familyTitle ? `${hit.familyTitle} › ` : ""}{hit.title}</p>
      <h3>{highlight(hit.title, searchedQuery)}</h3>
      <p className="vault-search-meta">{[hit.why, meta(hit)].filter(Boolean).join(" · ")}</p>
      {hit.hiddenFromAI ? <p className="vault-search-meta">Hidden from AI. Found by its title; AI never reads it.</p> : null}
      {cloud ? <p className="vault-search-preview-text">This document is still in your cloud vault. Opening it downloads it to this device.</p>
        : text ? <MarkdownLivePreview className="vault-search-preview-document" highlightTerms={highlightTerms} source={text}/> : null}
    </>;
  })();

  const status = !searching ? "Recent documents. Type to search titles and passages in your whole vault."
    : stale ? "Searching…"
    : `${foundEntries.length ? `Found ${foundEntries.length === 1 ? `“${foundEntries[0].hit.title}”` : `${foundEntries.length} documents on this`}. ` : ""}${documents.length} ${documents.length === 1 ? "title" : "titles"}${related.length ? `, ${related.length} best ${related.length === 1 ? "match" : "matches"}` : ""} and ${passages.length} ${passages.length === 1 ? "passage" : "passages"}${results?.complete === false ? " so far" : ""}${results?.notice ? `. ${results.notice}` : ""}`;

  const modal = <div className="vault-search-backdrop" role="presentation" onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()}
    onClick={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }}>
    <section aria-label="Search your vault" aria-modal="true" className="vault-search" ref={dialogRef} role="dialog" onKeyDown={onKeyDown}>
      <label className="vault-search-input">
        <SearchIcon/>
        <span className="vault-search-hidden">Search titles and passages in your whole vault</span>
        <input ref={inputRef} aria-activedescendant={selected ? `${id}-${entryKey(selected)}` : undefined} aria-controls={`${id}-results`}
          aria-expanded="true" autoComplete="off" onChange={(event) => setQuery(event.target.value)} placeholder="Search titles and passages in your whole vault…"
          role="combobox" type="search" value={query}/>
        <button aria-label="Close search" className="vault-search-close" onClick={onClose} type="button"><kbd>Esc</kbd></button>
      </label>
      <div aria-label="Narrow the search" className="vault-search-scopes" role="group">
        {SCOPES.map((option) => <button aria-pressed={scope === option.id} key={option.id} onClick={() => { setScope(option.id); inputRef.current?.focus(); }}
          title={option.id === "family" && currentFamilyTitle ? `Only ${currentFamilyTitle} and the documents under it` : undefined} type="button">
          {option.id === "family" && currentFamilyTitle ? `In ${currentFamilyTitle}` : option.label}</button>)}
      </div>
      <div className="vault-search-body">
        <div className="vault-search-list" ref={listRef}>
          <p className="vault-search-hidden" role="status">{status}</p>
          <ul aria-label="Search results" id={`${id}-results`} role="listbox">
            {answerFirst ? row(ANSWER_ENTRY, <>
              <span className="vault-search-row-title vault-search-answer-title"><span aria-hidden="true">✦</span> Answer from my vault</span>
              <span className="vault-search-meta">A short answer that cites your documents</span>
            </>) : null}
            {foundEntries.length ? <li className="vault-search-section is-found" role="presentation" title="The documents this search seems to be about, ranked whole"><span>{foundEntries.length === 1 ? "Found it" : "Found these"}</span><span>{foundEntries.length}</span></li> : null}
            {foundEntries.map((entry) => row(entry, <>
              <span className="vault-search-row-title">{highlight(entry.hit.title, searchedQuery)}
                {entry.kind === "document" && entry.hit.hiddenFromAI ? <span className="vault-search-cloud" title="Found by its title. AI never reads it.">Hidden from AI</span> : null}
                {cloudPathOf(entry) ? <span className="vault-search-cloud">{openingPath === cloudPathOf(entry) ? "Opening…" : "In cloud"}</span> : null}</span>
              <span className="vault-search-meta vault-search-why">{entry.hit.why}</span>
              {entry.kind === "passage" ? <span className="vault-search-snippet">{highlight(entry.hit.preview, searchedQuery)}</span> : null}
            </>))}
            {canAnswer && !answerFirst ? row(ANSWER_ENTRY, <>
              <span className="vault-search-row-title vault-search-answer-title"><span aria-hidden="true">✦</span> Answer from my vault</span>
              <span className="vault-search-meta">A short answer that cites your documents</span>
            </>) : null}
            {documents.length ? <li className="vault-search-section" role="presentation"><span>{searching ? "Titles" : "Recent"}</span><span>{searching ? documents.length : ""}</span></li> : null}
            {shownDocuments.map((hit) => row({ kind: "document", hit }, <>
              <span className="vault-search-row-title">{highlight(hit.title, searchedQuery)}{hit.target.kind === "cloud" ? <span className="vault-search-cloud">{openingPath === hit.target.path ? "Opening…" : "In cloud"}</span> : null}</span>
              <span className="vault-search-meta">{meta(hit)}</span>
            </>))}
            {documents.length > shownDocuments.length ? <li role="presentation"><button className="vault-search-more" onClick={() => setDocumentLimit((limit) => limit + PASSAGE_PAGE)} type="button">Show {Math.min(PASSAGE_PAGE, documents.length - shownDocuments.length)} more titles</button></li> : null}
            {related.length ? <li className="vault-search-section" role="presentation" title="Ranked by matching words and by meaning"><span>Best matches</span><span>{related.length}</span></li> : null}
            {related.map((hit) => row({ kind: "passage", hit }, <>
              <span className="vault-search-row-title">{hit.title}{hit.cloudPath ? <span className="vault-search-cloud">{openingPath === hit.cloudPath ? "Opening…" : "In cloud"}</span> : null}<span className="vault-search-meta">{hit.matchLabel}</span></span>
              <span className="vault-search-snippet">{highlight(hit.preview, searchedQuery)}</span>
            </>))}
            {searching && passages.length ? <li className="vault-search-section" role="presentation"><span>{related.length ? "All passages with these words" : "Passages"}</span><span>{passages.length}{results?.complete === false ? " so far" : ""}</span></li> : null}
            {shownPassages.map((hit) => row({ kind: "passage", hit }, <>
              <span className="vault-search-row-title">{hit.title}{hit.cloudPath ? <span className="vault-search-cloud">{openingPath === hit.cloudPath ? "Opening…" : "In cloud"}</span> : null}<span className="vault-search-meta">{meta(hit)}</span></span>
              <span className="vault-search-snippet">{highlight(hit.preview, searchedQuery)}</span>
            </>))}
          </ul>
          {passages.length > shownPassages.length ? <button className="vault-search-more" onClick={() => setPassageLimit((limit) => limit + PASSAGE_PAGE)} type="button">Show {Math.min(PASSAGE_PAGE, passages.length - shownPassages.length)} more passages</button> : null}
          {searching && !stale && !entries.length && results?.complete === false ? <p className="vault-search-empty">Searching your whole vault…</p> : null}
          {searching && !stale && !entries.length && results?.complete !== false ? <p className="vault-search-empty">Nothing in your vault matches “{query.trim()}”{scope === "all" ? "" : " in this scope"}. {scope === "all" ? "Try a shorter word." : "Try Anywhere."}</p> : null}
        </div>
        <aside aria-label="Preview" className="vault-search-preview">
          {preview}
          {selected?.kind === "answer" ? <div className="vault-search-actions">
            <button className="vault-search-primary" onClick={() => open(selected, "here")} type="button">Answer <kbd>↵</kbd></button>
          </div> : selected ? <div className="vault-search-actions">
            <button className="vault-search-primary" onClick={() => open(selected, "here")} type="button">Open here <kbd>↵</kbd></button>
            <button onClick={() => open(selected, "beside")} type="button">Open beside <kbd>{mod}↵</kbd></button>
          </div> : null}
        </aside>
      </div>
      <footer className="vault-search-footer">
        <span aria-hidden="true">{status}</span>
        <span className="vault-search-keys"><kbd>↑</kbd><kbd>↓</kbd> move · <kbd>↵</kbd> open here · <kbd>{mod}↵</kbd> open beside{onKeepOpen ? <> · <kbd>⇧↵</kbd> keep open</> : null}</span>
        {onShowOnMap && searching && !stale && Object.keys(spotlightFromSearch(results)).length
          ? <button className="vault-search-explore" onClick={() => onShowOnMap(query.trim(), spotlightFromSearch(results))} title="Light what was found on the Map" type="button">Show on Map</button> : null}
        {onKeepOpen && searching ? <button className="vault-search-explore" onClick={() => { keepQuery(); onKeepOpen(query, scope); }} title="Shift+Enter" type="button">Keep results open</button> : null}
        {onExplore ? <button className="vault-search-explore" onClick={() => { keepQuery(); onExplore(); }} type="button">Filters and connections</button> : null}
      </footer>
    </section>
  </div>;
  return typeof document !== "undefined" ? createPortal(modal, document.body) : modal;
}
