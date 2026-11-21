import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { AROUND_PUBLIC_LIMIT, ringPoints, topicQuery, wikipediaTitlesIn, type AroundNeighbour } from "../lib/aroundRings";
import type { BrowseNode } from "../lib/exploreSources";
import type { PublicTopic } from "../lib/publicKnowledge";
import { expandWikipediaTopic, findWikipediaTopic, resolveWikipediaTitles, wikipediaTitle } from "../lib/wikipedia";
import { useSize } from "./exploreCamera";
import { NodeMenu, pointOf, type ExplorePublicActions } from "./ExplorePublic";
import "./ExploreLibrary.css";

/** Public topics found for a note, kept for this visit so moving back and forth doesn't ask Wikipedia again. */
const publicCache = new Map<string, PublicTopic[]>();

/** Wikipedia topics around a note: the article it links to, or the one its title names, and that article's main links. */
async function publicTopicsFor(title: string, text: string, signal: AbortSignal): Promise<PublicTopic[]> {
  const linked = wikipediaTitlesIn(text);
  let base: PublicTopic | null = null;
  if (linked.length) base = (await resolveWikipediaTitles([linked[0]], signal)).get(linked[0]) ?? null;
  const query = topicQuery(title);
  if (!base && query.length >= 2) base = await findWikipediaTopic(query, signal);
  if (!base) return [];
  const expansion = await expandWikipediaTopic(base, 0, signal);
  return [expansion.topic, ...expansion.topics];
}

function articleOf(topic: PublicTopic) {
  return wikipediaTitle(topic.wikipediaUrl)?.replaceAll("_", " ") ?? topic.label;
}

/**
 * Explore around one note: the note in the middle, your notes linked to it (or close in meaning)
 * on the inner ring, and public topics it touches that are not in your vault on the outer ring.
 * Clicking a note moves the middle there; clicking a public topic opens the topic menu.
 */
