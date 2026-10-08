import { useDeferredValue, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { getCurrentDocumentText } from "../lib/documentSources";
import { excerpt } from "../lib/tree";
import {
  vaultSearchTerms, type VaultSearchDocumentHit, type VaultSearchPassageHit, type VaultSearchProvider,
  type VaultSearchResults, type VaultSearchScope,
} from "../lib/vaultSearch";
import type { Conversation } from "../types";
import "./VaultSearchPalette.css";

export type VaultSearchOpenMode = "here" | "beside";
type Entry = { kind: "document"; hit: VaultSearchDocumentHit } | { kind: "passage"; hit: VaultSearchPassageHit };

const PASSAGE_PAGE = 30;
const SCOPES: Array<{ id: VaultSearchScope; label: string }> = [
  { id: "all", label: "Anywhere" },
  { id: "family", label: "This family" },
  { id: "documents", label: "Documents" },
  { id: "notes", label: "Notes" },
  { id: "recent", label: "Last 12 months" },
];

function SearchIcon() { return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>; }

function highlight(text: string, query: string): ReactNode {
  const terms = [...new Set(vaultSearchTerms(query))].filter((term) => term.length > 1).sort((a, b) => b.length - a.length);
  if (!terms.length) return text;
  const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return text.split(new RegExp(`(${escaped.join("|")})`, "giu")).map((part, index) => terms.includes(part.toLocaleLowerCase()) ? <mark key={index}>{part}</mark> : part);
}

function dateLabel(value?: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return "";
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function meta(hit: { kindLabel: string; familyTitle?: string; updatedAt?: string }) {
  return [hit.kindLabel, hit.familyTitle, dateLabel(hit.updatedAt)].filter(Boolean).join(" · ");
}

function documentPreview(conversation: Conversation | undefined) {
  if (!conversation) return "";
  const text = conversation.document ? getCurrentDocumentText(conversation) : conversation.messages.at(-1)?.content ?? "";
  return text.trim() ? excerpt(text, 600) : "";
}

const entryKey = (entry: Entry) => entry.hit.key;
const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Cmd+K: one box over the whole vault. Titles first, then passages; Enter opens here, Cmd+Enter beside. */
export default function VaultSearchPalette({ isOpen, onClose, query, onQueryChange, provider, conversations, currentConversationId, currentFamilyTitle, openingPath, onOpenDocument, onOpenPassage, onExplore }: {
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
}) {
  const [scope, setScope] = useState<VaultSearchScope>("all");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [passageLimit, setPassageLimit] = useState(PASSAGE_PAGE);
  const [results, setResults] = useState<VaultSearchResults | null>(null);
  const deferredQuery = useDeferredValue(query);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const mod = isMac() ? "⌘" : "Ctrl";

  useEffect(() => {
    if (!isOpen) return;
    return provider.search({ query: deferredQuery, scope, currentConversationId }, setResults);
  }, [isOpen, provider, deferredQuery, scope, currentConversationId]);
  useEffect(() => { setPassageLimit(PASSAGE_PAGE); setSelectedKey(null); }, [deferredQuery, scope]);
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
  const shownPassages = passages.slice(0, passageLimit);
  const entries: Entry[] = [
    ...documents.map((hit) => ({ kind: "document" as const, hit })),
    ...shownPassages.map((hit) => ({ kind: "passage" as const, hit })),
  ];
  const selected = entries.find((entry) => entryKey(entry) === selectedKey) ?? entries[0] ?? null;
  const selectedIndex = selected ? entries.indexOf(selected) : -1;
  const stale = deferredQuery !== query || (results !== null && results.query !== deferredQuery);

  const selectedEntryKey = selected ? entryKey(selected) : null;
  useEffect(() => {
    if (!selectedEntryKey) return;
    [...listRef.current?.querySelectorAll<HTMLElement>("[data-search-key]") ?? []]
      .find((element) => element.dataset.searchKey === selectedEntryKey)?.scrollIntoView?.({ block: "nearest" });
  }, [selectedEntryKey]);

  if (!isOpen) return null;

  function open(entry: Entry, mode: VaultSearchOpenMode) {
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
    const cloudPath = entry.kind === "document" && entry.hit.target.kind === "cloud" ? entry.hit.target.path : null;
    return <li key={key}>
      <button aria-selected={isSelected} className={`vault-search-row${isSelected ? " is-selected" : ""}`} data-search-key={key} id={`${id}-${key}`}
        disabled={!!cloudPath && openingPath === cloudPath} onClick={(event) => open(entry, event.metaKey || event.ctrlKey ? "beside" : "here")}
        onMouseMove={() => { if (!isSelected) setSelectedKey(key); }} role="option" tabIndex={-1} type="button">{content}</button>
    </li>;
  };

  const preview = (() => {
    if (!selected) return null;
    if (selected.kind === "passage") {
      const hit = selected.hit;
      return <>
        <p className="vault-search-preview-crumb">{hit.familyTitle ? `${hit.familyTitle} › ` : ""}{hit.title}</p>
        <h3>{hit.title}</h3>
        <p className="vault-search-meta">{hit.matchLabel} · {meta(hit)}</p>
        <blockquote className="vault-search-preview-passage">{highlight(hit.passage, query)}</blockquote>
        {hit.localOnly ? <p className="vault-search-meta">Private note. Only shared with AI when you choose to.</p> : null}
      </>;
    }
    const hit = selected.hit;
    const cloud = hit.target.kind === "cloud";
    const text = hit.target.kind === "loaded" ? documentPreview(conversations[hit.target.conversationId]) : "";
    return <>
      <p className="vault-search-preview-crumb">{hit.familyTitle ? `${hit.familyTitle} › ` : ""}{hit.title}</p>
      <h3>{highlight(hit.title, query)}</h3>
      <p className="vault-search-meta">{meta(hit)}</p>
      {cloud ? <p className="vault-search-preview-text">This document is still in your cloud vault. Opening it downloads it to this device.</p>
        : text ? <p className="vault-search-preview-text">{text}</p> : null}
    </>;
  })();

  const status = !searching ? "Recent documents. Type to search titles and passages in your whole vault."
    : stale ? "Searching…"
    : `${documents.length} ${documents.length === 1 ? "title" : "titles"} and ${passages.length} ${passages.length === 1 ? "passage" : "passages"}${results?.complete === false ? " so far" : ""}`;

  const modal = <div className="vault-search-backdrop" role="presentation" onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()}
    onClick={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }}>
    <section aria-label="Search your vault" aria-modal="true" className="vault-search" ref={dialogRef} role="dialog" onKeyDown={onKeyDown}>
      <label className="vault-search-input">
        <SearchIcon/>
        <span className="vault-search-hidden">Search titles and passages in your whole vault</span>
        <input ref={inputRef} aria-activedescendant={selected ? `${id}-${entryKey(selected)}` : undefined} aria-controls={`${id}-results`}
          aria-expanded="true" autoComplete="off" onChange={(event) => onQueryChange(event.target.value)} placeholder="Search titles and passages in your whole vault…"
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
            {documents.length ? <li className="vault-search-section" role="presentation"><span>{searching ? "Titles" : "Recent"}</span><span>{searching ? documents.length : ""}</span></li> : null}
            {documents.map((hit) => row({ kind: "document", hit }, <>
              <span className="vault-search-row-title">{highlight(hit.title, query)}{hit.target.kind === "cloud" ? <span className="vault-search-cloud">{openingPath === hit.target.path ? "Opening…" : "In cloud"}</span> : null}</span>
              <span className="vault-search-meta">{meta(hit)}</span>
            </>))}
            {searching && passages.length ? <li className="vault-search-section" role="presentation"><span>Passages</span><span>{passages.length}{results?.complete === false ? " so far" : ""}</span></li> : null}
            {shownPassages.map((hit) => row({ kind: "passage", hit }, <>
              <span className="vault-search-row-title">{hit.title}<span className="vault-search-meta">{meta(hit)}</span></span>
              <span className="vault-search-snippet">{highlight(hit.preview, query)}</span>
            </>))}
          </ul>
          {passages.length > shownPassages.length ? <button className="vault-search-more" onClick={() => setPassageLimit((limit) => limit + PASSAGE_PAGE)} type="button">Show {Math.min(PASSAGE_PAGE, passages.length - shownPassages.length)} more passages</button> : null}
          {searching && !stale && !entries.length ? <p className="vault-search-empty">Nothing in your vault matches “{query.trim()}”{scope === "all" ? "" : " in this scope"}. {scope === "all" ? "Try a shorter word." : "Try Anywhere."}</p> : null}
        </div>
        <aside aria-label="Preview" className="vault-search-preview">
          {preview}
          {selected ? <div className="vault-search-actions">
            <button className="vault-search-primary" onClick={() => open(selected, "here")} type="button">Open here <kbd>↵</kbd></button>
            <button onClick={() => open(selected, "beside")} type="button">Open beside <kbd>{mod}↵</kbd></button>
          </div> : null}
        </aside>
      </div>
      <footer className="vault-search-footer">
        <span aria-hidden="true">{status}</span>
        <span className="vault-search-keys"><kbd>↑</kbd><kbd>↓</kbd> move · <kbd>↵</kbd> open here · <kbd>{mod}↵</kbd> open beside</span>
        {onExplore ? <button className="vault-search-explore" onClick={onExplore} type="button">Filters and connections</button> : null}
      </footer>
    </section>
  </div>;
  return typeof document !== "undefined" ? createPortal(modal, document.body) : modal;
}
