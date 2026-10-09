import { useEffect, useRef, useState } from "react";
import type { PublicTopic } from "../lib/publicKnowledge";
import { searchWikipediaTopics, wikipediaArticleUrl } from "../lib/wikipedia";
import type { WebSearchResult } from "../lib/webSearch";
import { askAboutNote, type PrivateAnswer } from "../lib/publicMapApi";
import { ApiError } from "../lib/apiError";
import type { PublicMapAccount } from "./PublicTopicInsights";
import { WebSearchSection } from "./TopicSources";
import "./TopicSources.css";

/** Where a search with no matches can look next. */
export type SearchFallbackSource = "ai" | "wikipedia" | "web";

const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

/** Wikipedia's own full-text search, for when no article title matches. */
export function wikipediaSearchUrl(query: string) {
  return `https://en.wikipedia.org/w/index.php?${new URLSearchParams({ search: query.trim().slice(0, 200), fulltext: "1", ns0: "1" })}`;
}

/** A related topic from an AI answer, in the shape both maps add. */
export function answerTopic(topic: PrivateAnswer["related"][number], retrievedAt = new Date().toISOString()): PublicTopic {
  return { id: topic.id, aliases: [], label: topic.label, description: topic.description, wikidataUrl: `https://www.wikidata.org/wiki/${topic.id}`, wikipediaUrl: wikipediaArticleUrl(topic.label), retrievedAt };
}

/** A search term reads as a question when it asks one; otherwise AI is asked what it is. */
export function fallbackQuestion(query: string) {
  const text = query.trim().replace(/\s+/g, " ").slice(0, 400);
  return /\?$/.test(text) || /^(who|what|when|where|why|how|which|is|are|does|do|can|should)\b/i.test(text) ? text : `What is ${text}?`;
}

/**
 * The three ways to keep looking when a map search finds nothing. Wikipedia
 * is free for everyone; AI and the web come with a subscription or credit.
 */
export function SearchFallbackActions({ query, canAsk, onChoose, openWikipedia = false }: {
  query: string;
  canAsk: boolean;
  onChoose(source: SearchFallbackSource): void;
  /** Opens Wikipedia's own search in a new tab, for a map whose search already reads Wikipedia. */
  openWikipedia?: boolean;
}) {
  const text = query.trim();
  const memberTag = canAsk ? null : <em className="map-search-fallback-tag">Members</em>;
  const freeTag = <em className="map-search-fallback-tag is-free">Free</em>;
  return <div className="map-search-fallbacks" role="group" aria-label={`Look further for ${text}`}>
    <button type="button" onClick={() => onChoose("ai")}><strong>Ask AI about “{text}”</strong>{memberTag}</button>
    {openWikipedia ? <a href={wikipediaSearchUrl(text)} target="_blank" rel="noreferrer noopener"><strong>Open Wikipedia search for “{text}” ↗</strong>{freeTag}</a>
      : <button type="button" onClick={() => onChoose("wikipedia")}><strong>Search Wikipedia for “{text}”</strong>{freeTag}</button>}
    <button type="button" onClick={() => onChoose("web")}><strong>Search the web for “{text}”</strong>{memberTag}</button>
  </div>;
}

/**
 * Results for a search the map could not answer: Wikipedia articles, web
 * pages and an AI answer. What it finds can be added to the map.
 */
