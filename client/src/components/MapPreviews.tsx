import { useEffect, useMemo, useRef, useState } from "react";
import type { MapOverlayContext } from "./ConversationGraphView";
import { exploredChildren, layoutPreviews, parentKey, webAddress, isFullWebAddress, type ExploredItem, type MapExploration, type PreviewBox } from "../lib/mapExploration";
import type { PublicTopic } from "../lib/publicKnowledge";
import type { PublicAnswer, PublicAnswerTopic } from "../lib/publicMapApi";
import { searchWikipediaTopics } from "../lib/wikipedia";
import { PublicTopicInsights, type PublicMapAccount } from "./PublicTopicInsights";
import { fallbackQuestion, wikipediaSearchUrl } from "./MapSearchFallbacks";
import "./PublicKnowledgeMap.css";
import "./TopicSources.css";
import "./MapPreviews.css";

const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;
const hostname = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };
const byTime = (a: ExploredItem, b: ExploredItem) => a.exploredAt.localeCompare(b.exploredAt) || a.label.localeCompare(b.label);

/** A typed question goes to AI first; anything else to Wikipedia first. */
export function looksLikeQuestion(text: string) {
  const value = text.trim();
  return /\?$/.test(value) || /^(who|what|when|where|why|how|which|is|are|does|do|can|should|explain|compare)\b/i.test(value);
}

/** What a preview on the map hangs off: the nearest preview still on the map, or a document. */
export function visibleParent(exploration: MapExploration, item: ExploredItem): ExploredItem["parent"] {
  const seen = new Set([item.id]);
  let parent = item.parent;
  while (parent?.kind === "item") {
    const next = exploration.items[parent.id];
    if (!next || seen.has(parent.id)) return null;
    if (next.onMap) return parent;
    seen.add(parent.id);
    parent = next.parent;
  }
  return parent;
}

const CHECK = <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>;
const CLOSE = <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" /></svg>;

/**
 * Dashed cards beside the map for what was explored but not kept. They sit in
 * screen pixels next to the document they came from, so they stay readable at
 * any zoom and never move the person's own layout.
 */
