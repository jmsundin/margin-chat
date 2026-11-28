import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { AROUND_PUBLIC_LIMIT, ringPoints, sameTopicName, topicQuery, wikipediaTitlesIn, type AroundNeighbour } from "../lib/aroundRings";
import type { BrowseNode } from "../lib/exploreSources";
import type { PublicTopic } from "../lib/publicKnowledge";
import { expandWikipediaTopic, findWikipediaTopic, resolveWikipediaTitles, searchWikipediaTopics, wikipediaTitle } from "../lib/wikipedia";
import { useSize } from "./exploreCamera";
import type { ExplorePublicActions } from "./ExplorePublic";
import "./ExploreLibrary.css";

/** Public topics found for a note or a topic, kept for this visit so moving back and forth doesn't ask Wikipedia again. */
const publicCache = new Map<string, PublicTopic[]>();
function remember(key: string, topics: PublicTopic[]) {
  publicCache.set(key, topics);
  while (publicCache.size > 80) publicCache.delete(publicCache.keys().next().value!);
}

/** Wikipedia topics around a note: the article it links to, or the one its title names, and that article's main links. */
async function publicTopicsFor(title: string, text: string, signal: AbortSignal): Promise<PublicTopic[]> {
  const linked = wikipediaTitlesIn(text);
  let base: PublicTopic | null = null;
  if (linked.length) base = (await resolveWikipediaTitles([linked[0]], signal)).get(linked[0]) ?? null;
  const query = topicQuery(title);
  // Only an article the title really names: a search hit for "Second note" is the Second Boer War, not this note.
  if (!base && query.length >= 2) base = await findWikipediaTopic(query, signal).then((topic) => topic && sameTopicName(topic.label, query) ? topic : null);
  if (!base) return [];
  const expansion = await expandWikipediaTopic(base, 0, signal);
  return [expansion.topic, ...expansion.topics];
}

/** The topics a Wikipedia topic links to, the topic itself first (with its description filled in). */
async function topicsAround(topic: PublicTopic, signal: AbortSignal): Promise<PublicTopic[]> {
  const expansion = await expandWikipediaTopic(topic, 0, signal);
  return [expansion.topic, ...expansion.topics];
}

function articleOf(topic: PublicTopic) {
  return wikipediaTitle(topic.wikipediaUrl)?.replaceAll("_", " ") ?? topic.label;
}
function nodeOf(topic: PublicTopic): BrowseNode {
  return { id: `around:${topic.id}`, label: topic.label, kind: "article", weight: 1, article: articleOf(topic), ...(topic.description ? { summary: topic.description } : {}) };
}

const ICON: Record<string, ReactNode> = {
  back: <path d="M15 6l-6 6 6 6" />,
  read: <path d="M4 5.5C6.5 4.5 9.5 4.5 12 6c2.5-1.5 5.5-1.5 8-.5V19c-2.5-1-5.5-1-8 .5-2.5-1.5-5.5-1.5-8-.5V5.5ZM12 6v13.5" />,
  keep: <path d="M6 4h12v16l-6-4-6 4V4ZM12 8v5M9.5 10.5h5" />,
  open: <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
  note: <path d="M6 3h8l4 4v14H6V3ZM14 3v4h4M9 13h6M12 10v6" />,
  roadmap: <path d="M5 19c3 0 3-5 7-5s4-5 7-5M5 19h.01M19 9h.01M5 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM19 7a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z" />,
  details: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" />,
};

/**
 * Explore around one note, or around a public topic reached from it: the middle, your notes on the
 * inner ring (linked to the note, or about the topic), and public topics on the outer ring. Tapping a
 * public topic walks there, so you can wander Wikipedia from any note; the trail walks back.
 */
