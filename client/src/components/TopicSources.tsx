import { useEffect, useRef, useState } from "react";
import { getPublicTopicFacts, wikidataStatement, type PublicExpansion, type PublicTopic, type PublicTopicFact } from "../lib/publicKnowledge";
import { expandWikipediaTopic, findWikipediaTopic, getWikipediaSummary, searchWikipediaTopics, type WikipediaSummary } from "../lib/wikipedia";
import { searchWeb, type WebSearchResult } from "../lib/webSearch";
import { askAboutNote, type PrivateAnswer } from "../lib/publicMapApi";
import { ApiError } from "../lib/apiError";
import type { PublicMapAccount } from "./PublicTopicInsights";
import { groupRelations } from "../lib/publicRelationGroups";
import "./TopicSources.css";

const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

/**
 * Web search, shared by both maps. It runs on the server for members with a
 * subscription or credit, because no web search API is free at scale.
 */
export function WebSearchSection({ account, initialQuery, onAddResult, addLabel = "Add to my map" }: {
  account: PublicMapAccount;
  initialQuery: string;
  onAddResult?(result: WebSearchResult): void;
  addLabel?: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [state, setState] = useState<{ query: string; results: WebSearchResult[]; error?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [added, setAdded] = useState<string[]>([]);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => { setQuery(initialQuery); setState(null); setAdded([]); controller.current?.abort(); }, [initialQuery]);
  useEffect(() => () => controller.current?.abort(), []);

  async function search() {
    const text = query.trim();
    if (text.length < 2 || loading) return;
    const current = new AbortController();
    controller.current = current;
    setLoading(true);
    try {
      const { results } = await searchWeb(account.userId, text, current.signal);
      if (!current.signal.aborted) setState({ query: text, results });
    } catch (error) {
      if (current.signal.aborted) return;
      if (error instanceof ApiError && error.statusCode === 401) account.onAuthExpired?.();
      setState({ query: text, results: [], error: errorMessage(error, "The web search did not work. Try again.") });
    } finally {
      if (controller.current === current) { controller.current = null; setLoading(false); account.onBillingRefresh?.(); }
    }
  }

  return <section className="topic-sources-web" aria-label="Search the web">
    <h4>Search the web</h4>
    {account.canAsk ? <form className="topic-sources-search" onSubmit={(event) => { event.preventDefault(); void search(); }}>
      <label className="topic-sources-visually-hidden" htmlFor={`web-search-${initialQuery}`}>Search the web</label>
      <input id={`web-search-${initialQuery}`} type="search" value={query} maxLength={300} onChange={(event) => setQuery(event.target.value)} placeholder="Search the web" />
      <button type="submit" disabled={loading || query.trim().length < 2}>{loading ? "Searching…" : "Search"}</button>
    </form> : <p className="public-map-muted">Web search comes with a subscription or credit. Wikipedia search is free for everyone.</p>}
    {state?.error ? <p className="public-map-error" role="alert">{state.error}</p> : null}
    {state && !state.error && !state.results.length ? <p className="public-map-muted">No web pages found for “{state.query}”.</p> : null}
    {state?.results.length ? <ul className="topic-sources-results">{state.results.map((result) => <li key={result.url}>
      <a href={result.url} target="_blank" rel="noreferrer noopener"><span>{result.siteName}{result.age ? ` · ${result.age}` : ""}</span><strong>{result.title}</strong></a>
      {result.description ? <p>{result.description}</p> : null}
      {onAddResult ? <button type="button" disabled={added.includes(result.url)} onClick={() => { onAddResult(result); setAdded((list) => [...list, result.url]); }}>{added.includes(result.url) ? "Added" : addLabel}</button> : null}
    </li>)}</ul> : null}
    {account.canAsk ? <p className="public-map-small">Each search uses a little of your credit. Results come from Brave Search.</p> : null}
  </section>;
}

/**
 * A topic's Wikidata statements as a short About list. Wikidata is metadata
 * here: connections come from Wikipedia, so a missing About section is quiet.
 */
export function WikidataAboutSection({ topicId, onOpenTopic }: { topicId: string; onOpenTopic?: (id: string, label: string) => void }) {
  // Collapsed until asked for, so clicking through topics never reads Wikidata;
  // once opened it stays open for the next topic.
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<{ id: string; facts?: PublicTopicFact[]; error?: boolean } | null>(null);
  const valid = /^Q[1-9]\d*$/.test(topicId);
  useEffect(() => {
    if (!valid || !open) return;
    const controller = new AbortController();
    getPublicTopicFacts(topicId, controller.signal).then((facts) => setState({ id: topicId, facts }), () => {
      if (!controller.signal.aborted) setState({ id: topicId, error: true });
    });
    return () => controller.abort();
  }, [topicId, open, valid]);
  if (!valid) return null;
  const current = state?.id === topicId ? state : null;
  // Facts sharing a property read as one row: "instance of: A, B".
  const rows = new Map<string, { property: string; facts: PublicTopicFact[] }>();
  for (const fact of current?.facts ?? []) {
    const row = rows.get(fact.propertyId) ?? { property: fact.property, facts: [] };
    row.facts.push(fact);
    rows.set(fact.propertyId, row);
  }
  return <details className="topic-sources-about" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>About <span>from Wikidata</span></summary>
    {!open ? null : !current ? <p className="public-map-muted" aria-busy="true">Reading Wikidata…</p>
      : current.error ? <p className="public-map-muted">Wikidata could not be reached. Connections still come from Wikipedia.</p>
      : !rows.size ? <p className="public-map-muted">Wikidata has no statements about this topic yet.</p>
      : <dl>{[...rows].map(([propertyId, row]) => <div key={propertyId}><dt>{row.property}</dt><dd>{row.facts.map((fact, index) => <span key={fact.targetId}>{index ? ", " : ""}{onOpenTopic
        ? <button type="button" className="topic-sources-link" onClick={() => onOpenTopic(fact.targetId, fact.target)}>{fact.target}</button>
        : fact.target}</span>)}</dd></div>)}</dl>}
  </details>;
}

function useWikipediaSummary(url: string | undefined) {
  const [summary, setSummary] = useState<{ url?: string; value: WikipediaSummary | null; error?: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setSummary(null);
    if (!url) { setSummary({ url, value: null }); return; }
    getWikipediaSummary(url, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setSummary({ url, value }); })
      .catch((error: unknown) => { if (!controller.signal.aborted) setSummary({ url, value: null, error: errorMessage(error, "Wikipedia could not be reached.") }); });
    return () => controller.abort();
  }, [url]);
  return summary?.url === url ? summary : null;
}