export function MapPreviewLayer({ context, exploration, selectedId, revealRequest, panelOpen = false, onSelect, onKeep, onHide }: {
  context: MapOverlayContext;
  exploration: MapExploration;
  selectedId: string | null;
  /** A side panel covers the right of the map (a bottom sheet on phones), so revealing avoids it. */
  panelOpen?: boolean;
  /** Pans the map to these previews once they are drawn. */
  revealRequest: { ids: string[]; requestId: number } | null;
  onSelect(id: string): void;
  onKeep(id: string): void;
  onHide(id: string): void;
}) {
  const layout = useMemo(() => {
    const shown = Object.values(exploration.items).filter((item) => item.onMap).sort(byTime);
    const parentOf = new Map(shown.map((item) => [item.id, visibleParent(exploration, item)]));
    const children = new Map<string, string[]>();
    const groups = new Map<string, { anchor: PreviewBox; rootIds: string[] }>();
    for (const item of shown) {
      const parent = parentOf.get(item.id) ?? null;
      if (parent?.kind === "item") { children.set(parent.id, [...children.get(parent.id) ?? [], item.id]); continue; }
      const box = parent ? context.nodeBox(parent.id) : null;
      const key = parent && box ? parentKey(parent) : "open";
      const group = groups.get(key) ?? { anchor: box ?? { ...context.openSpace, width: 0, height: 0 }, rootIds: [] };
      group.rootIds.push(item.id);
      groups.set(key, group);
    }
    // Groups higher on screen are placed first; lower ones move down to make room.
    const ordered = [...groups.entries()].sort(([, a], [, b]) => a.anchor.y - b.anchor.y);
    const boxes = layoutPreviews(ordered.map(([, group]) => group), (id) => children.get(id) ?? []);
    const anchors = new Map(ordered.map(([key, group]) => [key, group.anchor]));
    return { boxes, parentOf, anchors };
  }, [exploration, context]);
  const latest = useRef({ layout, context, panelOpen });
  latest.current = { layout, context, panelOpen };

  useEffect(() => {
    if (!revealRequest) return;
    const { layout: current, context: map, panelOpen: covered } = latest.current;
    const boxes = revealRequest.ids.flatMap((id) => current.boxes.get(id) ?? []);
    if (!boxes.length) return;
    const left = Math.min(...boxes.map((box) => box.x)), top = Math.min(...boxes.map((box) => box.y));
    const right = Math.max(...boxes.map((box) => box.x + box.width)), bottom = Math.max(...boxes.map((box) => box.y + box.height));
    // The panel's side of the map counts as out of view.
    const wide = map.size.width > 760;
    const inset = covered ? wide ? { right: 384, bottom: 0 } : { right: 0, bottom: Math.round(map.size.height * 0.7) + 8 } : { right: 0, bottom: 0 };
    // Room below for the previews bar.
    map.reveal({ x: left, y: top, width: right - left + inset.right, height: bottom - top + inset.bottom + 48 });
  }, [revealRequest?.requestId]);

  const { width, height } = context.size;
  const inView = (box: PreviewBox) => box.x + box.width > -40 && box.x < width + 40 && box.y + box.height > -40 && box.y < height + 40;
  const edges: Array<{ id: string; path: string }> = [];
  for (const [id, box] of layout.boxes) {
    const parent = layout.parentOf.get(id);
    const from = parent?.kind === "item" ? layout.boxes.get(parent.id) : parent ? layout.anchors.get(parentKey(parent)) : undefined;
    if (!from || (!inView(box) && !inView(from))) continue;
    const x1 = from.x + from.width, y1 = from.y + from.height / 2, x2 = box.x, y2 = box.y + box.height / 2;
    const bend = Math.max(18, (x2 - x1) / 2);
    edges.push({ id, path: `M${x1} ${y1}C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}` });
  }

  return <div className="map-previews" aria-label="Previews not in your workspace">
    <svg className="map-preview-edges" width={width} height={height} aria-hidden="true">
      {edges.map((edge) => <path key={edge.id} d={edge.path} />)}
    </svg>
    {[...layout.boxes].filter(([, box]) => inView(box)).map(([id, box]) => {
      const item = exploration.items[id];
      const selected = selectedId === id;
      return <div key={id} className={`map-preview-card${selected ? " is-selected" : ""}`} data-graph-ui="true" data-preview-kind={item.source.kind}
        style={{ transform: `translate(${Math.round(box.x)}px, ${Math.round(box.y)}px)`, width: box.width, height: box.height }}>
        <button type="button" className="map-preview-open" aria-pressed={selected} title={item.detail || item.label} onClick={() => onSelect(id)}>
          <strong>{item.label}</strong><span>{item.via}</span>
        </button>
        <button type="button" className="map-preview-action is-keep" aria-label={`Keep ${item.label} in my map`} title="Keep in my map" onClick={() => onKeep(id)}>{CHECK}</button>
        <button type="button" className="map-preview-action" aria-label={`Remove ${item.label} from the map`} title="Remove from the map. It stays in history." onClick={() => onHide(id)}>{CLOSE}</button>
      </div>;
    })}
  </div>;
}

/** How many previews are out, and the two things to do with all of them. */
export function MapPreviewBar({ count, onKeepAll, onClear }: { count: number; onKeepAll(): void; onClear(): void }) {
  return <div className="map-preview-bar" data-graph-ui="true" role="group" aria-label="Previews on the map">
    <span><strong>{count}</strong> {count === 1 ? "preview" : "previews"} <em>not in your workspace</em></span>
    <button type="button" onClick={onKeepAll}>Keep all</button>
    <button type="button" onClick={onClear} title="They stay in history">Clear from map</button>
  </div>;
}

