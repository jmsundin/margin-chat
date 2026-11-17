import { useEffect, useMemo, useRef, useState } from "react";
import { statusAfterReview } from "@margin-chat/workspace-contracts/languageCourses";
import { FLASHCARD_RATINGS, formatInterval, nextFromSchedule, previewFromSchedule, type FlashcardRating } from "../lib/flashcardSchedule";
import { dueWords, fetchStats, lastDays, type StudyDay, type StudyStats } from "../lib/languageCourses";
import type { LanguageTerm, TermStatus } from "../lib/languageReader";
import type { TermPatch } from "../lib/languageTerms";

/** The learner's words in a language: a table to look through and re-rate, review by FSRS, and how study went day by day. */

type SetTerm = (language: string, text: string, patch: TermPatch) => void;

const STATUS_NAMES: Record<number, string> = { [-1]: "Ignored", 0: "New", 1: "1 · New to me", 2: "2 · Recognized", 3: "3 · Familiar", 4: "4 · Almost known", 5: "Known" };
const FILTERS = [
  { id: "learning", label: "Learning", test: (status: number) => status >= 1 && status <= 4 },
  { id: "known", label: "Known", test: (status: number) => status === 5 },
  { id: "ignored", label: "Ignored", test: (status: number) => status === -1 },
  { id: "all", label: "All", test: () => true },
] as const;
const PAGE = 200;

export function Vocabulary({ lang, terms, setTerm, onReview }: { lang: string; terms: ReadonlyMap<string, LanguageTerm>; setTerm: SetTerm; onReview: () => void }) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("learning");
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);
  const all = useMemo(() => [...terms.values()].filter((term) => term.language === lang), [terms, lang]);
  const due = useMemo(() => dueWords(all, lang).length, [all, lang]);
  const rows = useMemo(() => {
    const test = FILTERS.find((item) => item.id === filter)!.test;
    const wanted = query.trim().toLowerCase();
    return all.filter((term) => test(term.status) && (!wanted || term.key.includes(wanted) || term.meaning.toLowerCase().includes(wanted)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [all, filter, query]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((item) => [item.id, all.filter((term) => item.test(term.status)).length])), [all]);
  return <div className="language-study">
    <header className="language-study-head">
      <h2>Vocabulary</h2>
      <button type="button" className="is-primary" onClick={onReview} disabled={!due}>{due ? `Review ${due} word${due === 1 ? "" : "s"}` : "Nothing to review"}</button>
    </header>
    <div className="language-study-filters">
      <div role="tablist" aria-label="Which words">
        {FILTERS.map((item) => <button key={item.id} type="button" role="tab" aria-selected={filter === item.id} onClick={() => { setFilter(item.id); setShown(PAGE); }}>
          {item.label} <small>{counts[item.id]}</small></button>)}
      </div>
      <input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setShown(PAGE); }} placeholder="Find a word or meaning" aria-label="Find a word or meaning" lang={lang} />
    </div>
    {rows.length ? <table className="language-study-table">
      <thead><tr><th>Word</th><th>Meaning</th><th>Status</th><th className="is-due">Next review</th></tr></thead>
      <tbody>{rows.slice(0, shown).map((term) => <tr key={term.key}>
        <td lang={lang}><b>{term.key}</b>{term.fragment ? <small lang={lang}>{term.fragment}</small> : null}</td>
        <td>{term.meaning || <span className="language-library-quiet">—</span>}</td>
        <td><select aria-label={`Status of ${term.key}`} value={term.status} onChange={(event) => setTerm(lang, term.key, { status: Number(event.target.value) as TermStatus })}>
          {[1, 2, 3, 4, 5, -1].map((status) => <option key={status} value={status}>{STATUS_NAMES[status]}</option>)}
          {term.status === 0 ? <option value={0}>New</option> : null}
        </select></td>
        <td className="is-due">{term.status >= 1 && term.status <= 4 ? term.srs ? whenDue(term.srs.due) : term.meaning ? "Now" : "After a meaning" : ""}</td>
      </tr>)}</tbody>
    </table> : <p className="language-library-quiet">{all.length ? "No words match." : "Words you rate or give a meaning while reading show up here."}</p>}
    {rows.length > shown ? <button type="button" className="language-library-link" onClick={() => setShown((value) => value + PAGE)}>Show {Math.min(PAGE, rows.length - shown)} more</button> : null}
  </div>;
}

function whenDue(due: number, now = Date.now()) {
  return due <= now ? "Now" : `in ${formatInterval(due - now)}`;
}

/** The word in its sentence, marked, so it's reviewed where it was met. */
function InSentence({ fragment, word, lang }: { fragment: string; word: string; lang: string }) {
  const at = fragment.toLowerCase().indexOf(word.toLowerCase());
  if (at < 0) return <p className="language-review-fragment" lang={lang}><mark>{word}</mark><br /><small>{fragment}</small></p>;
  return <p className="language-review-fragment" lang={lang}>{fragment.slice(0, at)}<mark>{fragment.slice(at, at + word.length)}</mark>{fragment.slice(at + word.length)}</p>;
}

