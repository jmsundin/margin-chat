import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type { Conversation } from "../types";
import { clampUrlMapZoom, findSavedUrlMapNode, fitUrlMapZoom, isUrlMapGraph, layoutUrlMap, projectUrlMap, requestUrlMap, URL_MAP_MAX_ZOOM, URL_MAP_MIN_ZOOM, type UrlMapAIOptions, type UrlMapGraph, type UrlMapNode } from "../lib/urlMap";
import "./UrlMapPanel.css";

interface Props {
  workspaceKey: string;
  conversations: Record<string, Conversation>;
  aiOptions?: UrlMapAIOptions;
  onSave?: (graph: UrlMapGraph, nodeId: string) => void;
  onShowInMyMap: (id: string) => void;
  onExplorePublic: (query: string) => void;
}
function initialMaps(key: string): UrlMapGraph[] {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(`margin-url-maps:${key}`) ?? "[]");
    return Array.isArray(saved) ? saved.filter(isUrlMapGraph).slice(-8) : [];
  } catch { return []; }
}

export default function UrlMapPanel(props: Props) {
  const [maps, setMaps] = useState(() => initialMaps(props.workspaceKey));
  const [index, setIndex] = useState(() => Math.max(0, maps.length - 1));
  const [url, setUrl] = useState("");
  const [focus, setFocus] = useState("");
  const [formOpen, setFormOpen] = useState(() => maps.length === 0);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const controller = useRef<AbortController | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { try { sessionStorage.setItem(`margin-url-maps:${props.workspaceKey}`, JSON.stringify(maps)); } catch { /* Browsing still works when storage is full. */ } }, [maps, props.workspaceKey]);

  async function mapPage(address = url, topicFocus = focus) {
    if (controller.current) return;
    try {
      const candidate = new URL(address);
      if (!["http:", "https:"].includes(candidate.protocol)) throw new Error();
    } catch { setError("Enter a complete http or https web address."); return; }
    const current = new AbortController(); controller.current = current;
    setUrl(address); setFocus(topicFocus); setError(""); setNotice(""); setProgress("Reading the webpage…");
    try {
      const graph = await requestUrlMap({ ...props.aiOptions, url: address, focus: topicFocus, expectedUserId: props.workspaceKey, signal: current.signal, onProgress: (message) => { if (controller.current === current && !current.signal.aborted) setProgress(message); } });
      if (current.signal.aborted) return;
      const next = [...maps.slice(0, index + 1), graph].slice(-8);
      setMaps(next); setIndex(next.length - 1); setFormOpen(false); setNotice(`Mapped ${graph.nodes.length} topics from one page.`);
      titleRef.current?.focus({ preventScroll: true });
    } catch (failure) {
      if (!current.signal.aborted) { setFormOpen(true); setError(failure instanceof Error ? failure.message : "The page could not be mapped. Try again."); }
    } finally {
      if (controller.current === current) { controller.current = null; setProgress(""); }
    }
  }
  function stop() {
    controller.current?.abort(); controller.current = null; setProgress(""); setNotice("Stopped. Your previous maps are still available.");
  }

  return <section className="url-map-panel" aria-label="Map a URL">
    <div className="url-map-intro"><h2 ref={titleRef} tabIndex={-1}>Map a URL</h2>{maps.length ? <button type="button" aria-expanded={formOpen} disabled={Boolean(progress)} onClick={() => setFormOpen(!formOpen)}>{formOpen ? "Hide URL form" : "Map another URL"}</button> : <p>Turn a webpage into connected topics. Follow a link when you’re ready to go deeper.</p>}</div>
    {formOpen || !maps.length || progress ? <form className="url-map-form" onSubmit={(event) => { event.preventDefault(); void mapPage(); }}>
      <label>Webpage URL<input type="url" required maxLength={2048} placeholder="https://example.com/article" value={url} onChange={(event) => setUrl(event.target.value)} disabled={Boolean(progress)} /></label>
      <label>Focus <span>(optional)</span><input maxLength={500} placeholder="e.g. the underlying science" value={focus} onChange={(event) => setFocus(event.target.value)} disabled={Boolean(progress)} /></label>
      <button type="submit" className="url-map-primary" disabled={Boolean(progress)}>Map this page</button>
      {progress ? <button type="button" onClick={stop}>Stop</button> : null}
      <small>Reads one public page using your AI settings. Hosted AI usage applies. Save topics you want to keep.</small>
    </form> : null}
    <div className="url-map-status" role="status" aria-live="polite">{progress || notice}</div>
    {error ? <p className="url-map-error" role="alert">{error}</p> : null}
    {maps.length ? <>
      <nav className="url-map-history" aria-label="URL map history">
        <button type="button" disabled={index === 0 || Boolean(progress)} onClick={() => setIndex(index - 1)}>← Previous page</button>
        <span>Page {index + 1} of {maps.length}</span>
        <button type="button" disabled={index === maps.length - 1 || Boolean(progress)} onClick={() => setIndex(index + 1)}>Next page →</button>
        <a href={maps[index].source.url} target="_blank" rel="noreferrer">Open source ↗</a>
      </nav>
      {maps.map((graph, graphIndex) => <div key={`${graph.source.url}-${graph.source.retrievedAt}-${graphIndex}`} className="url-map-result-container" hidden={graphIndex !== index}>
        <UrlMapResult graph={graph} {...props} busy={Boolean(progress)} onMapLink={(address, topic) => { void mapPage(address, topic); }} />
      </div>)}
    </> : <div className="url-map-empty"><div aria-hidden="true">◎ — ○ — ○</div><h3>Start with one page. Find the connections.</h3><p>Get a small topic map, inspect the supporting passages, and add useful ideas to My map.</p><p>Articles and documentation work best. Pages that require sign-in or JavaScript may not be readable.</p></div>}
  </section>;
}