export default function AroundRings({ center, neighbours, titleOf, textOf, notesAbout, leading, actions, reader, onSelect }: {
  center: { id: string; title: string };
  neighbours: AroundNeighbour[];
  titleOf: (id: string) => string;
  /** The note's text, to find the Wikipedia articles it links to. */
  textOf: (id: string) => string;
  /** Your notes about a public topic, best first. */
  notesAbout?: (label: string) => string[];
  leading?: ReactNode;
  actions: ExplorePublicActions;
  reader?: ReactNode;
  /** Moves the middle to a note (or opens it beside the page, where the map sits beside one). */
  onSelect: (id: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [ref, size] = useSize<HTMLDivElement>();
  /** Public topics walked to from the note, in order; the last one is in the middle. */
  const [trail, setTrail] = useState<PublicTopic[]>([]);
  useEffect(() => { setTrail([]); }, [center.id]);
  const topic = trail.at(-1) ?? null;
  const key = topic ? `topic\n${topic.id}` : `${center.id}\n${center.title}`;

  const [found, setFound] = useState<{ key: string; topics: PublicTopic[] } | { key: string; error: true } | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const cached = publicCache.get(key);
    if (cached) { setFound({ key, topics: cached }); return; }
    const controller = new AbortController();
    setFound(null);
    (topic ? topicsAround(topic, controller.signal) : publicTopicsFor(center.title, textOf(center.id), controller.signal)).then((topics) => {
      remember(key, topics);
      if (!controller.signal.aborted) setFound({ key, topics });
    }, () => { if (!controller.signal.aborted) setFound({ key, error: true }); });
    return () => controller.abort();
  }, [key, retry]);
  const loading = !found || found.key !== key;
  const failed = !loading && found && "error" in found;
  /** The middle topic as Wikipedia described it, once the links have come back. */
  const here = topic && found && found.key === key && "topics" in found ? found.topics[0] ?? topic : topic;

  const inner = useMemo<AroundNeighbour[]>(() => topic
    ? (notesAbout?.(topic.label) ?? []).slice(0, 8).map((id) => ({ id, kind: "linked" as const }))
    : neighbours, [topic, neighbours, notesAbout]);
  const outerTopics = useMemo<PublicTopic[]>(() => {
    if (!found || found.key !== key || !("topics" in found)) return [];
    const walked = new Set(trail.map((item) => item.id));
    const mine = new Set([center.title, ...inner.map((item) => titleOf(item.id))].map((title) => title.trim().toLocaleLowerCase()));
    // Around a note, the first topic is the note's own article; around a topic, it is the middle itself.
    return found.topics.slice(topic ? 1 : 0).filter((item) => !walked.has(item.id) && !mine.has(item.label.toLocaleLowerCase()) && (topic || !actions.noteFor(item.label, item)))
      .slice(0, AROUND_PUBLIC_LIMIT);
  }, [found, key, topic, trail, center.title, inner, titleOf, actions]);

  const walk = (next: PublicTopic) => setTrail((current) => [...current, next]);
  const backTo = (length: number) => setTrail((current) => current.slice(0, length));

  // Searching any topic: Wikipedia's matches, picked to put that topic in the middle.
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ query: string; topics: PublicTopic[] } | null>(null);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    const search = query.trim();
    if (search.length < 2) { setResults(null); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearching(true);
      searchWikipediaTopics(search, controller.signal).then((topics) => { if (!controller.signal.aborted) setResults({ query: search, topics: topics.slice(0, 6) }); },
        () => { if (!controller.signal.aborted) setResults({ query: search, topics: [] }); })
        .finally(() => { if (!controller.signal.aborted) setSearching(false); });
    }, 250);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [query]);
  const pickResult = (picked: PublicTopic) => { setTrail([picked]); setQuery(""); setResults(null); };

  // The middle topic's own actions, one line of icons that each say what they do.
  const [kept, setKept] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => { setNotice(null); }, [key]);
  const keptNote = here ? kept[here.id] ?? actions.noteFor(here.label, here) : null;
  const act = (reason: string | null) => setNotice(reason);
  const centerActions = here ? <div className="explore-around-actions" role="toolbar" aria-label={`${here.label} actions`}>
    <button type="button" data-tip="Read on Wikipedia" aria-label="Read on Wikipedia" onClick={() => actions.onRead(articleOf(here))}><svg aria-hidden="true" viewBox="0 0 24 24">{ICON.read}</svg></button>
    {keptNote ? <button type="button" data-tip="Open your note" aria-label="Open your note" onClick={() => actions.onOpenNote(keptNote)}><svg aria-hidden="true" viewBox="0 0 24 24">{ICON.open}</svg></button>
      : <button type="button" data-tip="Keep as a note in your vault" aria-label="Keep as a note in your vault" onClick={() => {
        void actions.onKeep(nodeOf(here)).then((made) => { if ("id" in made) { setKept((current) => ({ ...current, [here.id]: made.id })); act("Kept in your notes."); } else act(made.error); });
      }}><svg aria-hidden="true" viewBox="0 0 24 24">{ICON.keep}</svg></button>}
    <button type="button" data-tip="Write a new note about it" aria-label="Write a new note about it" onClick={() => act(actions.onNewNote(nodeOf(here)))}><svg aria-hidden="true" viewBox="0 0 24 24">{ICON.note}</svg></button>
    {actions.ask ? <button type="button" data-tip="Topic details from AI" aria-label="Topic details from AI" onClick={() => actions.onDetails(nodeOf(here))}><svg aria-hidden="true" viewBox="0 0 24 24">{ICON.details}</svg></button> : null}
    {actions.onRoadmap ? <button type="button" data-tip="Make a roadmap to learn it" aria-label="Make a roadmap to learn it" onClick={() => act(actions.onRoadmap!(nodeOf(here)))}><svg aria-hidden="true" viewBox="0 0 24 24">{ICON.roadmap}</svg></button> : null}
  </div> : null;

  const narrow = size.width > 0 && size.width < 560;
  const { width, height } = size;
  const cx = width / 2, cy = height / 2;
  const innerY = height * 0.25, innerX = Math.min(width * 0.25, innerY * 1.7);
  const outerY = height * 0.41, outerX = Math.min(width * 0.43, outerY * 1.9);
  const innerPoints = ringPoints(inner.length, cx, cy, innerX, innerY);
  const outerPoints = ringPoints(outerTopics.length, cx, cy, outerX, outerY, outerTopics.length ? 0.5 / outerTopics.length : 0);
  const place = (point: { x: number; y: number }): CSSProperties => ({ left: Math.max(70, Math.min(width - 70, point.x)), top: Math.max(14, Math.min(height - 64, point.y)) });
  const status = loading ? "Finding topics on Wikipedia…" : failed ? "Wikipedia could not be reached." : !outerTopics.length
    ? topic ? "No more linked topics here." : "No public topics found for this note. Search any topic above." : null;
  const centerTitle = here?.label ?? center.title;
  const innerHeading = topic ? "Your notes about it" : "Linked to this note";
  const innerEmpty = topic ? "None of your notes mention it yet." : "No notes link here yet.";
  const outerHeading = topic ? "Linked topics on Wikipedia" : "Public topics, not in your vault yet";

  const search = <div className="explore-around-search">
    <input type="search" value={query} placeholder="Explore any topic…" aria-label="Explore any topic on Wikipedia" enterKeyHint="search"
      onChange={(event) => setQuery(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.stopPropagation(); setQuery(""); }
        if (event.key === "Enter" && results?.topics[0]) { event.preventDefault(); pickResult(results.topics[0]); }
      }} />
    {query.trim().length >= 2 ? <div className="explore-around-results" role="listbox" aria-label="Topics on Wikipedia">
      {results?.topics.map((item) => <button type="button" role="option" aria-selected={false} key={item.id} onClick={() => pickResult(item)}>
        <strong>{item.label}</strong>{item.description ? <small>{item.description}</small> : null}</button>)}
      {searching && !results?.topics.length ? <p role="status">Searching Wikipedia…</p> : null}
      {!searching && results && results.query === query.trim() && !results.topics.length ? <p role="status">No topics found on Wikipedia.</p> : null}
    </div> : null}
  </div>;

  return <div ref={rootRef} className={`explore-library is-public is-around${reader ? " has-reader" : ""}`} data-graph-ui="true">
    <div className="explore-public-main">
      <nav className="explore-library-crumbs explore-around-bar" aria-label="Where you are in Explore">
        {leading}
        {search}
      </nav>
      <nav className="explore-around-trail" aria-label="Your path">
        {trail.length ? <button type="button" className="explore-around-back" aria-label="Back" title="Back" onClick={() => backTo(trail.length - 1)}>
          <svg aria-hidden="true" viewBox="0 0 24 24">{ICON.back}</svg></button> : null}
        {trail.length ? <button type="button" onClick={() => backTo(0)} title={center.title}>{center.title}</button> : <span className="is-here" title={center.title}>{center.title}</span>}
        {trail.map((item, index) => <span key={item.id} className="explore-around-trail-step"><span aria-hidden="true">›</span>
          {index === trail.length - 1 ? <span className="is-here" title={item.label}>{item.label}</span> : <button type="button" onClick={() => backTo(index + 1)} title={item.label}>{item.label}</button>}
        </span>)}
        {narrow ? null : <span className="explore-around-legend" aria-hidden="true"><i className="is-mine" />Your notes<i className="is-public" />Public topics</span>}
      </nav>
      {here ? <div className="explore-around-here">
        {here.description ? <p title={here.description}>{here.description}</p> : <p />}
        {centerActions}
      </div> : null}
      {notice ? <p className="explore-around-notice" role="status">{notice}<button type="button" aria-label="Dismiss" onClick={() => setNotice(null)}>×</button></p> : null}
      {narrow ? <div className="explore-around-list" ref={ref}>
        <h3>{innerHeading}</h3>
        {inner.length ? inner.map((item) => <button type="button" key={item.id} className="explore-around-list-mine" onClick={() => onSelect(item.id)}>
          <strong>{titleOf(item.id)}</strong><small>{topic ? "Your note" : item.kind === "linked" ? "Linked" : "Similar"}</small></button>)
          : <p className="explore-around-note">{innerEmpty}</p>}
        <h3>{outerHeading}</h3>
        {outerTopics.map((item) => <button type="button" key={item.id} className="explore-around-list-public" onClick={() => walk(item)}>
          <strong>{item.label}</strong>{item.description ? <small>{item.description}</small> : null}</button>)}
        {status ? <p className="explore-around-note" role="status">{status}{failed ? <> <button type="button" className="explore-around-retry" onClick={() => setRetry(retry + 1)}>Try again</button></> : null}</p> : null}
      </div> : <div className="explore-around" ref={ref}>
        {width ? <>
          <svg className="explore-around-lines" width={width} height={height} aria-hidden="true">
            <ellipse cx={cx} cy={cy} rx={innerX} ry={innerY} className="explore-around-ring" />
            <ellipse cx={cx} cy={cy} rx={outerX} ry={outerY} className="explore-around-ring" />
            {innerPoints.map((point, index) => <line key={inner[index].id} x1={cx} y1={cy} x2={point.x} y2={point.y} className={`explore-around-edge is-${inner[index].kind}`} />)}
            {outerPoints.map((point, index) => <line key={outerTopics[index].id} x1={cx} y1={cy} x2={point.x} y2={point.y} className="explore-around-edge is-public" />)}
          </svg>
          {inner.map((item, index) => <button type="button" key={item.id} className={`explore-around-node is-mine is-${item.kind}`} style={place(innerPoints[index])}
            title={`${titleOf(item.id)}: ${topic ? "your note about it" : item.kind === "linked" ? "linked to this note" : "close in meaning"}`} onClick={() => onSelect(item.id)}>
            <i aria-hidden="true" /><strong>{titleOf(item.id)}</strong><small>{topic ? "your note" : item.kind === "linked" ? "linked" : "similar"}</small>
          </button>)}
          {outerTopics.map((item, index) => <button type="button" key={item.id} className="explore-around-node is-public" style={place(outerPoints[index])}
            title={item.description ? `${item.label}: ${item.description}. Tap to go there.` : `${item.label}. Tap to go there.`} onClick={() => walk(item)}>
            <i aria-hidden="true" /><strong>{item.label}</strong>{item.description ? <small>{item.description}</small> : null}
          </button>)}
          <button type="button" className={`explore-around-center${topic ? " is-public" : ""}`} style={{ left: cx, top: cy }} title={centerTitle}
            onClick={() => { if (!topic) onSelect(center.id); else if (here) actions.onRead(articleOf(here)); }}>
            <strong>{centerTitle}</strong>
          </button>
          {!inner.length ? <p className="explore-around-note is-floating" style={{ left: cx, top: cy + innerY + 10 }}>{topic ? innerEmpty : "No notes link here yet. Link one with [[ in the note."}</p> : null}
          {status ? <p className="explore-around-note is-floating" style={{ left: cx, top: Math.max(20, cy - outerY - 4) }} role="status">{status}</p> : null}
        </> : null}
      </div>}
    </div>
    {reader}
  </div>;
}