/**
 * Review of the words being learned, by their FSRS card: the sentence the word was met in, then its meaning,
 * then Again / Hard / Good / Easy. Good on a word at 4 makes it known; Again sends it back to 1.
 */
export function WordReview({ lang, terms, setTerm, onReviewed, onDone }: {
  lang: string; terms: ReadonlyMap<string, LanguageTerm>; setTerm: SetTerm; onReviewed: () => void; onDone: () => void;
}) {
  // The words due when the review starts; a word answered isn't asked again until next time.
  const [queue] = useState(() => dueWords(terms.values(), lang).slice(0, 50).map((term) => term.key));
  const [index, setIndex] = useState(0);
  const [shown, setShown] = useState(false);
  const [counts, setCounts] = useState({ reviewed: 0, known: 0 });
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { root.current?.focus({ preventScroll: true }); }, [index]);
  const key = queue[index];
  const term = key ? [...terms.values()].find((item) => item.language === lang && item.key === key) ?? null : null;
  const now = Date.now();
  const preview = useMemo(() => (term ? previewFromSchedule(term.srs ?? null, now) : null), [term?.key, index]); // eslint-disable-line react-hooks/exhaustive-deps

  function grade(rating: FlashcardRating) {
    if (!term) return;
    const status = statusAfterReview(term.status, rating) as TermStatus;
    setTerm(lang, term.key, { srs: nextFromSchedule(term.srs ?? null, rating, Date.now()), status });
    onReviewed();
    setCounts((value) => ({ reviewed: value.reviewed + 1, known: value.known + (status === 5 && term.status !== 5 ? 1 : 0) }));
    setShown(false);
    setIndex((value) => value + 1);
  }

  if (!term) return <div className="language-study language-review-done" ref={root} tabIndex={-1}>
    <h2>{counts.reviewed ? "Review done" : "Nothing to review"}</h2>
    <p className="language-library-quiet">{counts.reviewed ? `${counts.reviewed} word${counts.reviewed === 1 ? "" : "s"} reviewed${counts.known ? `, ${counts.known} now known` : ""}. Words come back when they're due.` : "Words with a meaning come up here when they're due."}</p>
    <button type="button" className="is-primary" onClick={onDone}>Back to vocabulary</button>
  </div>;

  return <div className="language-study language-review" ref={root} tabIndex={-1} onKeyDown={(event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
    if (!shown && (event.key === " " || event.key === "Enter")) { event.preventDefault(); setShown(true); }
    else if (shown && ["1", "2", "3", "4"].includes(event.key)) { event.preventDefault(); grade(Number(event.key) as FlashcardRating); }
  }}>
    <p className="language-review-count" aria-live="polite">{index + 1} of {queue.length}</p>
    <div className="language-review-card">
      {term.fragment ? <InSentence fragment={term.fragment} word={term.key} lang={lang} /> : <p className="language-review-word" lang={lang}>{term.key}</p>}
      {shown ? <div className="language-review-answer">
        <p className="language-review-meaning">{term.meaning || <span className="language-library-quiet">No meaning saved</span>}</p>
        <p className="language-library-quiet">{STATUS_NAMES[term.status]}{term.status === 4 ? " · Good makes it known" : ""}</p>
      </div> : null}
    </div>
    {shown ? <div className="language-review-grades" role="group" aria-label="How well did you know it?">
      {FLASHCARD_RATINGS.map(({ rating, label, key: hotkey }) => <button key={rating} type="button" data-rating={rating} onClick={() => grade(rating)}>
        <b>{label}</b><small>{preview ? formatInterval(Math.max(60_000, preview[rating] - now)) : ""} · {hotkey}</small></button>)}
    </div> : <button type="button" className="is-primary language-review-show" onClick={() => setShown(true)}>Show meaning <small>Space</small></button>}
  </div>;
}

const METRICS: ReadonlyArray<{ key: keyof Omit<StudyDay, "day">; title: string; unit: (value: number) => string }> = [
  { key: "words_read", title: "Words read", unit: (value) => `${value.toLocaleString()} word${value === 1 ? "" : "s"} read` },
  { key: "words_known", title: "New known words", unit: (value) => `${value.toLocaleString()} new known word${value === 1 ? "" : "s"}` },
  { key: "reader_seconds", title: "Minutes reading", unit: (value) => `${Math.round(value / 60)} min reading` },
];