function UrlMapResult({ graph, conversations, onSave, onShowInMyMap, onExplorePublic, onMapLink, busy }: Props & { graph: UrlMapGraph; busy: boolean; onMapLink: (url: string, focus: string) => void }) {
  const [selectedId, setSelectedId] = useState(graph.rootId);
  const [edgeId, setEdgeId] = useState<string | null>(null);
  const [showLinks, setShowLinks] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [detailsOpen, setDetailsOpen] = useState(() => !window.matchMedia("(max-width: 800px)").matches);
  const [detailsWidth, setDetailsWidth] = useState(320);
  const result = useRef<HTMLDivElement>(null);
  const inspector = useRef<HTMLElement>(null), viewport = useRef<HTMLDivElement>(null);
  const linkedPages = useRef<HTMLDivElement>(null);
  const arrowId = `url-map-arrow-${useId()}`;
  const detailsId = `url-map-details-${useId()}`;
  const fitted = useRef(false);
  const zoomRef = useRef(zoom);
  const pendingScroll = useRef<{ left: number; top: number } | null>(null);
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef({ moved: false, distance: 0, x: 0, y: 0 });
  const suppressClickUntil = useRef(0);
  const resize = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const layout = useMemo(() => layoutUrlMap(graph), [graph]);
  const scene = useMemo(() => projectUrlMap(layout, zoom), [layout, zoom]);
  const selected = graph.nodes.find((node) => node.id === selectedId)!;
  const edge = graph.edges.find((item) => item.id === edgeId);
  const saved = findSavedUrlMapNode(conversations, selected);
  useEffect(() => {
    if (showLinks && !edgeId && detailsOpen) revealLinkedPages();
    else if (inspector.current) inspector.current.scrollTop = 0;
  }, [selectedId, edgeId, showLinks, detailsOpen]);
  useLayoutEffect(() => {
    if (pendingScroll.current && viewport.current) {
      viewport.current.scrollLeft = pendingScroll.current.left;
      viewport.current.scrollTop = pendingScroll.current.top;
      pendingScroll.current = null;
    }
  }, [zoom]);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      if (!fitted.current && element.clientWidth > 0 && element.clientHeight > 0) {
        fitted.current = true;
        zoomRef.current = fitUrlMapZoom(layout, element.clientWidth, element.clientHeight);
        setZoom(zoomRef.current);
      }
      keepSelectionVisible();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [layout]);
  // The details dock takes layout space, so only pan if resizing it clips the selected topic.
  const selectionRef = useRef(selectedId);
  selectionRef.current = selectedId;
  function keepSelectionVisible() {
    const element = viewport.current;
    if (!element || element.clientWidth <= 0 || element.clientHeight <= 0) return;
    const node = projectUrlMap(layout, zoomRef.current).nodes.find((item) => item.id === selectionRef.current)!;
    const margin = 12;
    if (node.x < element.scrollLeft + margin) element.scrollLeft = Math.max(0, node.x - margin);
    else if (node.x + node.width > element.scrollLeft + element.clientWidth - margin) element.scrollLeft = node.x + node.width - element.clientWidth + margin;
    if (node.y < element.scrollTop + margin) element.scrollTop = Math.max(0, node.y - margin);
    else if (node.y + node.height > element.scrollTop + element.clientHeight - margin) element.scrollTop = node.y + node.height - element.clientHeight + margin;
  }
  useLayoutEffect(() => { keepSelectionVisible(); }, [detailsOpen, detailsWidth]);
  function select(node: UrlMapNode) { setSelectedId(node.id); setEdgeId(null); setShowLinks(false); setDetailsOpen(true); }
  function save(node: UrlMapNode) {
    const existing = findSavedUrlMapNode(conversations, node);
    if (existing) onShowInMyMap(existing.id); else onSave?.(graph, node.id);
  }
  function revealLinkedPages() {
    const panel = inspector.current, section = linkedPages.current;
    if (panel && section) panel.scrollTop += section.getBoundingClientRect().top - panel.getBoundingClientRect().top - 12;
  }
  function links(node: UrlMapNode) {
    if (selectedId === node.id && !edgeId && showLinks) revealLinkedPages();
    setSelectedId(node.id); setEdgeId(null); setShowLinks(true); setDetailsOpen(true);
  }
  function changeZoom(next: number, point?: { x: number; y: number }, previousPoint = point) {
    const element = viewport.current;
    if (!element) return;
    const target = clampUrlMapZoom(next), previous = zoomRef.current;
    const anchor = point ?? { x: element.clientWidth / 2, y: element.clientHeight / 2 };
    const prior = previousPoint ?? anchor;
    const scroll = {
      left: Math.max(0, (element.scrollLeft + prior.x) * target / previous - anchor.x),
      top: Math.max(0, (element.scrollTop + prior.y) * target / previous - anchor.y),
    };
    zoomRef.current = target;
    if (target === previous) { element.scrollLeft = scroll.left; element.scrollTop = scroll.top; }
    else { pendingScroll.current = scroll; setZoom(target); }
  }
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      changeZoom(zoomRef.current * Math.exp(-event.deltaY * 0.006), { x: event.clientX - rect.left, y: event.clientY - rect.top });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);
  function touchPosition() {
    const points = [...touches.current.values()].slice(0, 2);
    return { x: points.reduce((sum, point) => sum + point.x, 0) / points.length, y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
      distance: points.length === 2 ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : 0 };
  }
  function moveTouch(event: ReactPointerEvent<HTMLDivElement>) {
    if (!touches.current.has(event.pointerId)) return;
    touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const current = touchPosition(), previous = gesture.current;
    if (!previous.moved && Math.hypot(current.x - previous.x, current.y - previous.y) < 5 && Math.abs(current.distance - previous.distance) < 5) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = event.currentTarget.getBoundingClientRect();
    changeZoom(previous.distance && current.distance ? zoomRef.current * current.distance / previous.distance : zoomRef.current,
      { x: current.x - rect.left, y: current.y - rect.top }, { x: previous.x - rect.left, y: previous.y - rect.top });
    gesture.current = { ...current, moved: true };
  }
  function endTouch(event: ReactPointerEvent<HTMLDivElement>) {
    if (!touches.current.delete(event.pointerId)) return;
    if (gesture.current.moved) suppressClickUntil.current = Date.now() + 400;
    if (touches.current.size) gesture.current = { ...touchPosition(), moved: gesture.current.moved };
    else gesture.current = { moved: false, distance: 0, x: 0, y: 0 };
  }
  function fit() {
    if (viewport.current) {
      zoomRef.current = fitUrlMapZoom(layout, viewport.current.clientWidth, viewport.current.clientHeight);
      pendingScroll.current = { left: 0, top: 0 };
      setZoom(zoomRef.current);
      viewport.current.scrollLeft = 0; viewport.current.scrollTop = 0;
    }
  }
  function clampDetailsWidth(width: number) { return Math.max(260, Math.min(520, (result.current?.clientWidth ?? 900) - 260, width)); }
  return <div ref={result} className={`url-map-result ${detailsOpen ? "has-details" : "details-collapsed"}`} style={{ "--url-map-details-width": `${detailsWidth}px` } as CSSProperties}>
    <div className="url-map-canvas-column">
      <div className="url-map-canvas-tools"><strong title={graph.source.title}>{graph.source.title}</strong><div role="group" aria-label="Map zoom">
        <button type="button" aria-label="Zoom out" disabled={zoom <= URL_MAP_MIN_ZOOM} onClick={() => changeZoom(zoomRef.current - 0.15)}>−</button><span>{Math.round(zoom * 100)}%</span><button type="button" aria-label="Zoom in" disabled={zoom >= URL_MAP_MAX_ZOOM} onClick={() => changeZoom(zoomRef.current + 0.15)}>+</button><button type="button" title="Fit the map while keeping topic titles readable" onClick={fit}>Fit</button>
        <button type="button" className="url-map-details-toggle" aria-expanded={detailsOpen} aria-controls={detailsId} onClick={() => setDetailsOpen(!detailsOpen)}>Details</button>
      </div></div>
      <div ref={viewport} className="url-map-viewport" tabIndex={0} aria-label="Topic graph. Arrow keys pan, plus and minus zoom, F fits. Drag with one finger or pinch with two. Select a topic or relationship for details."
        onKeyDown={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey) return;
          if (event.key === "Escape") { setDetailsOpen(false); viewport.current?.focus(); return; }
          if (event.target !== event.currentTarget) return;
          const step = event.shiftKey ? 120 : 60;
          const pan: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
          if (pan[event.key]) { event.preventDefault(); event.currentTarget.scrollLeft += pan[event.key][0]; event.currentTarget.scrollTop += pan[event.key][1]; }
          else if (["+", "=", "-", "_"].includes(event.key)) { event.preventDefault(); changeZoom(zoomRef.current + (["-", "_"].includes(event.key) ? -0.15 : 0.15)); }
          else if (["f", "F", "0", "Home"].includes(event.key)) { event.preventDefault(); fit(); }
        }}
        onPointerDown={(event) => {
          if (event.pointerType !== "touch") return;
          touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
          gesture.current = { ...touchPosition(), moved: touches.current.size > 1 || gesture.current.moved };
        }} onPointerMove={moveTouch} onPointerUp={endTouch} onPointerCancel={endTouch} onLostPointerCapture={(event) => { if (event.target === event.currentTarget) endTouch(event); }}
        onClickCapture={(event) => { if (Date.now() < suppressClickUntil.current) { event.preventDefault(); event.stopPropagation(); } }}>
          <div className={`url-map-world ${zoom < 0.8 ? "is-overview" : ""} ${zoom < 1 ? "hide-summaries" : ""}`} style={{ width: scene.width, height: scene.height, "--url-map-title-size": `${Math.max(13, 14.4 * zoom)}px` } as CSSProperties}>
            <svg width={scene.width} height={scene.height} className="url-map-edges" aria-label="Topic relationships">
              <defs><marker id={arrowId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10Z" /></marker></defs>
              {graph.edges.map((relation) => {
                const source = scene.nodes.find((node) => node.id === relation.sourceId)!, target = scene.nodes.find((node) => node.id === relation.targetId)!;
                const forward = target.x > source.x, sameColumn = target.x === source.x;
                const x1 = source.x + (forward || sameColumn ? source.width : 0), x2 = target.x + (forward ? 0 : target.width), y1 = source.y + source.height / 2, y2 = target.y + target.height / 2;
                const bend = sameColumn ? 90 * zoom : Math.abs(x2 - x1) / 2;
                const d = `M${x1},${y1} C${x1 + (forward || sameColumn ? bend : -bend)},${y1} ${x2 + (forward ? -bend : bend)},${y2} ${x2},${y2}`;
                const activate = () => { setEdgeId(relation.id); setShowLinks(false); setDetailsOpen(true); };
                return <g key={relation.id} role="button" tabIndex={0} aria-label={`${source.label} ${relation.label} ${target.label}${relation.kind === "suggested" ? ", AI suggested" : ""}`} onClick={activate} onKeyDown={(event) => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); activate(); } }} className={`${relation.kind === "suggested" ? "is-suggested" : ""} ${edgeId === relation.id ? "is-selected" : ""}`}>
                  <path className="url-map-edge-hit" d={d} /><path className="url-map-edge-line" d={d} markerEnd={`url(#${arrowId})`} />
                  {zoom >= 0.8 ? <text x={sameColumn ? x1 + 64 * zoom : (x1 + x2) / 2} y={(y1 + y2) / 2 - 8}>{relation.label.length > 24 ? `${relation.label.slice(0, 22)}…` : relation.label}</text> : null}
                </g>;
              })}
            </svg>
            {scene.nodes.map((node) => {
              const existing = findSavedUrlMapNode(conversations, node);
              return <article className={`url-map-topic ${selectedId === node.id && !edgeId ? "is-selected" : ""}`} key={node.id} style={{ left: node.x, top: node.y, width: node.width, height: node.height }}>
                <div className="url-map-node-actions">
                  <button type="button" title={`Explore pages linked from the source for ${node.label}`} aria-label={`Explore links for ${node.label}`} onClick={() => links(node)}>↗</button>
                  <button type="button" disabled={!onSave && !existing} title={existing ? `Show ${node.label} in my map` : `Add ${node.label} to my map`} aria-label={existing ? `Show ${node.label} in my map` : `Add ${node.label} to my map`} onClick={() => save(node)}>{existing ? "✓" : "+"}</button>
                </div>
                <button type="button" className="url-map-topic-select" title={node.label} onClick={() => select(node)} aria-pressed={selectedId === node.id && !edgeId}>
                  <span>{node.id === graph.rootId ? "MAIN TOPIC" : "FROM THIS PAGE"}{existing ? " · SAVED" : ""}</span><strong>{node.label}</strong><p>{node.summary}</p>
                </button>
              </article>;
            })}
          </div>
      </div>
      <p className="url-map-legend">Solid: from the page · Dashed: AI suggested. {zoom < 0.8 ? "Overview: select a topic for actions and sources. " : ""}<span>Arrow keys pan · +/− zoom · F fits · Pinch to zoom</span></p>
    </div>
    {detailsOpen ? <div className="url-map-details-resize" role="separator" tabIndex={0} aria-label="Resize topic details" aria-orientation="vertical" aria-valuemin={260} aria-valuemax={Math.min(520, Math.max(260, (result.current?.clientWidth ?? 900) - 260))} aria-valuenow={detailsWidth}
      onDoubleClick={() => setDetailsWidth(320)} onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault(); setDetailsWidth((current) => clampDetailsWidth(event.key === "Home" ? 260 : event.key === "End" ? 520 : current + (event.key === "ArrowLeft" ? 24 : -24)));
      }} onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
        resize.current = { pointerId: event.pointerId, x: event.clientX, width: detailsWidth };
      }} onPointerMove={(event) => { if (resize.current?.pointerId === event.pointerId) setDetailsWidth(clampDetailsWidth(resize.current.width + resize.current.x - event.clientX)); }}
      onPointerUp={() => { resize.current = null; }} onPointerCancel={() => { resize.current = null; }} onLostPointerCapture={() => { resize.current = null; }} /> : null}
    <div className="url-map-details-dock">
    <button type="button" className="url-map-sheet-toggle" aria-expanded={detailsOpen} aria-controls={detailsId} onClick={() => setDetailsOpen(!detailsOpen)}><span>{edge ? "Connection details" : selected.label}</span>{detailsOpen ? "Collapse ↓" : "Details & sources ↑"}</button>
    <aside id={detailsId} className="url-map-inspector" ref={inspector} aria-label="Topic and source details" hidden={!detailsOpen} onKeyDown={(event) => { if (event.key === "Escape") { setDetailsOpen(false); viewport.current?.focus(); } }}>
      <div className="url-map-inspector-heading"><strong>Details & sources</strong><button type="button" aria-label="Close topic details" onClick={() => { setDetailsOpen(false); viewport.current?.focus(); }}>×</button></div>
      {edge ? <>
        <small>{edge.kind === "suggested" ? "AI-SUGGESTED CONNECTION" : "AI-EXTRACTED RELATIONSHIP"}</small>
        <h3>{graph.nodes.find((node) => node.id === edge.sourceId)!.label} → {edge.label} → {graph.nodes.find((node) => node.id === edge.targetId)!.label}</h3>
        {edge.evidence ? <><p>Supporting passage</p><blockquote>{edge.evidence.quote}</blockquote><p>The quote was found in the page. The relationship label is the AI’s interpretation.</p></> : <p>This connection is an AI inference, not an explicit statement in the page.</p>}
        <button type="button" onClick={() => { setSelectedId(edge.targetId); setEdgeId(null); }}>Inspect target topic</button>
      </> : <>
        <small>TOPIC</small><h3>{selected.label}</h3><p>{selected.summary}</p>
        <div className="url-map-detail-actions"><button type="button" className="url-map-primary" disabled={!onSave && !saved} onClick={() => save(selected)}>{saved ? "Show in my map" : "Add to my map"}</button><button type="button" onClick={() => onExplorePublic(selected.label)}>Find public topic</button></div>
        {saved ? <p className="url-map-saved" role="status">In my map · Your saved note remains editable.</p> : <p>Save this topic and its evidence as an editable note.</p>}
        <h4>Supporting passage</h4><blockquote>{selected.evidence.quote}</blockquote>
        <p className="url-map-caption">AI-generated summary. The quoted passage was matched to the page text.</p>
        <h4>Connections</h4><div className="url-map-relation-list">{graph.edges.filter((relation) => relation.sourceId === selectedId || relation.targetId === selectedId).map((relation) => <button type="button" key={relation.id} onClick={() => setEdgeId(relation.id)}>{graph.nodes.find((node) => node.id === relation.sourceId)!.label} → {relation.label} → {graph.nodes.find((node) => node.id === relation.targetId)!.label}{relation.kind === "suggested" ? " · suggested" : ""}</button>)}</div>
        <button className="url-map-links-toggle" type="button" aria-expanded={showLinks} onClick={() => setShowLinks(!showLinks)}>Explore linked pages ({graph.source.links.length})</button>
        {showLinks ? <div className="url-map-linked-pages" ref={linkedPages}><p>Links found in the source page. Map one with a focus on “{selected.label}”; each opens a new page map.</p>{graph.source.links.length ? graph.source.links.map((link) => <div key={link.url}><a href={link.url} target="_blank" rel="noreferrer">{link.label}</a><button type="button" disabled={busy} onClick={() => onMapLink(link.url, selected.label)} aria-label={`Map linked page: ${link.label}`}>Map page</button></div>) : <p>No readable web links were found in this page.</p>}</div> : null}
      </>}
      <div className="url-map-source"><h4>Source</h4><a href={graph.source.url} target="_blank" rel="noreferrer">{graph.source.title} ↗</a>{graph.source.byline ? <p>{graph.source.byline}</p> : null}<p>Read {new Date(graph.source.retrievedAt).toLocaleDateString()} · One page</p><p>Topics from different pages are kept separate until you choose to connect them.</p>{graph.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div>
    </aside>
    </div>
  </div>;
}