/** A note in My map that the sources panel works on. */
export interface MapSourceNote {
  id: string;
  title: string;
  content: string;
  topic?: PublicTopic;
}

/**
 * The same three ways to bring information in as the public map: Wikipedia
 * (free), the web and AI (subscription or credit). Wikipedia connections and
 * AI related topics become notes in My map, linked as typed relations.
 */
export function MapTopicSourcesPanel({ note, account, onClose, onAddTopic, onAddConnections, onAddWebResult, onSaveAnswer, onExplorePublic }: {
  /** Null searches Wikipedia to add a new topic to My map. */
  note: MapSourceNote | null;
  account: PublicMapAccount;
  onClose(): void;
  onAddTopic(topic: PublicTopic): void;
  onAddConnections(noteId: string, expansion: PublicExpansion): number;
  onAddWebResult(result: WebSearchResult, noteId: string | null): void;
  onSaveAnswer(noteId: string, answer: PrivateAnswer): void;
  onExplorePublic(topic: PublicTopic): void;
}) {
  const [article, setArticle] = useState<{ noteId: string; topic: PublicTopic | null; error?: string } | null>(null);
  const [offset, setOffset] = useState(0);
  const [expanding, setExpanding] = useState(false);
  const [expansion, setExpansion] = useState<{ result: PublicExpansion; added: number } | null>(null);
  const [expandError, setExpandError] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ query: string; topics: PublicTopic[]; error?: string } | null>(null);
  const [added, setAdded] = useState<string[]>([]);
  const noteId = note?.id ?? null;
  const panelRef = useRef<HTMLElement>(null);

  // Notes saved from the public map know their article; others are matched by title.
  useEffect(() => {
    setOffset(0); setExpansion(null); setExpandError(""); setArticle(null);
    if (!note) return;
    if (note.topic?.wikipediaUrl) { setArticle({ noteId: note.id, topic: note.topic }); return; }
    const controller = new AbortController();
    findWikipediaTopic(note.topic?.label ?? note.title, controller.signal)
      .then((topic) => { if (!controller.signal.aborted) setArticle({ noteId: note.id, topic: topic && note.topic ? { ...topic, id: note.topic.id } : topic }); })
      .catch((error: unknown) => { if (!controller.signal.aborted) setArticle({ noteId: note.id, topic: null, error: errorMessage(error, "Wikipedia could not be reached.") }); });
    return () => controller.abort();
  }, [noteId, note?.title, note?.topic?.id, note?.topic?.wikipediaUrl]);

  useEffect(() => {
    const search = query.trim();
    if (search.length < 2) { setResults(null); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      searchWikipediaTopics(search, controller.signal)
        .then((topics) => { if (!controller.signal.aborted) setResults({ query: search, topics }); })
        .catch((error: unknown) => { if (!controller.signal.aborted) setResults({ query: search, topics: [], error: errorMessage(error, "Wikipedia could not be reached.") }); });
    }, 300);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query]);

  useEffect(() => { panelRef.current?.focus({ preventScroll: true }); }, [noteId]);

  const matched = article?.noteId === noteId ? article : null;
  const summary = useWikipediaSummary(matched?.topic?.wikipediaUrl);

  async function addConnections() {
    if (!note || !matched?.topic || expanding) return;
    setExpanding(true); setExpandError("");
    try {
      let next = offset, total = 0, last: PublicExpansion | null = null;
      // Skip pages whose articles are all in My map already, up to three pages.
      for (let page = 0; page < 3; page += 1) {
        last = await expandWikipediaTopic(matched.topic, next);
        next = last.nextOffset;
        total += onAddConnections(note.id, last);
        if (total || !last.hasMore) break;
      }
      setOffset(next);
      if (last) setExpansion({ result: last, added: total });
    } catch (error) {
      setExpandError(errorMessage(error, "Wikipedia connections could not be loaded. Try again."));
    } finally { setExpanding(false); }
  }

  return <aside ref={panelRef} tabIndex={-1} className="public-map-sidebar map-topic-sources" aria-label={note ? `Sources for ${note.title}` : "Add from Wikipedia"}
    onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <header className="map-topic-sources-header">
      <div><span className="public-map-eyebrow">{note ? "Wikipedia, web and AI" : "Add from Wikipedia"}</span><h3>{note?.title ?? "Find a topic"}</h3></div>
      <button type="button" aria-label="Close sources" title="Close" onClick={onClose}>×</button>
    </header>
    <div className="map-topic-sources-scroll">
      {!note ? <section aria-label="Search Wikipedia">
        <label className="topic-sources-search"><span className="topic-sources-visually-hidden">Search Wikipedia</span>
          <input type="search" autoFocus value={query} maxLength={200} placeholder="Search Wikipedia" onChange={(event) => setQuery(event.target.value)} /></label>
        {results?.error ? <p className="public-map-error" role="alert">{results.error}</p> : null}
        {results && !results.error && !results.topics.length ? <p className="public-map-muted">No Wikipedia articles found. Try a different name.</p> : null}
        <ul className="public-map-results">{results?.topics.map((topic) => <li key={topic.id}>
          <button type="button" disabled={added.includes(topic.id)} onClick={() => { onAddTopic(topic); setAdded((list) => [...list, topic.id]); }}>
            <span className="public-map-result-meta">{added.includes(topic.id) ? "Added to my map" : "Wikipedia · Add to my map"}</span><strong>{topic.label}</strong><span>{topic.description}</span>
          </button></li>)}</ul>
        <p className="public-map-small">Wikipedia search is free for everyone. A topic you add becomes a note, ready for its Wikipedia connections.</p>
      </section> : <>
        <section className="public-wikipedia" aria-label="From Wikipedia" aria-busy={!matched}>
          <h4>From Wikipedia</h4>
          {!matched ? <p className="public-map-muted">Finding the Wikipedia article…</p>
            : matched.error ? <p className="public-map-muted">{matched.error}</p>
            : !matched.topic ? <p className="public-map-muted">No Wikipedia article matches “{note.title}”. Rename the note, or add a topic from Wikipedia.</p>
            : <>
              <p className="topic-sources-article"><a href={matched.topic.wikipediaUrl} target="_blank" rel="noreferrer">{matched.topic.label} ↗</a>{matched.topic.description ? <span>{matched.topic.description}</span> : null}</p>
              {summary?.value ? <p className="public-wikipedia-extract">{summary.value.extract}</p> : summary?.error ? <p className="public-map-muted">{summary.error}</p> : !summary ? <p className="public-map-muted">Reading Wikipedia…</p> : null}
              <div className="topic-sources-actions">
                <button type="button" className="public-map-primary" disabled={expanding || (!!expansion && !expansion.result.hasMore)} onClick={() => void addConnections()}>
                  {expanding ? "Adding connections…" : expansion ? expansion.result.hasMore ? "Add more connections" : "All connections added" : "Add Wikipedia connections"}</button>
                <button type="button" onClick={() => onExplorePublic(matched.topic!)}>Explore in public map</button>
              </div>
              {expandError ? <p className="public-map-error" role="alert">{expandError}</p> : null}
              {expansion ? <>
                <p className="public-map-muted" role="status">{expansion.added ? `${expansion.added} topics added and connected to ${note.title}.` : "These topics are already connected in your map."}</p>
                {groupRelations(expansion.result.topic.id, expansion.result.relations).map((group) => <div key={group.label} className="public-map-relation-group">
                  {group.label ? <h5>{group.label}</h5> : null}
                  <p className="topic-sources-topics">{group.relations.map((relation) => {
                    const label = expansion.result.topics.find((topic) => topic.id === relation.targetId)?.label;
                    return label && relation.wikidata ? `${label} (Wikidata: ${wikidataStatement(relation, expansion.result.topic.label, label)})` : label;
                  }).filter(Boolean).join(" · ")}</p>
                </div>)}
              </> : <p className="public-map-small">Broader topics become “part of” links, and the articles this one links to become notes that elaborate it, grouped by section. Wikipedia is free for everyone.</p>}
            </>}
        </section>
        {matched?.topic ? <WikidataAboutSection topicId={matched.topic.id} /> : null}
        <WebSearchSection account={account} initialQuery={note.title} onAddResult={(result) => onAddWebResult(result, note.id)} addLabel="Save as connected note" />
        <PrivateAskSection account={account} note={note} onSaveAnswer={(answer) => onSaveAnswer(note.id, answer)} />
      </>}
    </div>
  </aside>;
}