/** Known words, and the last 30 days of reading, one small chart a measure. */
export function StudyStatsView({ userId, lang, terms }: { userId: string; lang: string; terms: ReadonlyMap<string, LanguageTerm> }) {
  const [stats, setStats] = useState<StudyStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [table, setTable] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetchStats(userId, lang, controller.signal).then(setStats, (failure: unknown) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Your stats couldn't be loaded."); });
    return () => controller.abort();
  }, [userId, lang]);
  const days = useMemo(() => lastDays(stats?.days ?? [], 30), [stats]);
  const today = days.at(-1);
  // The word list on this device is the newest there is: it's what the account syncs from.
  const { known, learning } = useMemo(() => {
    let knownCount = 0, learningCount = 0;
    for (const term of terms.values()) {
      if (term.language !== lang || term.key.includes(" ")) continue;
      if (term.status === 5) knownCount++; else if (term.status >= 1 && term.status <= 4) learningCount++;
    }
    return { known: Math.max(knownCount, stats?.words.known ?? 0), learning: learningCount };
  }, [terms, lang, stats]);
  return <div className="language-study">
    <header className="language-study-head"><h2>Stats</h2>
      <button type="button" className="language-library-link" onClick={() => setTable((value) => !value)}>{table ? "Show charts" : "Show as table"}</button></header>
    {error ? <p className="language-library-error" role="alert">{error}</p> : null}
    <div className="language-stats-tiles">
      <div><b>{known.toLocaleString()}</b><span>known words</span></div>
      <div><b>{learning.toLocaleString()}</b><span>learning</span></div>
      <div><b>{(today?.words_read ?? 0).toLocaleString()}</b><span>words read today</span></div>
      <div><b>{Math.round((today?.reader_seconds ?? 0) / 60)}</b><span>minutes today</span></div>
    </div>
    {!stats && !error ? <p className="language-library-quiet" role="status">Loading…</p> : null}
    {stats && table ? <table className="language-study-table">
      <thead><tr><th>Day</th>{METRICS.map((metric) => <th key={metric.key}>{metric.title}</th>)}<th>Meanings saved</th><th>Reviewed</th></tr></thead>
      <tbody>{[...days].reverse().map((day) => <tr key={day.day}><td>{dayLabel(day.day)}</td><td>{day.words_read}</td><td>{day.words_known}</td><td>{Math.round(day.reader_seconds / 60)}</td><td>{day.meanings_saved}</td><td>{day.reviewed}</td></tr>)}</tbody>
    </table> : null}
    {stats && !table ? METRICS.map((metric) => <DayBars key={metric.key} title={metric.title} days={days} value={(day) => metric.key === "reader_seconds" ? Math.round(day.reader_seconds / 60) : day[metric.key]} label={(value) => metric.key === "reader_seconds" ? `${value} min reading` : metric.unit(value)} />) : null}
  </div>;
}

const dayLabel = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** One measure over 30 days as thin bars from a zero baseline, with the day's value on hover or focus. */
function DayBars({ title, days, value, label }: { title: string; days: StudyDay[]; value: (day: StudyDay) => number; label: (value: number) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const values = days.map(value);
  const max = Math.max(1, ...values);
  const width = 600, height = 120, gap = 2, bar = width / days.length;
  const top = niceTop(max);
  const picked = hover === null ? null : days[hover];
  return <section className="language-stats-chart" aria-label={title}>
    <header><h3>{title}</h3><span className="language-library-quiet">{picked ? `${dayLabel(picked.day)}: ${label(values[hover!])}` : `${values.reduce((sum, item) => sum + item, 0).toLocaleString()} in 30 days`}</span></header>
    <div className="language-stats-plot">
    {values.some(Boolean) ? <span className="language-stats-top" aria-hidden="true">{top.toLocaleString()}</span> : null}
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title}, last 30 days`} preserveAspectRatio="none" onPointerLeave={() => setHover(null)}>
      <line x1={0} x2={width} y1={height} y2={height} className="language-stats-axis" />
      <line x1={0} x2={width} y1={0} y2={0} className="language-stats-grid" />
      {values.map((amount, index) => {
        const h = amount ? Math.max(2, (amount / top) * height) : 0;
        return <g key={days[index].day}>
          <rect x={index * bar} y={0} width={bar} height={height} fill="transparent" onPointerEnter={() => setHover(index)} />
          {h ? <path className="language-stats-bar" data-active={hover === index || undefined}
            d={roundedTop(index * bar + gap / 2, height - h, bar - gap, h, Math.min(4, (bar - gap) / 2, h))} pointerEvents="none" /> : null}
        </g>;
      })}
    </svg>
    </div>
    <div className="language-stats-scale" aria-hidden="true"><span>{dayLabel(days[0].day)}</span><span>Today</span></div>
  </section>;
}

function niceTop(max: number) {
  const step = 10 ** Math.floor(Math.log10(max));
  return Math.ceil(max / step) * step;
}

/** A bar with its top corners rounded and its foot square on the baseline. */
function roundedTop(x: number, y: number, w: number, h: number, r: number) {
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}