/** The side panel for one preview: what it is, where it came from, and keeping it. */
export function MapPreviewDetails({ item, exploration, anchorTitle, account, onClose, onKeep, onKeepAlone, onToggleMap, onForget, onShowConnections, onAsk, onPreviewAnswer, onPreviewTopic }: {
  item: ExploredItem;
  exploration: MapExploration;
  /** The document keeping it connects to. */
  anchorTitle: string | null;
  account?: PublicMapAccount;
  onClose(): void;
  onKeep(): void;
  onKeepAlone(): void;
  onToggleMap(): void;
  onForget(): void;
  onShowConnections(): void;
  onAsk(question: string): void;
  onPreviewAnswer(answer: PublicAnswer): void;
  onPreviewTopic(topic: PublicAnswerTopic): void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const [question, setQuestion] = useState("");
  useEffect(() => { setQuestion(""); panelRef.current?.focus({ preventScroll: true }); }, [item.id]);
  const source = item.source;
  const expansion = exploration.expansions[`item:${item.id}`];
  const page = source.kind === "page" ? exploration.pages[source.url] : undefined;
  const node = source.kind === "page" ? page?.nodes.find((candidate) => candidate.id === source.nodeId) : undefined;
  const parentPreview = item.parent?.kind === "item" ? exploration.items[item.parent.id] : undefined;
  const joins = parentPreview ? `Keeping it also keeps ${parentPreview.label}, which connects it to your map.`
    : anchorTitle ? `Keeping it connects it to ${anchorTitle}.` : "Keeping it adds it to your map as a new note.";

  return <aside ref={panelRef} tabIndex={-1} className="public-map-sidebar map-topic-sources map-preview-details" aria-label={`Preview of ${item.label}`}
    onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <header className="map-topic-sources-header">
      <div><span className="public-map-eyebrow">Preview · not in your workspace</span><h3>{item.label}</h3></div>
      <button type="button" aria-label="Close preview" title="Close" onClick={onClose}>×</button>
    </header>
    <div className="map-topic-sources-scroll">
      <p className="map-preview-via">{item.via}</p>
      <div className="topic-sources-actions map-preview-keep-actions">
        <button type="button" className="public-map-primary" onClick={onKeep}>Keep in my map</button>
        {anchorTitle && !parentPreview ? <button type="button" onClick={onKeepAlone}>Keep without connecting</button> : null}
        <button type="button" onClick={onToggleMap}>{item.onMap ? "Remove from map" : "Show on map"}</button>
      </div>
      <p className="public-map-small">{joins} {item.onMap ? "Removing it from the map keeps it in history." : "It is in your history, not on the map."}</p>
      {source.kind === "topic" ? <>
        <div className="topic-sources-actions">
          {!expansion || expansion.hasMore ? <button type="button" onClick={onShowConnections}>{expansion ? "Show more connections" : "Show its connections"}</button> : <span className="public-map-muted">All its Wikipedia connections are shown.</span>}
          {source.topic.wikipediaUrl ? <a className="map-preview-link" href={source.topic.wikipediaUrl} target="_blank" rel="noreferrer noopener">Wikipedia ↗</a> : null}
        </div>
        {source.topic.description ? <p className="public-map-muted">{source.topic.description}</p> : null}
        {account ? <PublicTopicInsights topic={source.topic} account={account} onAnswered={onPreviewAnswer} onShowOnMap={onPreviewAnswer} onOpenTopic={(_id, topic) => onPreviewTopic(topic)} />
          : <p className="public-map-small">Wikipedia is free for everyone.</p>}
      </> : null}
      {source.kind === "page" && page && node ? <section className="map-preview-page" aria-label="From the page">
        <p>{node.summary}</p>
        <h4>Supporting passage</h4>
        <blockquote>{node.evidence.quote}</blockquote>
        <p className="public-map-small"><a href={page.source.url} target="_blank" rel="noreferrer noopener">{page.source.title || hostname(page.source.url)} ↗</a> AI-generated summary of the page. Check the source before relying on it.</p>
      </section> : null}
      {source.kind === "answer" ? <section className="public-answer map-preview-answer" aria-label="AI answer">
        <strong className="public-answer-question">{source.answer.question}</strong>
        <p className="public-answer-text">{source.answer.answer}</p>
        <div className="public-answer-meta"><span>AI answer · not checked against sources · only you see it</span></div>
      </section> : null}
      {source.kind !== "topic" ? <section className="public-answers" aria-label={`Ask AI about ${item.label}`}>
        <h4>Ask AI</h4>
        {account?.canAsk ? <form className="public-ask" onSubmit={(event) => { event.preventDefault(); if (question.trim().length >= 3) { onAsk(question.trim()); setQuestion(""); } }}>
          <label htmlFor={`map-preview-ask-${item.id}`}>Your question about {item.label}</label>
          <textarea id={`map-preview-ask-${item.id}`} value={question} maxLength={500} rows={2} onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
          <div><span>The answer appears on the map beside it. Only you see it.</span>
            <button type="submit" className="public-map-primary" disabled={question.trim().length < 3}>Ask AI</button></div>
        </form> : <p className="public-map-muted">Members with a subscription or credit can ask AI.</p>}
      </section> : null}
      <p className="public-map-small"><button type="button" className="topic-sources-link" onClick={onForget}>Forget it</button> removes it from history too.</p>
    </div>
  </aside>;
}

/** Everything explored and not kept, newest first, grouped by what found it. */
export function MapExploredHistory({ exploration, selectedId, onClose, onSelect, onSetOnMap, onKeep, onForget }: {
  exploration: MapExploration;
  selectedId: string | null;
  onClose(): void;
  onSelect(id: string): void;
  onSetOnMap(ids: string[], onMap: boolean): void;
  onKeep(ids: string[]): void;
  onForget(ids: string[]): void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const [filter, setFilter] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  useEffect(() => { panelRef.current?.focus({ preventScroll: true }); }, []);
  const items = Object.values(exploration.items);
  const needle = filter.trim().toLowerCase();
  const batches = useMemo(() => {
    const byBatch = new Map<string, ExploredItem[]>();
    for (const item of Object.values(exploration.items)) byBatch.set(item.batchId, [...byBatch.get(item.batchId) ?? [], item]);
    return [...byBatch.entries()].map(([id, list]) => {
      // Within a batch, each item follows the one it came from.
      const inBatch = new Set(list.map((item) => item.id));
      const children = exploredChildren(list.map((item) => item.parent?.kind === "item" && inBatch.has(item.parent.id) ? item : { ...item, parent: null }));
      const rows: Array<{ item: ExploredItem; depth: number }> = [];
      const seen = new Set<string>();
      const visit = (item: ExploredItem, depth: number) => {
        if (seen.has(item.id)) return;
        seen.add(item.id); rows.push({ item, depth });
        for (const child of children.get(`item:${item.id}`) ?? []) visit(child, depth + 1);
      };
      for (const root of children.get("root") ?? []) visit(root, 0);
      const batch = exploration.batches[id] ?? { id, title: "Explored", createdAt: list[0].exploredAt };
      return { batch, rows: rows.map((row) => ({ ...row, item: exploration.items[row.item.id] })) };
    }).sort((a, b) => b.batch.createdAt.localeCompare(a.batch.createdAt));
  }, [exploration]);
  const shown = needle ? batches.map((group) => ({ ...group, rows: group.rows.filter(({ item }) => `${item.label} ${item.detail} ${item.via}`.toLowerCase().includes(needle)) })).filter((group) => group.rows.length) : batches;

  return <aside ref={panelRef} tabIndex={-1} className="public-map-sidebar map-topic-sources map-explored-history" aria-label="Explored history"
    onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <header className="map-topic-sources-header">
      <div><span className="public-map-eyebrow">Explored, not in your workspace</span><h3>History</h3></div>
      <button type="button" aria-label="Close history" title="Close" onClick={onClose}>×</button>
    </header>
    <div className="map-topic-sources-scroll">
      {!items.length ? <p className="public-map-muted map-history-empty">Nothing here yet. Search Wikipedia, ask AI, or paste a link in the map search. What you preview stays here until you keep it or forget it.</p> : <>
        <label className="topic-sources-search"><span className="topic-sources-visually-hidden">Filter history</span>
          <input type="search" value={filter} placeholder="Filter history" onChange={(event) => setFilter(event.target.value)} /></label>
        <p className="public-map-small">{items.length} explored · {items.filter((item) => item.onMap).length} on the map. Nothing here is removed unless you forget it.</p>
        {shown.map(({ batch, rows }) => {
          const ids = rows.map(({ item }) => item.id);
          const allShown = rows.every(({ item }) => item.onMap);
          return <section key={batch.id} className="map-history-batch" aria-label={batch.title}>
            <header>
              <div><h4>{batch.title}</h4><time dateTime={batch.createdAt}>{new Date(batch.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time></div>
              <button type="button" onClick={() => onSetOnMap(ids, !allShown)}>{allShown ? "Hide" : "Show"}</button>
              <button type="button" onClick={() => onKeep(ids)}>Keep all</button>
              <button type="button" aria-label={`Forget ${batch.title}`} title="Forget" onClick={() => onForget(ids)}>×</button>
            </header>
            <ul>{rows.map(({ item, depth }) => <li key={item.id} className={`${item.onMap ? "is-on-map" : ""}${selectedId === item.id ? " is-selected" : ""}`} style={{ paddingLeft: `${Math.min(depth, 4) * 14}px` }}>
              <button type="button" className="map-history-item" onClick={() => onSelect(item.id)}><strong>{item.label}</strong><span>{item.via}</span></button>
              <button type="button" className="map-history-toggle" aria-pressed={item.onMap} aria-label={item.onMap ? `Hide ${item.label} from the map` : `Show ${item.label} on the map`}
                title={item.onMap ? "On the map. Click to hide." : "Show on the map"} onClick={() => onSetOnMap([item.id], !item.onMap)}>
                <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="2.6" /></svg></button>
              <button type="button" className="map-history-toggle" aria-label={`Keep ${item.label} in my map`} title="Keep in my map" onClick={() => onKeep([item.id])}>{CHECK}</button>
              <button type="button" className="map-history-toggle" aria-label={`Forget ${item.label}`} title="Forget" onClick={() => onForget([item.id])}>{CLOSE}</button>
            </li>)}</ul>
          </section>;
        })}
        {needle && !shown.length ? <p className="public-map-muted">Nothing in history matches “{filter.trim()}”.</p> : null}
        <div className="map-history-clear">{confirmClear ? <>
          <span>Forget all {items.length}? This cannot be undone.</span>
          <button type="button" onClick={() => { onForget(items.map((item) => item.id)); setConfirmClear(false); }}>Forget all</button>
          <button type="button" onClick={() => setConfirmClear(false)}>Cancel</button>
        </> : <button type="button" onClick={() => setConfirmClear(true)}>Clear history…</button>}</div>
      </>}
    </div>
  </aside>;
}

/**
 * The rest of the map search's results: what the box read in the text. A link
 * can be mapped or saved; words find Wikipedia articles; questions go to AI.
 */
export function MapSearchLookFurther({ query, matchedCount, canAsk, onMapPage, onSaveSource, onPreviewTopic, onAsk }: {
  query: string;
  matchedCount: number;
  canAsk: boolean;
  onMapPage(url: string): void;
  onSaveSource(url: string): void;
  onPreviewTopic(topic: PublicTopic): void;
  onAsk(question: string): void;
}) {
  const text = query.trim();
  const url = webAddress(text);
  const onlyLink = isFullWebAddress(text);
  const question = looksLikeQuestion(text);
  const [results, setResults] = useState<{ query: string; topics: PublicTopic[]; error?: string } | null>(null);
  useEffect(() => {
    if (onlyLink || text.length < 2) { setResults(null); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      searchWikipediaTopics(text, controller.signal)
        .then((topics) => { if (!controller.signal.aborted) setResults({ query: text, topics: topics.slice(0, 4) }); })
        .catch((error: unknown) => { if (!controller.signal.aborted) setResults({ query: text, topics: [], error: errorMessage(error, "Wikipedia could not be reached.") }); });
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [text, onlyLink]);
  if (text.length < 2) return null;
  const members = canAsk ? null : <em className="map-search-fallback-tag">Members</em>;
  const free = <em className="map-search-fallback-tag is-free">Free</em>;
  const current = results?.query === text ? results : null;
  const ask = <button type="button" key="ask" className="map-look-further-option" disabled={!canAsk} onClick={() => onAsk(fallbackQuestion(text))}>
    <span><strong>Ask AI: “{fallbackQuestion(text)}”</strong><small>The answer and the topics it names appear on your map as previews.</small></span>{members}</button>;
  const wikipedia = <div key="wikipedia" className="map-look-further-wikipedia" aria-busy={!current}>
    <p className="map-look-further-heading">Wikipedia {free}</p>
    {!current ? <p className="map-look-further-note">Searching Wikipedia…</p>
      : current.error ? <p className="map-look-further-note" role="alert">{current.error}</p>
      : !current.topics.length ? <p className="map-look-further-note">No Wikipedia article matches “{text}”.</p>
      : current.topics.map((topic) => <button type="button" key={topic.id} className="map-look-further-option" onClick={() => onPreviewTopic(topic)}>
        <span><strong>{topic.label}</strong><small>{topic.description || "Wikipedia article"}</small></span><em className="map-look-further-verb">Preview</em></button>)}
    <a className="map-look-further-note" href={wikipediaSearchUrl(text)} target="_blank" rel="noreferrer noopener">Search Wikipedia for “{text}” ↗</a>
  </div>;
  return <div className="map-look-further" role="group" aria-label={`Look further for ${text}`}>
    <p className="map-look-further-heading">{onlyLink ? "Web address" : matchedCount ? "Look further" : "Not in your map yet"}</p>
    {url ? <div className="map-look-further-link">
      <button type="button" className="map-look-further-option" disabled={!canAsk} onClick={() => onMapPage(url)}>
        <span><strong>Map this page</strong><small>AI reads {hostname(url)} and previews its main topics on your map.</small></span>{members}</button>
      <button type="button" className="map-look-further-option" onClick={() => onSaveSource(url)}>
        <span><strong>Save as a source note</strong><small>A linked note with room for your notes.</small></span>{free}</button>
      <a className="map-look-further-note" href={url} target="_blank" rel="noreferrer noopener">Open {hostname(url)} ↗</a>
    </div> : null}
    {onlyLink ? null : question ? [ask, wikipedia] : [wikipedia, ask]}
  </div>;
}