/** Ask AI about a note in My map. Answers stay private; saving one creates a connected note. */
export function PrivateAskSection({ account, note, onSaveAnswer }: {
  account: PublicMapAccount;
  note: MapSourceNote;
  onSaveAnswer(answer: PrivateAnswer): void;
}) {
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState<string | null>(null);
  const [answers, setAnswers] = useState<{ noteId: string; items: (PrivateAnswer & { saved?: boolean })[] }>({ noteId: note.id, items: [] });
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => { setQuestion(""); setError(""); setAnswers({ noteId: note.id, items: [] }); controller.current?.abort(); }, [note.id]);
  useEffect(() => () => controller.current?.abort(), []);

  async function ask() {
    const text = question.trim();
    if (text.length < 3 || asking) return;
    const current = new AbortController();
    controller.current = current;
    setAsking("Sending your question…"); setError("");
    try {
      const answer = await askAboutNote({ userId: account.userId, topic: { label: note.title.slice(0, 200), description: note.topic?.description.slice(0, 2000) ?? "" },
        noteContent: note.content.slice(0, 6000), question: text, options: account.aiOptions, signal: current.signal,
        onProgress: (progress) => { if (controller.current === current) setAsking(progress); } });
      if (current.signal.aborted) return;
      setQuestion("");
      setAnswers((previous) => ({ noteId: note.id, items: [answer, ...previous.noteId === note.id ? previous.items : []] }));
    } catch (cause) {
      if (current.signal.aborted) return;
      if (cause instanceof ApiError && cause.statusCode === 401) account.onAuthExpired?.();
      setError(errorMessage(cause, "Your question could not be answered. Try again."));
    } finally {
      if (controller.current === current) { controller.current = null; setAsking(null); account.onBillingRefresh?.(); }
    }
  }

  return <section className="public-answers" aria-label={`Ask AI about ${note.title}`}>
    <h4>Ask AI</h4>
    {account.canAsk ? <form className="public-ask" onSubmit={(event) => { event.preventDefault(); void ask(); }}>
      <label htmlFor={`private-ask-${note.id}`}>Ask AI about {note.title}</label>
      <textarea id={`private-ask-${note.id}`} value={question} maxLength={500} rows={2} disabled={!!asking} placeholder={`What would you like to know about ${note.title}?`}
        onChange={(event) => setQuestion(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void ask(); } }} />
      <div><span>Only you see this answer. It uses your note as context.</span>
        {asking ? <button type="button" onClick={() => controller.current?.abort()}>Cancel</button> : null}
        <button type="submit" className="public-map-primary" disabled={!!asking || question.trim().length < 3}>{asking ?? "Ask AI"}</button></div>
      {error ? <p className="public-map-error" role="alert">{error}</p> : null}
    </form> : <p className="public-map-muted">Members with a subscription or credit can ask AI about their notes. Wikipedia is free for everyone.</p>}
    {answers.noteId === note.id && answers.items.length ? <ul className="public-answer-list">{answers.items.map((answer, index) => <li className="public-answer" key={`${index}-${answer.question}`}>
      <strong className="public-answer-question">{answer.question}</strong>
      <p className="public-answer-text">{answer.answer}</p>
      {answer.related.length ? <p className="topic-sources-topics">{answer.related.map((topic) => `${topic.label} (${topic.relation})`).join(" · ")}</p> : null}
      <div className="public-answer-meta"><span>AI answer · not checked against sources</span>
        <button type="button" disabled={answer.saved} onClick={() => {
          onSaveAnswer(answer);
          setAnswers((previous) => ({ ...previous, items: previous.items.map((item) => item === answer ? { ...item, saved: true } : item) }));
        }}>{answer.saved ? "Saved" : answer.related.length ? "Save as note with its topics" : "Save as note"}</button></div>
    </li>)}</ul> : null}
  </section>;
}
