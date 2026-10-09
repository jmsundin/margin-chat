import { useEffect, useRef, useState } from "react";
import type { PublicTopic } from "../lib/publicKnowledge";
import { getWikipediaSummary, type WikipediaSummary } from "../lib/wikipedia";
import { askPublicMap, deletePublicAnswer, listPublicAnswers, type PublicAnswer, type PublicMapAIOptions } from "../lib/publicMapApi";
import { ApiError } from "../lib/apiError";
import type { WebSearchResult } from "../lib/webSearch";
import { WebSearchSection } from "./TopicSources";

export interface PublicMapAccount {
  userId: string;
  /** Paying members and admins can ask AI; everyone can read shared answers. */
  canAsk: boolean;
  isAdmin: boolean;
  aiOptions?: PublicMapAIOptions;
  onBillingRefresh?: () => void;
  onAuthExpired?: () => void;
}

const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;
const answerDate = (value: string) => Number.isNaN(Date.parse(value)) ? "" : new Date(value).toLocaleDateString();

function AnswerCard({ answer, account, onShowOnMap, onOpenTopic, onDeleted }: {
  answer: PublicAnswer; account: PublicMapAccount;
  onShowOnMap(answer: PublicAnswer): void; onOpenTopic(id: string): void; onDeleted(id: string): void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  async function remove() {
    if (!window.confirm("Delete this shared answer for everyone?")) return;
    setDeleting(true); setError("");
    try { await deletePublicAnswer(account.userId, answer.id); onDeleted(answer.id); }
    catch (cause) { setError(errorMessage(cause, "This answer could not be deleted.")); setDeleting(false); }
  }
  return <li className="public-answer">
    <strong className="public-answer-question">{answer.question}</strong>
    <p className="public-answer-text">{answer.answer}</p>
    {answer.related.length ? <div className="public-answer-topics" aria-label="Topics in this answer">{answer.related.map((topic) =>
      <button type="button" key={topic.id} title={topic.description || topic.relation} onClick={() => onOpenTopic(topic.id)}><span>{topic.relation}</span>{topic.label}</button>)}</div> : null}
    <div className="public-answer-meta">
      <span>AI answer · {answer.mine ? "Asked by you" : "Asked by a member"}{answerDate(answer.createdAt) ? ` · ${answerDate(answer.createdAt)}` : ""}</span>
      {answer.related.length ? <button type="button" onClick={() => onShowOnMap(answer)}>Show on map</button> : null}
      {answer.mine || account.isAdmin ? <button type="button" disabled={deleting} onClick={() => void remove()}>{deleting ? "Deleting…" : "Delete"}</button> : null}
    </div>
    {error ? <p className="public-map-error" role="alert">{error}</p> : null}
  </li>;
}

/** Wikipedia's summary plus the questions members asked about one topic. */
export function PublicTopicInsights({ topic, account, onAnswered, onShowOnMap, onOpenTopic, onAddWebResult }: {
  topic: PublicTopic;
  account: PublicMapAccount;
  /** Saves a web result as a source note in My map. */
  onAddWebResult?(result: WebSearchResult): void;
  onAnswered(answer: PublicAnswer): void;
  onShowOnMap(answer: PublicAnswer): void;
  onOpenTopic(id: string): void;
}) {
  const [summary, setSummary] = useState<{ topicId: string; value: WikipediaSummary | null; error?: string } | null>(null);
  const [answers, setAnswers] = useState<{ topicId: string; items: PublicAnswer[]; error?: string } | null>(null);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState<{ topicId: string; progress: string } | null>(null);
  const [askError, setAskError] = useState("");
  const askController = useRef<AbortController | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setSummary(null);
    if (!topic.wikipediaUrl) { setSummary({ topicId: topic.id, value: null }); return; }
    getWikipediaSummary(topic.wikipediaUrl, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setSummary({ topicId: topic.id, value }); })
      .catch((error: unknown) => { if (!controller.signal.aborted) setSummary({ topicId: topic.id, value: null, error: errorMessage(error, "Wikipedia could not be reached.") }); });
    return () => controller.abort();
  }, [topic.id, topic.wikipediaUrl]);

  useEffect(() => {
    const controller = new AbortController();
    setAnswers(null);
    listPublicAnswers(account.userId, { topicIds: [topic.id], limit: 20, signal: controller.signal })
      .then((items) => { if (!controller.signal.aborted) setAnswers({ topicId: topic.id, items }); })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.statusCode === 401) account.onAuthExpired?.();
        setAnswers({ topicId: topic.id, items: [], error: errorMessage(error, "Shared answers could not be loaded.") });
      });
    return () => controller.abort();
  }, [topic.id, account.userId, revision]);

  useEffect(() => { setQuestion(""); setAskError(""); }, [topic.id]);
  useEffect(() => () => askController.current?.abort(), []);

  async function ask() {
    const text = question.trim();
    if (text.length < 3 || asking) return;
    const controller = new AbortController();
    askController.current = controller;
    setAsking({ topicId: topic.id, progress: "Sending your question…" }); setAskError("");
    try {
      const answer = await askPublicMap({
        userId: account.userId, topic: { id: topic.id, label: topic.label.slice(0, 200), description: topic.description.slice(0, 2000) },
        question: text, options: account.aiOptions, signal: controller.signal,
        onProgress: (progress) => setAsking((current) => current && { ...current, progress }),
      });
      if (controller.signal.aborted) return;
      setQuestion("");
      setAnswers((current) => current?.topicId === answer.topicId ? { ...current, items: [answer, ...current.items.filter((item) => item.id !== answer.id)] } : current);
      onAnswered(answer);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.statusCode === 401) account.onAuthExpired?.();
      setAskError(errorMessage(error, "Your question could not be answered. Try again."));
    } finally {
      if (askController.current === controller) {
        askController.current = null; setAsking(null);
        account.onBillingRefresh?.();
      }
    }
  }

  const currentSummary = summary?.topicId === topic.id ? summary : null;
  const currentAnswers = answers?.topicId === topic.id ? answers : null;
  return <>
    {topic.wikipediaUrl ? <section className="public-wikipedia" aria-label="From Wikipedia" aria-busy={!currentSummary}>
      <h4>From Wikipedia</h4>
      {!currentSummary ? <p className="public-map-muted">Reading Wikipedia…</p>
        : currentSummary.error ? <p className="public-map-muted">{currentSummary.error}</p>
        : currentSummary.value ? <><p className="public-wikipedia-extract">{currentSummary.value.extract}</p><p className="public-map-small">Wikipedia · CC BY-SA 4.0 · Free for everyone</p></>
        : <p className="public-map-muted">Wikipedia has no summary for this topic.</p>}
    </section> : null}
    <WebSearchSection account={account} initialQuery={topic.label} onAddResult={onAddWebResult} />
    <section className="public-answers" aria-label={`Questions about ${topic.label}`}>
      <h4>Questions from members <span>{currentAnswers?.items.length ?? ""}</span></h4>
      {account.canAsk ? <form className="public-ask" onSubmit={(event) => { event.preventDefault(); void ask(); }}>
        <label htmlFor="public-ask-question">Ask AI about {topic.label}</label>
        <textarea id="public-ask-question" value={question} maxLength={500} rows={2} placeholder={`What would you like to know about ${topic.label}?`}
          disabled={!!asking} onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void ask(); } }} />
        <div><span>Your question and its answer are shared with every member.</span>
          {asking ? <button type="button" onClick={() => askController.current?.abort()}>Cancel</button> : null}
          <button type="submit" className="public-map-primary" disabled={!!asking || question.trim().length < 3}>{asking ? asking.progress : "Ask AI"}</button></div>
        {askError ? <p className="public-map-error" role="alert">{askError}</p> : null}
      </form> : <p className="public-map-muted">Members with a subscription or credit can ask AI about this topic. Their answers appear here for everyone.</p>}
      {!currentAnswers ? <p className="public-map-muted">Loading shared answers…</p>
        : currentAnswers.error ? <div className="public-map-error" role="alert"><p>{currentAnswers.error}</p><button type="button" onClick={() => setRevision((value) => value + 1)}>Try again</button></div>
        : !currentAnswers.items.length ? <p className="public-map-muted">No one has asked about this topic yet.</p>
        : <ul className="public-answer-list">{currentAnswers.items.map((answer) => <AnswerCard key={answer.id} answer={answer} account={account}
            onShowOnMap={onShowOnMap} onOpenTopic={onOpenTopic}
            onDeleted={(id) => setAnswers((current) => current && { ...current, items: current.items.filter((item) => item.id !== id) })} />)}</ul>}
      <p className="public-map-small">AI answers come from general knowledge and are not checked against sources.</p>
    </section>
  </>;
}

/** The newest shared questions across the public map, for the starting panel. */
export function PublicAnswerFeed({ account, onOpenAnswer }: { account: PublicMapAccount; onOpenAnswer(answer: PublicAnswer): void }) {
  const [state, setState] = useState<{ items: PublicAnswer[]; error?: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    listPublicAnswers(account.userId, { limit: 8, signal: controller.signal })
      .then((items) => { if (!controller.signal.aborted) setState({ items }); })
      .catch((error: unknown) => { if (!controller.signal.aborted) setState({ items: [], error: errorMessage(error, "Shared answers could not be loaded.") }); });
    return () => controller.abort();
  }, [account.userId]);
  if (!state || (!state.items.length && !state.error)) return null;
  return <section className="public-answer-feed" aria-label="Recently asked by members">
    <h4>Recently asked by members</h4>
    {state.error ? <p className="public-map-muted">{state.error}</p> : <ul className="public-map-topic-list">{state.items.map((answer) =>
      <li key={answer.id}><button type="button" onClick={() => onOpenAnswer(answer)}><span className="public-answer-feed-topic">{answer.topicLabel}</span>{answer.question}</button></li>)}</ul>}
  </section>;
}
