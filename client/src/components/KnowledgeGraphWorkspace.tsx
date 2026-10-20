import DismissibleDetails from "./DismissibleDetails";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from "react";
import ConversationGraphView, { type ConversationGraphViewProps } from "./ConversationGraphView";
import { requestUrlMap, type UrlMapAIOptions } from "../lib/urlMap";
import type { PublicExpansion, PublicTopic } from "../lib/publicKnowledge";
import type { PublicMapAccount } from "./PublicTopicInsights";
import { MapTopicSourcesPanel } from "./TopicSources";
import { fallbackQuestion } from "./MapSearchFallbacks";
import { askAboutNote, type PrivateAnswer } from "../lib/publicMapApi";
import { expandWikipediaTopic, findWikipediaTopic, searchWikipediaTopics } from "../lib/wikipedia";
import { ApiError } from "../lib/apiError";
import {
  addExplored, answerItems, expansionItems, forgetExplored, isFullWebAddress, pageItemId, pageItems, parentKey, publicTopicFromAnswer,
  setExpansion, setOnMap, settleExplored, topicItem, webAddress,
  type ExploredBatch, type ExploredItem, type ExploredParent, type MapExploration,
} from "../lib/mapExploration";
import { useMapExploration } from "../lib/useMapExploration";
import { MapExploredHistory, MapPreviewBar, MapPreviewDetails, MapPreviewLayer, MapSearchLookFurther, looksLikeQuestion } from "./MapPreviews";
import { getStandaloneNote } from "../lib/standaloneNotes";
import type { Conversation } from "../types";
import "./KnowledgeGraphWorkspace.css";

interface Props extends ConversationGraphViewProps {
  onToggleSidebar?: () => void;
  sidebarOpen?: boolean;
  urlMapAIOptions?: UrlMapAIOptions;
  onSavePublicTopic: (topic: PublicTopic) => void;
  publicMapAccount?: PublicMapAccount;
  onCreateMapNote: (args: { linkedTo?: string; url?: string; position?: { x: number; y: number } }) => void;
  onSetMapConnection: (sourceId: string, targetId: string, connected: boolean) => void;
  onRemoveMapNote: (id: string) => void;
  onUndoMapEdit: () => void;
  mapEditMessage?: string;
  canUndoMapEdit?: boolean;
  onAddChildNote?: (conversationId: string) => void;
  onExpandTopicWithAI?: (conversationId: string) => void;
  onCancelTopicExpansion?: () => void;
  expandingTopicId?: string | null;
  topicExpansionProgress?: string;
  topicExpansionError?: { conversationId: string; message: string } | null;
  onDismissTopicExpansionError?: () => void;
  /** Adds a page of Wikipedia connections to a note; returns how many were new. */
  onAddTopicConnections?: (conversationId: string, expansion: PublicExpansion) => number;
  /** Saves a private AI answer as a note under the given note, or on its own when there is none. */
  onSavePrivateAnswer?: (conversationId: string | null, answer: PrivateAnswer) => void;
  /** Turns previews into notes; returns the note each one became. */
  onKeepExplored?: (exploration: MapExploration, ids: string[], detached?: string[]) => Record<string, string>;
}