export function SearchFallbackResults({ query, source, account, onAddTopic, topicActionLabel, isTopicAdded, onAddWebResult, webAddLabel, onSaveAnswer, onOpenRelated, relatedActionLabel = "Add to map" }: {
  query: string;
  source: SearchFallbackSource;
  account?: PublicMapAccount;
  onAddTopic(topic: PublicTopic): void;
  topicActionLabel: string;
  isTopicAdded?(topic: PublicTopic): boolean;
  onAddWebResult?(result: WebSearchResult): void;
  webAddLabel?: string;
  /** Saves an AI answer as a note with its topics connected. */
  onSaveAnswer?(answer: PrivateAnswer): void;
  /** Adds one topic an AI answer names. */
  onOpenRelated?(topic: PublicTopic): void;
  relatedActionLabel?: string;
}) {
  const wikipedia = <WikipediaFallback key="wikipedia" query={query} onAddTopic={onAddTopic} actionLabel={topicActionLabel} isAdded={isTopicAdded} />;
  const web = account ? <WebSearchSection key="web" account={account} initialQuery={query} autoSearch={source === "web"} onAddResult={onAddWebResult} addLabel={webAddLabel} />
    : <section key="web" className="topic-sources-web"><h4>Search the web</h4><p className="public-map-muted">Sign in as a member to search the web. Wikipedia search is free for everyone.</p></section>;
  const ai = <AskFallback key="ai" query={query} account={account} autoAsk={source === "ai"} onSaveAnswer={onSaveAnswer} onOpenRelated={onOpenRelated} relatedActionLabel={relatedActionLabel} />;
  const order = source === "ai" ? [ai, wikipedia, web] : source === "web" ? [web, wikipedia, ai] : [wikipedia, web, ai];
  return <div className="map-search-fallback-results">{order}</div>;
}

function WikipediaFallback({ query, onAddTopic, actionLabel, isAdded }: { query: string; onAddTopic(topic: PublicTopic): void; actionLabel: string; isAdded?(topic: PublicTopic): boolean }) {
  const [results, setResults] = useState<{ query: string; topics: PublicTopic[]; error?: string } | null>(null);
  const [added, setAdded] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const search = query.trim();
    setAdded([]);
    if (search.length < 2) { setResults({ query: search, topics: [] }); return; }
    const controller = new AbortController();
    setResults(null);
    searchWikipediaTopics(search, controller.signal)
      .then((topics) => { if (!controller.signal.aborted) setResults({ query: search, topics: topics.slice(0, 8) }); })
      .catch((error: unknown) => { if (!controller.signal.aborted) setResults({ query: search, topics: [], error: errorMessage(error, "Wikipedia could not be reached.") }); });
    return () => controller.abort();
  }, [query, revision]);
  return <section className="map-search-fallback-wikipedia" aria-label="From Wikipedia" aria-busy={!results}>
    <h4>Wikipedia</h4>
    {!results ? <p className="public-map-muted">Searching Wikipedia…</p>
      : results.error ? <div className="public-map-error" role="alert"><p>{results.error}</p><button type="button" onClick={() => setRevision((value) => value + 1)}>Try again</button></div>
      : !results.topics.length ? <p className="public-map-muted">No Wikipedia articles match “{results.query}”.</p> : null}
    {results?.topics.length ? <ul className="public-map-results">{results.topics.map((topic) => {
      const done = added.includes(topic.id) || isAdded?.(topic);
      return <li key={topic.id}><button type="button" disabled={added.includes(topic.id)} onClick={() => { onAddTopic(topic); setAdded((list) => [...list, topic.id]); }}>
        <span className="public-map-result-meta">{done ? "Added" : `Wikipedia · ${actionLabel}`}</span><strong>{topic.label}</strong><span>{topic.description}</span>
      </button></li>;
    })}</ul> : null}
    <p className="public-map-small"><a href={wikipediaSearchUrl(query)} target="_blank" rel="noreferrer noopener">Open “{query.trim()}” on Wikipedia ↗</a> Wikipedia is free for everyone.</p>
  </section>;
}