export default function AroundRings({ center, neighbours, titleOf, textOf, leading, actions, reader, onSelect }: {
  center: { id: string; title: string };
  neighbours: AroundNeighbour[];
  titleOf: (id: string) => string;
  /** The note's text, to find the Wikipedia articles it links to. */
  textOf: (id: string) => string;
  leading?: ReactNode;
  actions: ExplorePublicActions;
  reader?: ReactNode;
  /** Moves the middle to a note (or opens it beside the page, where the map sits beside one). */
  onSelect: (id: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [ref, size] = useSize<HTMLDivElement>();
  const [found, setFound] = useState<{ key: string; topics: PublicTopic[] } | { key: string; error: true } | null>(null);
  const key = `${center.id}\n${center.title}`;
  useEffect(() => {
    const cached = publicCache.get(key);
    if (cached) { setFound({ key, topics: cached }); return; }
    const controller = new AbortController();
    setFound(null);
    publicTopicsFor(center.title, textOf(center.id), controller.signal).then((topics) => {
      publicCache.set(key, topics);
      while (publicCache.size > 60) publicCache.delete(publicCache.keys().next().value!);
      if (!controller.signal.aborted) setFound({ key, topics });
    }, () => { if (!controller.signal.aborted) setFound({ key, error: true }); });
    return () => controller.abort();
  }, [key]);
  const publicNodes = useMemo<BrowseNode[]>(() => {
    if (!found || found.key !== key || !("topics" in found)) return [];
    const mine = new Set([center.title, ...neighbours.map((item) => titleOf(item.id))].map((title) => title.trim().toLocaleLowerCase()));
    return found.topics.filter((topic) => !mine.has(topic.label.toLocaleLowerCase()) && !actions.noteFor(topic.label, topic))
      .slice(0, AROUND_PUBLIC_LIMIT)
      .map((topic) => ({ id: `around:${topic.id}`, label: topic.label, kind: "article" as const, weight: 1, article: articleOf(topic),
        ...(topic.description ? { summary: topic.description } : {}) }));
  }, [found, key, center.title, neighbours, titleOf, actions]);
  const loading = !found || found.key !== key;
  const failed = !loading && found && "error" in found;

  const [menu, setMenu] = useState<{ node: BrowseNode; x: number; y: number } | null>(null);
  useEffect(() => { setMenu(null); }, [center.id]);
  const pick = (node: BrowseNode, point: { x: number; y: number }) => {
    const box = rootRef.current?.getBoundingClientRect();
    setMenu({ node, x: point.x - (box?.left ?? 0), y: point.y - (box?.top ?? 0) });
  };

  const narrow = size.width > 0 && size.width < 560;
  const { width, height } = size;
  const cx = width / 2, cy = height / 2;
  const innerY = height * 0.25, innerX = Math.min(width * 0.25, innerY * 1.7);
  const outerY = height * 0.41, outerX = Math.min(width * 0.43, outerY * 1.9);
  const inner = ringPoints(neighbours.length, cx, cy, innerX, innerY);
  const outer = ringPoints(publicNodes.length, cx, cy, outerX, outerY, publicNodes.length ? 0.5 / publicNodes.length : 0);
  const place = (point: { x: number; y: number }): CSSProperties => ({ left: Math.max(70, Math.min(width - 70, point.x)), top: Math.max(14, Math.min(height - 64, point.y)) });
  const status = loading ? "Finding public topics on Wikipedia…" : failed ? "Wikipedia could not be reached. Public topics will show when it can." : !publicNodes.length ? "No public topics found for this note." : null;

  return <div ref={rootRef} className={`explore-library is-public is-around${reader ? " has-reader" : ""}`} data-graph-ui="true">
    <div className="explore-public-main">
      <nav className="explore-library-crumbs" aria-label="Where you are in Explore">
        {leading}
        <span className="is-here" title={center.title}>{center.title}</span>
        <span className="explore-around-legend" aria-hidden="true"><i className="is-mine" />Your notes<i className="is-public" />Not in your vault</span>
      </nav>
      {narrow ? <div className="explore-around-list" ref={ref}>
        <button type="button" className="explore-around-list-center" onClick={() => onSelect(center.id)}>{center.title}</button>
        <h3>Linked to this note</h3>
        {neighbours.length ? neighbours.map((item) => <button type="button" key={item.id} className="explore-around-list-mine" onClick={() => onSelect(item.id)}>
          <strong>{titleOf(item.id)}</strong><small>{item.kind === "linked" ? "Linked" : "Similar"}</small></button>)
          : <p className="explore-around-note">No notes link here yet.</p>}
        <h3>Not in your vault yet</h3>
        {publicNodes.map((node) => <button type="button" key={node.id} className="explore-around-list-public" onClick={(event) => pick(node, pointOf(event))}>
          <strong>{node.label}</strong>{node.summary ? <small>{node.summary}</small> : null}</button>)}
        {status ? <p className="explore-around-note" role="status">{status}</p> : null}
      </div> : <div className="explore-around" ref={ref}>
        {width ? <>
          <svg className="explore-around-lines" width={width} height={height} aria-hidden="true">
            <ellipse cx={cx} cy={cy} rx={innerX} ry={innerY} className="explore-around-ring" />
            <ellipse cx={cx} cy={cy} rx={outerX} ry={outerY} className="explore-around-ring" />
            {inner.map((point, index) => <line key={neighbours[index].id} x1={cx} y1={cy} x2={point.x} y2={point.y} className={`explore-around-edge is-${neighbours[index].kind}`} />)}
            {outer.map((point, index) => <line key={publicNodes[index].id} x1={cx} y1={cy} x2={point.x} y2={point.y} className="explore-around-edge is-public" />)}
          </svg>
          {neighbours.map((item, index) => <button type="button" key={item.id} className={`explore-around-node is-mine is-${item.kind}`} style={place(inner[index])}
            title={`${titleOf(item.id)}: ${item.kind === "linked" ? "linked to this note" : "close in meaning"}`} onClick={() => onSelect(item.id)}>
            <i aria-hidden="true" /><strong>{titleOf(item.id)}</strong><small>{item.kind === "linked" ? "linked" : "similar"}</small>
          </button>)}
          {publicNodes.map((node, index) => <button type="button" key={node.id} className="explore-around-node is-public" style={place(outer[index])}
            title={node.summary ? `${node.label}: ${node.summary}` : node.label} onClick={(event) => pick(node, pointOf(event))}>
            <i aria-hidden="true" /><strong>{node.label}</strong><small>not in your vault</small>
          </button>)}
          <button type="button" className="explore-around-center" style={{ left: cx, top: cy }} title={center.title} onClick={() => onSelect(center.id)}>
            <strong>{center.title}</strong>
          </button>
          {!neighbours.length ? <p className="explore-around-note is-floating" style={{ left: cx, top: cy + innerY + 10 }}>No notes link here yet. Link one with [[ in the note.</p> : null}
          {status ? <p className="explore-around-note is-floating" style={{ left: cx, top: Math.max(20, cy - outerY - 4) }} role="status">{status}</p> : null}
        </> : null}
      </div>}
    </div>
    {menu ? <NodeMenu key={menu.node.id} node={menu.node} x={menu.x} y={menu.y} bounds={rootRef.current} sourceKind="wikipedia" actions={actions}
      onClose={() => setMenu(null)} /> : null}
    {reader}
  </div>;
}