const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;
const hostname = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };
const editable = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || Boolean(target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")));

export default function KnowledgeGraphWorkspace({ isVisible = true, onToggleSidebar, sidebarOpen, urlMapAIOptions, onSavePublicTopic, publicMapAccount, onCreateMapNote, onSetMapConnection, onRemoveMapNote, onUndoMapEdit, mapEditMessage, canUndoMapEdit, onAddChildNote, onExpandTopicWithAI, onCancelTopicExpansion, expandingTopicId, topicExpansionProgress, topicExpansionError, onDismissTopicExpansionError, onAddTopicConnections, onSavePrivateAnswer, onKeepExplored, ...personalProps }: Props) {
  const [sourcesFor, setSourcesFor] = useState<string | "add" | null>(null);
  const [addedTopicId, setAddedTopicId] = useState<string | null>(null);
  const [personalFocus, setPersonalFocus] = useState<Props["focusRequest"]>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [sourceFormOpen, setSourceFormOpen] = useState(false);
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceError, setSourceError] = useState("");
  const [exploration, updateExploration] = useMapExploration(personalProps.workspaceKey ?? "workspace", publicMapAccount?.userId);
  const [selectedPreview, setSelectedPreview] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [busy, setBusy] = useState<{ label: string; progress: string; controller: AbortController } | null>(null);
  const [exploreMessage, setExploreMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [revealRequest, setRevealRequest] = useState<{ ids: string[]; requestId: number } | null>(null);
  const [searchRequest, setSearchRequest] = useState<{ query: string; requestId: number } | null>(null);
  const counter = useRef(0);
  const busyRef = useRef<typeof busy>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const pendingKept = useRef<Record<string, string>>({});
  // Lookup notices float just under the map header, which wraps to several rows on narrow screens.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const header = panel?.querySelector<HTMLElement>(".graph-map-navigation");
    if (!panel || !header) return;
    const place = () => panel.style.setProperty("--map-header-bottom", `${Math.max(0, header.getBoundingClientRect().bottom - panel.getBoundingClientRect().top)}px`);
    place();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(place);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);
  const conversations = personalProps.conversations;
  const savedTopics = useMemo(() => {
    const index: Record<string, string> = {};
    for (const conversation of Object.values(conversations)) {
      const topic = conversation.publicTopic;
      if (topic) for (const id of [topic.id, ...topic.aliases]) index[id] ??= conversation.id;
    }
    return index;
  }, [conversations]);
  const latest = useRef({ conversations, savedTopics, exploration });
  latest.current = { conversations, savedTopics, exploration };

  /** Explored items already in the workspace leave history; what hung off them hangs off the note. */
  const settle = useCallback((state: MapExploration) => {
    const { conversations: current, savedTopics: topics } = latest.current;
    return settleExplored(state, (item) => {
      const kept = pendingKept.current[item.id];
      if (kept && current[kept]) return kept;
      if (item.source.kind === "topic") return topics[item.source.topic.id] ?? null;
      if (item.source.kind === "page") { const id = `url-topic-${item.source.nodeId}`; return current[id] ? id : null; }
      return null;
    });
  }, []);
  useEffect(() => { updateExploration(settle); }, [conversations, savedTopics, settle, updateExploration]);

  // A topic added from Wikipedia opens its own sources, ready for its connections.
  useEffect(() => {
    const id = addedTopicId ? savedTopics[addedTopicId] : undefined;
    if (!id) return;
    setAddedTopicId(null);
    openSources(id);
    setPersonalFocus({ conversationId: id, requestId: -(++counter.current) });
  }, [addedTopicId, savedTopics]);

  useEffect(() => () => busyRef.current?.controller.abort(), []);

  // A link pasted or dropped on the map goes into the map search, which offers what to do with it.
  useEffect(() => {
    if (!isVisible) return;
    function onPaste(event: ClipboardEvent) {
      if (editable(event.target) || editable(document.activeElement)) return;
      const active = document.activeElement;
      if (active && active !== document.body && !sectionRef.current?.contains(active)) return;
      const url = webAddress(event.clipboardData?.getData("text/plain") ?? "");
      if (!url) return;
      event.preventDefault();
      setSearchRequest({ query: url, requestId: ++counter.current });
    }
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [isVisible]);

  function droppedLink(event: DragEvent) {
    if (!event.dataTransfer.types.includes("text/uri-list")) return null;
    return webAddress(event.dataTransfer.getData("text/uri-list").split("\n").find((line) => line && !line.startsWith("#")) ?? "");
  }

  function openSources(id: string | "add") { setSourcesFor(id); setSelectedPreview(null); setHistoryOpen(false); }
  function focusDocument(id: string) { setPersonalFocus({ conversationId: id, requestId: -(++counter.current) }); }
  function selectPreview(id: string | null) {
    setSelectedPreview(id);
    if (!id) return;
    setSourcesFor(null); setConnectingId(null);
    if (latest.current.exploration.items[id]?.onMap) setRevealRequest({ ids: [id], requestId: ++counter.current });
  }

  function newBatch(title: string): ExploredBatch {
    return { id: `batch-${Date.now().toString(36)}-${(++counter.current).toString(36)}`, title: title.slice(0, 200), createdAt: new Date().toISOString() };
  }

  /** Puts new previews on the map and brings them into view. */
  function showPreviews(update: (current: MapExploration) => MapExploration, ids: string[]) {
    updateExploration((current) => settle(update(current)));
    if (ids.length) setRevealRequest({ ids, requestId: ++counter.current });
  }

  /** Runs one lookup at a time, with its progress and a Cancel in the notice bar. */
  async function run(label: string, task: (signal: AbortSignal, progress: (text: string) => void) => Promise<void>) {
    busyRef.current?.controller.abort();
    const entry = { label, progress: "", controller: new AbortController() };
    busyRef.current = entry;
    setBusy(entry); setExploreMessage(null);
    try {
      await task(entry.controller.signal, (progress) => { if (busyRef.current === entry) setBusy({ ...entry, progress }); });
    } catch (error) {
      if (entry.controller.signal.aborted) return;
      if (error instanceof ApiError && error.statusCode === 401) publicMapAccount?.onAuthExpired?.();
      setExploreMessage({ text: errorMessage(error, "That could not be explored. Try again."), error: true });
    } finally {
      if (busyRef.current === entry) { busyRef.current = null; setBusy(null); }
    }
  }

  /** Reads Wikipedia connections under a document or preview, skipping pages already in the map. */
  async function loadConnections(topic: PublicTopic, parent: ExploredParent, batch: ExploredBatch, title: string, signal: AbortSignal) {
    let offset = latest.current.exploration.expansions[parentKey(parent)]?.nextOffset ?? 0;
    for (let page = 0; page < 3; page += 1) {
      const expansion = await expandWikipediaTopic(topic, offset, signal);
      signal.throwIfAborted();
      offset = expansion.nextOffset;
      const items = expansionItems(expansion, { parent, batchId: batch.id, exploredAt: new Date().toISOString() })
        .filter((item) => item.source.kind !== "topic" || !latest.current.savedTopics[item.source.topic.id]);
      const fresh = items.filter((item) => !latest.current.exploration.items[item.id]?.onMap);
      showPreviews((current) => setExpansion(addExplored(current, batch, items), parent, { nextOffset: expansion.nextOffset, hasMore: expansion.hasMore }), items.map((item) => item.id));
      if (fresh.length || !expansion.hasMore) {
        if (!fresh.length) setExploreMessage({ text: `Every Wikipedia connection of ${title} is already in your map or on it.`, error: false });
        return;
      }
    }
  }

  function previewTopic(topic: PublicTopic, parent: ExploredParent | null) {
    const existing = latest.current.savedTopics[topic.id];
    if (existing) { focusDocument(existing); showAround(existing); return; }
    const batch = newBatch(topic.label);
    const item = topicItem(topic, { parent, batchId: batch.id, exploredAt: batch.createdAt });
    showPreviews((current) => addExplored(current, batch, [item]), [item.id]);
    selectPreview(item.id);
    void run(`Reading Wikipedia connections for ${topic.label}…`, (signal) => loadConnections(topic, { kind: "item", id: item.id }, batch, topic.label, signal));
  }

  function previewFirstArticle(query: string) {
    void run(`Searching Wikipedia for “${query}”…`, async (signal) => {
      const [topic] = await searchWikipediaTopics(query, signal);
      signal.throwIfAborted();
      if (!topic) throw new Error(`No Wikipedia article matches “${query}”. Ask AI instead, or try other words.`);
      previewTopic(topic, null);
    });
  }

  /** Previews Wikipedia topics around a document in the map, without adding them. */
  function showAround(id: string) {
    const conversation = latest.current.conversations[id];
    if (!conversation) return;
    setConnectingId(null);
    const batch = newBatch(`Around ${conversation.title || "Untitled"}`);
    void run(`Finding Wikipedia topics around ${conversation.title}…`, async (signal) => {
      const saved = conversation.publicTopic;
      const found = saved?.wikipediaUrl ? saved : await findWikipediaTopic(saved?.label ?? conversation.title, signal);
      signal.throwIfAborted();
      if (!found) throw new Error(`Wikipedia has no article that matches “${conversation.title}”. Try the map search instead.`);
      await loadConnections(saved && found !== saved ? { ...found, id: saved.id } : found, { kind: "document", id }, batch, conversation.title, signal);
    });
  }

  function showMoreConnections(item: ExploredItem) {
    if (item.source.kind !== "topic") return;
    const topic = item.source.topic;
    const batch = latest.current.exploration.batches[item.batchId] ?? newBatch(topic.label);
    if (!item.onMap) showPreviews((current) => setOnMap(current, [item.id], true), [item.id]);
    void run(`Reading Wikipedia connections for ${topic.label}…`, (signal) => loadConnections(topic, { kind: "item", id: item.id }, batch, topic.label, signal));
  }

  function mapPage(url: string, parent: ExploredParent | null) {
    const account = publicMapAccount;
    if (!account?.canAsk) return;
    void run(`Reading ${hostname(url)}…`, async (signal, progress) => {
      try {
        const graph = await requestUrlMap({ ...urlMapAIOptions, url, expectedUserId: account.userId, signal, onProgress: progress });
        signal.throwIfAborted();
        const batch = newBatch(graph.source.title || hostname(url));
        const items = pageItems(graph, { parent, batchId: batch.id, exploredAt: new Date().toISOString() });
        showPreviews((current) => addExplored(current, batch, items, [graph]), items.map((item) => item.id));
        selectPreview(pageItemId(graph.rootId));
      } finally { account.onBillingRefresh?.(); }
    });
  }

  function askAI(question: string, parent: ExploredParent | null, context: { label: string; description?: string; noteContent?: string }) {
    const account = publicMapAccount;
    if (!account?.canAsk || question.trim().length < 3) return;
    void run("Asking AI…", async (signal, progress) => {
      try {
        const answer = await askAboutNote({ userId: account.userId, topic: { label: context.label.slice(0, 200) || "Map search", description: (context.description ?? "").slice(0, 2000) },
          noteContent: (context.noteContent ?? "").slice(0, 6000), question: question.slice(0, 500), options: account.aiOptions, signal, onProgress: progress });
        signal.throwIfAborted();
        const batch = newBatch(answer.question);
        const items = answerItems(answer, batch.id.slice(6), { parent, batchId: batch.id, exploredAt: batch.createdAt });
        showPreviews((current) => addExplored(current, batch, items), items.map((item) => item.id));
        selectPreview(items[0].id);
      } finally { account.onBillingRefresh?.(); }
    });
  }

  function keep(ids: string[], detached: string[] = []) {
    if (!onKeepExplored || !ids.length) return;
    const kept = onKeepExplored(latest.current.exploration, ids, detached);
    Object.assign(pendingKept.current, kept);
    if (selectedPreview && kept[selectedPreview]) setSelectedPreview(null);
  }

  /** What a search's previews sit beside: the best match, else a document whose title the search names. */
  function anchorFor(query: string, matchedIds: string[]): ExploredParent | null {
    if (matchedIds[0]) return { kind: "document", id: matchedIds[0] };
    const words = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const text = ` ${words(query)} `;
    let best: { id: string; length: number } | null = null;
    for (const conversation of Object.values(latest.current.conversations)) {
      const title = words(conversation.title);
      if (title.length >= 3 && text.includes(` ${title} `) && (!best || title.length > best.length)) best = { id: conversation.id, length: title.length };
    }
    return best ? { kind: "document", id: best.id } : null;
  }

  function submitSearch(query: string, matchedIds: string[]) {
    const canAsk = Boolean(publicMapAccount?.canAsk);
    const url = webAddress(query);
    if (url && isFullWebAddress(query)) { if (!canAsk) return false; mapPage(url, anchorFor(query, matchedIds)); return true; }
    if (canAsk && looksLikeQuestion(query)) { askAI(fallbackQuestion(query), anchorFor(query, matchedIds), { label: query }); return true; }
    if (matchedIds.length || query.length < 2) return false;
    previewFirstArticle(query);
    return true;
  }

  function renderActions(conversation: Conversation) {
    const aroundLabel = `Show Wikipedia topics around ${conversation.title}`;
    return <>
      {conversation.publicTopic && onExpandTopicWithAI ? <button type="button" className="conversation-graph-node-action map-topic-action" disabled={Boolean(expandingTopicId)} aria-label={`Expand ${conversation.title} with AI`} title="Create an editable subgraph of AI-generated notes" onClick={(event) => { event.stopPropagation(); onExpandTopicWithAI(conversation.id); }}>
        {expandingTopicId === conversation.id ? "Expanding…" : "✧ Expand with AI"}
      </button> : null}
      {onAddTopicConnections && publicMapAccount ? <button type="button" className="conversation-graph-node-action" aria-label={`Wikipedia and AI for ${conversation.title}`} title="Wikipedia connections and AI" onClick={(event) => { event.stopPropagation(); setConnectingId(null); openSources(conversation.id); }}>
        <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6" /><path d="m15 15 6 6M8 10.5h5M10.5 8v5" /></svg>
      </button> : null}
      {onAddChildNote ? <button type="button" className="conversation-graph-node-action" aria-label={`Add child note to ${conversation.title}`} title={`Add child note to ${conversation.title}`} onClick={(event) => { event.stopPropagation(); onAddChildNote(conversation.id); }}>
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M14 3H5v18h14V8l-5-5ZM14 3v5h5M8 14h8M12 10v8" /></svg>
      </button> : null}
      <button type="button" className="conversation-graph-node-action" aria-label={aroundLabel} title={`${aroundLabel}, as previews you can keep`} onClick={(event) => { event.stopPropagation(); showAround(conversation.id); }}>
        <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z" /></svg>
      </button>
    </>;
  }

  function renderMenuActions(conversation: Conversation) {
    return <>
          {onAddTopicConnections && publicMapAccount ? <button type="button" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); setConnectingId(null); openSources(conversation.id); }}>Wikipedia and AI…</button> : null}
          <button type="button" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); showAround(conversation.id); }}>Show what's around it</button>
          {onAddChildNote ? <button type="button" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onAddChildNote(conversation.id); }}>Add child note</button> : null}
          <button type="button" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onCreateMapNote({ linkedTo: conversation.id }); }}>New connected note</button>
          <button type="button" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); setConnectingId(conversation.id); }}>Connect to another node</button>
          <button type="button" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); personalProps.onOpenConversation(conversation.id); }}>Open and edit</button>
          {conversation.kind === "note" && !conversation.childIds.length ? <button type="button" onClick={() => onRemoveMapNote(conversation.id)}>Remove note from workspace</button> : null}
    </>;
  }

  const sourceConversation = sourcesFor && sourcesFor !== "add" ? conversations[sourcesFor] : undefined;
  const sourceNote = useMemo(() => sourceConversation ? {
    id: sourceConversation.id, title: sourceConversation.title,
    content: getStandaloneNote(sourceConversation)?.content ?? "",
    topic: sourceConversation.publicTopic,
    ...(sourceConversation.hiddenFromAI ? { hiddenFromAI: true } : {}),
  } : null, [sourceConversation]);
  const previewItem = selectedPreview ? exploration.items[selectedPreview] : undefined;
  const onMapIds = useMemo(() => Object.values(exploration.items).filter((item) => item.onMap).map((item) => item.id), [exploration]);
  const historyCount = Object.keys(exploration.items).length;
  const sidebarToggle = onToggleSidebar && !sidebarOpen ? <div className="knowledge-map-switcher is-inline">
    <button type="button" className="knowledge-map-sidebar-toggle" onClick={onToggleSidebar} aria-label="Open chat sidebar" aria-pressed={false}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></svg>
    </button>
  </div> : null;
  const addActions = <>
    <button type="button" className="knowledge-map-history-button" aria-pressed={historyOpen && !previewItem} aria-label={`Explored history${historyCount ? `, ${historyCount} items` : ""}`} title="Explored history: previews you have not kept"
      onClick={() => { setHistoryOpen(!(historyOpen && !previewItem)); setSelectedPreview(null); setSourcesFor(null); }}>
      <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3.5 12a8.5 8.5 0 1 0 2.5-6" /><path d="M3.5 4v4h4M12 7.5V12l3 2" /></svg>
      {historyCount ? <span>{historyCount > 99 ? "99+" : historyCount}</span> : null}
    </button>
    <DismissibleDetails className="knowledge-map-add" onKeyDown={(event) => {
      if (event.key !== "Escape") return;
      event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus();
    }}>
      <summary aria-label="Add to map" title="Add to map"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg></summary>
      <div>
        <button type="button" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onCreateMapNote({}); }}>New note</button>
        {onAddTopicConnections && publicMapAccount ? <button type="button" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); openSources("add"); }}>From Wikipedia</button> : null}
        <button type="button" aria-expanded={sourceFormOpen} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); setSourceFormOpen(!sourceFormOpen); }}>Add web source</button>
      </div>
    </DismissibleDetails>
  </>;

  return <section ref={sectionRef} className="knowledge-graph-workspace" aria-label="Knowledge maps"
    onDragOver={(event) => { if (!event.defaultPrevented && event.dataTransfer.types.includes("text/uri-list")) { event.preventDefault(); event.dataTransfer.dropEffect = "link"; } }}
    onDrop={(event) => { if (event.defaultPrevented) return; const url = droppedLink(event); if (!url) return; event.preventDefault(); setSearchRequest({ query: url, requestId: ++counter.current }); }}>
    {sourceFormOpen ? <form className="map-source-form" onSubmit={(event) => {
      event.preventDefault();
      try {
        const url = new URL(sourceUrl);
        if (!["http:", "https:"].includes(url.protocol)) throw new Error();
        onCreateMapNote({ url: url.href }); setSourceFormOpen(false); setSourceUrl(""); setSourceError("");
      } catch { setSourceError("Enter a complete http or https web address."); }
    }}>
      <label>Web address<input type="url" required value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="https://…" /></label>
      <button type="submit">Save source note</button><button type="button" onClick={() => setSourceFormOpen(false)}>Cancel</button>
      <small>A linked source with room for your notes.</small>{sourceError ? <p role="alert">{sourceError}</p> : null}
    </form> : null}
    {connectingId ? <div className="map-workspace-notice" role="status">Choose a second node to connect with {conversations[connectingId]?.title}.<button type="button" onClick={() => setConnectingId(null)}>Cancel</button></div> : null}
    {mapEditMessage ? <div className="map-workspace-notice" role="status">{mapEditMessage}{canUndoMapEdit ? <button type="button" onClick={onUndoMapEdit}>Undo</button> : null}</div> : null}
    {expandingTopicId ? <div className="map-workspace-notice" role="status" aria-live="polite"><span>{topicExpansionProgress || "Building an AI subgraph…"} · {conversations[expandingTopicId]?.title}</span><button type="button" onClick={onCancelTopicExpansion}>Cancel expansion</button></div> : null}
    {topicExpansionError ? <div className="map-workspace-notice is-error" role="alert"><span>{topicExpansionError.message}</span>{conversations[topicExpansionError.conversationId] ? <button type="button" disabled={Boolean(expandingTopicId)} onClick={() => onExpandTopicWithAI?.(topicExpansionError.conversationId)}>Retry AI expansion</button> : null}<button type="button" onClick={onDismissTopicExpansionError}>Dismiss</button></div> : null}
    <div className="knowledge-map-panel" ref={panelRef}>
      {busy || exploreMessage ? <div className="map-explore-status" aria-live="polite">
        {busy ? <div className="map-workspace-notice" role="status"><span className="map-explore-spinner" aria-hidden="true" /><span>{busy.progress || busy.label}</span><button type="button" onClick={() => busy.controller.abort()}>Cancel</button></div> : null}
        {exploreMessage ? <div className={`map-workspace-notice${exploreMessage.error ? " is-error" : ""}`} role={exploreMessage.error ? "alert" : "status"}><span>{exploreMessage.text}</span><button type="button" onClick={() => setExploreMessage(null)}>Dismiss</button></div> : null}
      </div> : null}
      <ConversationGraphView {...personalProps} isVisible={isVisible} renderNodeActions={renderActions}
        searchPlaceholder="Search, ask, or paste a link…" searchRequest={searchRequest} onSearchSubmit={submitSearch}
        renderSearchFallback={(query, close, matchedIds) => <MapSearchLookFurther query={query} matchedCount={matchedIds.length} canAsk={Boolean(publicMapAccount?.canAsk)}
          onMapPage={(url) => { close(); mapPage(url, anchorFor(query, matchedIds)); }}
          onSaveSource={(url) => { close(); onCreateMapNote({ url }); }}
          onPreviewTopic={(topic) => { close(); previewTopic(topic, anchorFor(query, matchedIds)); }}
          onAsk={(question) => { close(); askAI(question, anchorFor(query, matchedIds), { label: query }); }} />}
        renderMapOverlay={(context) => <>
          <MapPreviewLayer context={context} exploration={exploration} selectedId={selectedPreview} revealRequest={revealRequest} panelOpen={Boolean(previewItem || historyOpen || sourcesFor)}
            onSelect={selectPreview} onKeep={(id) => keep([id])} onHide={(id) => updateExploration((current) => setOnMap(current, [id], false))} />
          {onMapIds.length ? <MapPreviewBar count={onMapIds.length} onKeepAll={() => keep(onMapIds)} onClear={() => updateExploration((current) => setOnMap(current, onMapIds, false))} /> : null}
        </>}
        renderNodeMenuActions={renderMenuActions} connectingConversationId={connectingId}
        toolbarLeading={sidebarToggle}
        toolbarTrailing={addActions}
        focusRequest={personalProps.focusRequest ?? personalFocus}
        onFocusRequestHandled={(id) => { if (personalProps.focusRequest?.requestId === id) personalProps.onFocusRequestHandled?.(id); else setPersonalFocus(null); }}
        onConnectConversation={(source, target) => { if (source !== target) { onSetMapConnection(source, target, true); setConnectingId(null); } }}
        onRemoveConnection={(source, target) => onSetMapConnection(source, target, false)}
        onCreateNoteAt={(position) => onCreateMapNote({ position })} />
      {previewItem ? <MapPreviewDetails key={previewItem.id} item={previewItem} exploration={exploration} account={publicMapAccount}
        anchorTitle={previewItem.parent?.kind === "document" ? conversations[previewItem.parent.id]?.title ?? null : null}
        onClose={() => setSelectedPreview(null)}
        onKeep={() => keep([previewItem.id])}
        onKeepAlone={() => keep([previewItem.id], [previewItem.id])}
        onToggleMap={() => showPreviews((current) => setOnMap(current, [previewItem.id], !previewItem.onMap), previewItem.onMap ? [] : [previewItem.id])}
        onForget={() => { updateExploration((current) => forgetExplored(current, [previewItem.id])); setSelectedPreview(null); }}
        onShowConnections={() => showMoreConnections(previewItem)}
        onAsk={(question) => {
          const source = previewItem.source;
          const page = source.kind === "page" ? exploration.pages[source.url] : undefined;
          const node = source.kind === "page" ? page?.nodes.find((candidate) => candidate.id === source.nodeId) : undefined;
          askAI(question, { kind: "item", id: previewItem.id }, source.kind === "answer"
            ? { label: source.answer.question, noteContent: source.answer.answer }
            : { label: previewItem.label, description: previewItem.detail, noteContent: node && page ? `Source: ${page.source.url}\n\n${node.summary}\n\n> ${node.evidence.quote}` : previewItem.detail });
        }}
        onPreviewAnswer={(answer) => {
          const batch = exploration.batches[previewItem.batchId] ?? newBatch(previewItem.label);
          const items = answerItems(answer, answer.id, { parent: { kind: "item", id: previewItem.id }, batchId: batch.id, exploredAt: new Date().toISOString() });
          showPreviews((current) => addExplored(current, batch, items), items.map((item) => item.id));
        }}
        onPreviewTopic={(topic) => {
          const exploredAt = new Date().toISOString();
          const batch = exploration.batches[previewItem.batchId] ?? newBatch(previewItem.label);
          const item = topicItem(publicTopicFromAnswer(topic, exploredAt), { parent: { kind: "item", id: previewItem.id }, batchId: batch.id, exploredAt },
            { via: `Ask AI · ${topic.relation}`, connection: { kind: "related", label: topic.relation } });
          showPreviews((current) => addExplored(current, batch, [item]), [item.id]);
        }} />
      : historyOpen ? <MapExploredHistory exploration={exploration} selectedId={selectedPreview} onClose={() => setHistoryOpen(false)}
        onSelect={selectPreview}
        onSetOnMap={(ids, onMap) => showPreviews((current) => setOnMap(current, ids, onMap), onMap ? ids : [])}
        onKeep={(ids) => keep(ids)}
        onForget={(ids) => updateExploration((current) => forgetExplored(current, ids))} />
      : sourcesFor && publicMapAccount && onAddTopicConnections && (sourcesFor === "add" || sourceNote) ? <MapTopicSourcesPanel
        note={sourcesFor === "add" ? null : sourceNote} account={publicMapAccount} onClose={() => setSourcesFor(null)}
        onAddTopic={(topic) => { onSavePublicTopic(topic); setAddedTopicId(topic.id); }}
        onAddConnections={onAddTopicConnections}
        onSaveAnswer={(id, answer) => onSavePrivateAnswer?.(id, answer)}
        onPreviewConnections={(noteId) => { setSourcesFor(null); showAround(noteId); }} /> : null}
    </div>
  </section>;
}