function AskFallback({ query, account, autoAsk, onSaveAnswer, onOpenRelated, relatedActionLabel }: {
  query: string;
  account?: PublicMapAccount;
  autoAsk: boolean;
  onSaveAnswer?(answer: PrivateAnswer): void;
  onOpenRelated?(topic: PublicTopic): void;
  relatedActionLabel: string;
}) {
  const [question, setQuestion] = useState(() => fallbackQuestion(query));
  const [asking, setAsking] = useState<string | null>(null);
  const [answer, setAnswer] = useState<(PrivateAnswer & { saved?: boolean; opened: string[] }) | null>(null);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const next = fallbackQuestion(query);
    setQuestion(next); setAnswer(null); setError("");
    // Choosing "Ask AI" is the request, so it is sent without a second click.
    if (autoAsk && account?.canAsk) void ask(next);
    return () => controller.current?.abort();
  }, [query]);

  async function ask(text = question.trim()) {
    if (!account?.canAsk || text.length < 3) return;
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setAsking("Sending your question…"); setError("");
    try {
      const result = await askAboutNote({ userId: account.userId, topic: { label: query.trim().slice(0, 200), description: "" },
        noteContent: "", question: text.slice(0, 500), options: account.aiOptions, signal: current.signal,
        onProgress: (progress) => { if (controller.current === current) setAsking(progress); } });
      if (!current.signal.aborted) setAnswer({ ...result, opened: [] });
    } catch (cause) {
      if (current.signal.aborted) return;
      if (cause instanceof ApiError && cause.statusCode === 401) account.onAuthExpired?.();
      setError(errorMessage(cause, "Your question could not be answered. Try again."));
    } finally {
      if (controller.current === current) { controller.current = null; setAsking(null); account.onBillingRefresh?.(); }
    }
  }

  return <section className="public-answers" aria-label={`Ask AI about ${query.trim()}`}>
    <h4>Ask AI</h4>
    {account?.canAsk ? <form className="public-ask" onSubmit={(event) => { event.preventDefault(); void ask(); }}>
      <label htmlFor="map-search-fallback-ask">Your question</label>
      <textarea id="map-search-fallback-ask" value={question} maxLength={500} rows={2} disabled={!!asking} onChange={(event) => setQuestion(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void ask(); } }} />
      <div><span>Only you see this answer.</span>
        {asking ? <button type="button" onClick={() => controller.current?.abort()}>Cancel</button> : null}
        <button type="submit" className="public-map-primary" disabled={!!asking || question.trim().length < 3}>{asking ?? (answer ? "Ask again" : "Ask AI")}</button></div>
      {error ? <p className="public-map-error" role="alert">{error}</p> : null}
    </form> : <p className="public-map-muted">Members with a subscription or credit can ask AI. Wikipedia search is free for everyone.</p>}
    {answer ? <div className="public-answer">
      <strong className="public-answer-question">{answer.question}</strong>
      <p className="public-answer-text">{answer.answer}</p>
      {answer.related.length && onOpenRelated ? <ul className="map-search-fallback-related" aria-label="Topics in this answer">{answer.related.map((topic) => <li key={topic.id}>
        <button type="button" disabled={answer.opened.includes(topic.id)} onClick={() => { onOpenRelated(answerTopic(topic)); setAnswer((previous) => previous && { ...previous, opened: [...previous.opened, topic.id] }); }}>
          <strong>{topic.label}</strong><span>{answer.opened.includes(topic.id) ? "Added" : `${topic.relation} · ${relatedActionLabel}`}</span>
        </button></li>)}</ul> : null}
      <div className="public-answer-meta"><span>AI answer · not checked against sources</span>
        {onSaveAnswer ? <button type="button" disabled={answer.saved} onClick={() => { onSaveAnswer(answer); setAnswer((previous) => previous && { ...previous, saved: true }); }}>
          {answer.saved ? "Saved" : answer.related.length ? "Save as note with its topics" : "Save as note"}</button> : null}</div>
    </div> : null}
  </section>;
}

/** My map's floating panel for a search with no matches in the map. */
export function MapSearchFallbackPanel({ onClose, ...props }: Parameters<typeof SearchFallbackResults>[0] & { onClose(): void }) {
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => { panelRef.current?.focus({ preventScroll: true }); }, [props.query, props.source]);
  return <aside ref={panelRef} tabIndex={-1} className="public-map-sidebar map-topic-sources map-search-fallback-panel" aria-label={`Look further for ${props.query.trim()}`}
    onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <header className="map-topic-sources-header">
      <div><span className="public-map-eyebrow">Not in your map yet</span><h3>“{props.query.trim()}”</h3></div>
      <button type="button" aria-label="Close search" title="Close" onClick={onClose}>×</button>
    </header>
    <div className="map-topic-sources-scroll"><SearchFallbackResults {...props} /></div>
  </aside>;
}
