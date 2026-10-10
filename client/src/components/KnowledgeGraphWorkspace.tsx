import DismissibleDetails from "./DismissibleDetails";
import { useEffect, useMemo, useRef, useState } from "react";
import ConversationGraphView, { type ConversationGraphViewProps } from "./ConversationGraphView";
import PublicKnowledgeMap from "./PublicKnowledgeMap";
import UrlMapPanel from "./UrlMapPanel";
import type { UrlMapAIOptions, UrlMapGraph } from "../lib/urlMap";
import type { PublicExpansion, PublicTopic } from "../lib/publicKnowledge";
import type { PublicMapAccount } from "./PublicTopicInsights";
import { MapTopicSourcesPanel } from "./TopicSources";
import { MapSearchFallbackPanel, SearchFallbackActions, type SearchFallbackSource } from "./MapSearchFallbacks";
import type { PrivateAnswer } from "../lib/publicMapApi";
import { getStandaloneNote } from "../lib/standaloneNotes";
import type { Conversation } from "../types";
import "./KnowledgeGraphWorkspace.css";

interface Props extends ConversationGraphViewProps {
  onToggleSidebar?: () => void;
  sidebarOpen?: boolean;
  onSaveUrlMapNode?: (graph: UrlMapGraph, nodeId: string) => void;
  urlMapAIOptions?: UrlMapAIOptions;
  onSavePublicTopic: (topic: PublicTopic) => void;
  publicMapAccount?: PublicMapAccount;
  onCreateMapNote: (args: { linkedTo?: string; url?: string }) => void;
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
  /** Saves a web result as a source note, linked to a note when one is given. */
  /** Saves a private AI answer as a note under the given note, or on its own when there is none. */
  onSavePrivateAnswer?: (conversationId: string | null, answer: PrivateAnswer) => void;
}

export default function KnowledgeGraphWorkspace({ isVisible = true, onToggleSidebar, sidebarOpen, onSaveUrlMapNode, urlMapAIOptions, onSavePublicTopic, publicMapAccount, onCreateMapNote, onSetMapConnection, onRemoveMapNote, onUndoMapEdit, mapEditMessage, canUndoMapEdit, onAddChildNote, onExpandTopicWithAI, onCancelTopicExpansion, expandingTopicId, topicExpansionProgress, topicExpansionError, onDismissTopicExpansionError, onAddTopicConnections, onSavePrivateAnswer, ...personalProps }: Props) {
  const [sourcesFor, setSourcesFor] = useState<string | "add" | null>(null);
  const [searchFallback, setSearchFallback] = useState<{ query: string; source: SearchFallbackSource; requestId: number } | null>(null);
  const [addedTopicId, setAddedTopicId] = useState<string | null>(null);
  const [urlMapOpen, setUrlMapOpen] = useState(false);
  const [mode, setMode] = useState<"personal" | "public">("personal");
  const [publicFocus, setPublicFocus] = useState<{ id: string; requestId: number; topic?: PublicTopic } | null>(null);
  const [publicSearch, setPublicSearch] = useState<{ query: string; requestId: number } | null>(null);
  const [personalFocus, setPersonalFocus] = useState<Props["focusRequest"]>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [sourceFormOpen, setSourceFormOpen] = useState(false);
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceError, setSourceError] = useState("");
  const counter = useRef(0);
  const savedTopics = useMemo(() => {
    const index: Record<string, string> = {};
    for (const conversation of Object.values(personalProps.conversations)) {
      const topic = conversation.publicTopic;
      if (topic) for (const id of [topic.id, ...topic.aliases]) index[id] ??= conversation.id;
    }
    return index;
  }, [personalProps.conversations]);

  // A topic added from Wikipedia opens its own sources, ready for its connections.
  useEffect(() => {
    const id = addedTopicId ? savedTopics[addedTopicId] : undefined;
    if (!id) return;
    setAddedTopicId(null);
    setSearchFallback(null);
    setSourcesFor(id);
    setPersonalFocus({ conversationId: id, requestId: -(++counter.current) });
  }, [addedTopicId, savedTopics]);

  // Node sources replace a search's fallback panel in the same place.
  useEffect(() => { if (sourcesFor) setSearchFallback(null); }, [sourcesFor]);

  useEffect(() => {
    if (isVisible && personalProps.focusRequest && !personalProps.focusRequest.preserveMapMode) { setMode("personal"); setUrlMapOpen(false); }
  }, [isVisible, personalProps.focusRequest]);

  function explorePublic(conversation: Conversation) {
    setConnectingId(null);
    if (conversation.publicTopic) setPublicFocus({ id: conversation.publicTopic.id, requestId: ++counter.current, topic: conversation.publicTopic });
    else setPublicSearch({ query: conversation.title, requestId: ++counter.current });
    setMode("public");
  }

  function showPersonal(id: string, topic?: PublicTopic) {
    if (topic) onSavePublicTopic(topic);
    setMode("personal");
    setPersonalFocus({ conversationId: id, requestId: -(++counter.current) });
    personalProps.onActivateConversation(id);
  }

  function renderActions(conversation: Conversation) {
    const publicLabel = conversation.publicTopic ? `Explore ${conversation.title} in public map` : `Find public topic for ${conversation.title}`;
    return <>
      {conversation.publicTopic && onExpandTopicWithAI ? <button type="button" className="conversation-graph-node-action map-topic-action" disabled={Boolean(expandingTopicId)} aria-label={`Expand ${conversation.title} with AI`} title="Create an editable subgraph of AI-generated notes" onClick={(event) => { event.stopPropagation(); onExpandTopicWithAI(conversation.id); }}>
        {expandingTopicId === conversation.id ? "Expanding…" : "✧ Expand with AI"}
      </button> : null}
      {onAddTopicConnections && publicMapAccount ? <button type="button" className="conversation-graph-node-action" aria-label={`Wikipedia and AI for ${conversation.title}`} title="Wikipedia connections and AI" onClick={(event) => { event.stopPropagation(); setConnectingId(null); setSourcesFor(conversation.id); }}>
        <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6" /><path d="m15 15 6 6M8 10.5h5M10.5 8v5" /></svg>
      </button> : null}
      {onAddChildNote ? <button type="button" className="conversation-graph-node-action" aria-label={`Add child note to ${conversation.title}`} title={`Add child note to ${conversation.title}`} onClick={(event) => { event.stopPropagation(); onAddChildNote(conversation.id); }}>
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M14 3H5v18h14V8l-5-5ZM14 3v5h5M8 14h8M12 10v8" /></svg>
      </button> : null}
      <button type="button" className="conversation-graph-node-action" aria-label={publicLabel} title={publicLabel} onClick={(event) => { event.stopPropagation(); explorePublic(conversation); }}>
        <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z" /></svg>
      </button>

    </>;
  }

  function renderMenuActions(conversation: Conversation) {
    return <>
          {onAddTopicConnections && publicMapAccount ? <button type="button" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); setConnectingId(null); setSourcesFor(conversation.id); }}>Wikipedia and AI…</button> : null}
          {onAddChildNote ? <button type="button" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onAddChildNote(conversation.id); }}>Add child note</button> : null}
          <button type="button" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onCreateMapNote({ linkedTo: conversation.id }); }}>New connected note</button>
          <button type="button" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); setConnectingId(conversation.id); }}>Connect to another node</button>
          <button type="button" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); personalProps.onOpenConversation(conversation.id); }}>Open and edit</button>
          {conversation.kind === "note" && !conversation.childIds.length ? <button type="button" onClick={() => onRemoveMapNote(conversation.id)}>Remove note from workspace</button> : null}
    </>;
  }

  const personalVisible = mode === "personal" && !urlMapOpen;
  const sourceConversation = sourcesFor && sourcesFor !== "add" ? personalProps.conversations[sourcesFor] : undefined;
  const sourceNote = useMemo(() => sourceConversation ? {
    id: sourceConversation.id, title: sourceConversation.title,
    content: getStandaloneNote(sourceConversation)?.content ?? "",
    topic: sourceConversation.publicTopic,
  } : null, [sourceConversation]);
  const mapControls = <>
      {onToggleSidebar && !sidebarOpen ? <button type="button" className="knowledge-map-sidebar-toggle" onClick={onToggleSidebar}
        aria-label="Open chat sidebar" aria-pressed={false}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></svg>
      </button> : null}
      <div role="group" aria-label="Choose map">
        <button type="button" aria-pressed={mode === "personal" && !urlMapOpen} onClick={() => { setMode("personal"); setUrlMapOpen(false); }}>My map</button>
        <button type="button" aria-pressed={mode === "public" && !urlMapOpen} onClick={() => { setMode("public"); setUrlMapOpen(false); setConnectingId(null); }}>Public</button>
        <button type="button" aria-pressed={urlMapOpen} onClick={() => { setUrlMapOpen(true); setConnectingId(null); }}>Map a URL</button>
      </div>
    </>;
  const addActions = <DismissibleDetails className="knowledge-map-add" onKeyDown={(event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus();
  }}>
    <summary aria-label="Add to map">+ Add</summary>
    <div>
      <button type="button" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onCreateMapNote({}); }}>New note</button>
      {onAddTopicConnections && publicMapAccount ? <button type="button" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); setSourcesFor("add"); }}>From Wikipedia</button> : null}
      <button type="button" aria-expanded={sourceFormOpen} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); setSourceFormOpen(!sourceFormOpen); }}>Add web source</button>
    </div>
  </DismissibleDetails>;

  return <section className="knowledge-graph-workspace" aria-label="Knowledge maps">
    {urlMapOpen ? <header className="knowledge-map-switcher">{mapControls}</header> : null}
    {mode === "personal" && !urlMapOpen && sourceFormOpen ? <form className="map-source-form" onSubmit={(event) => {
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
    {mode === "personal" && !urlMapOpen && connectingId ? <div className="map-workspace-notice" role="status">Choose a second node to connect with {personalProps.conversations[connectingId]?.title}.<button type="button" onClick={() => setConnectingId(null)}>Cancel</button></div> : null}
    {mapEditMessage ? <div className="map-workspace-notice" role="status">{mapEditMessage}{canUndoMapEdit ? <button type="button" onClick={onUndoMapEdit}>Undo</button> : null}</div> : null}
    {expandingTopicId ? <div className="map-workspace-notice" role="status" aria-live="polite"><span>{topicExpansionProgress || "Building an AI subgraph…"} · {personalProps.conversations[expandingTopicId]?.title}</span><button type="button" onClick={onCancelTopicExpansion}>Cancel expansion</button></div> : null}
    {topicExpansionError ? <div className="map-workspace-notice is-error" role="alert"><span>{topicExpansionError.message}</span>{personalProps.conversations[topicExpansionError.conversationId] ? <button type="button" disabled={Boolean(expandingTopicId)} onClick={() => onExpandTopicWithAI?.(topicExpansionError.conversationId)}>Retry AI expansion</button> : null}<button type="button" onClick={onDismissTopicExpansionError}>Dismiss</button></div> : null}
    <div className="knowledge-map-panel" hidden={mode !== "personal" || urlMapOpen}>
      <ConversationGraphView {...personalProps} isVisible={isVisible && mode === "personal" && !urlMapOpen} renderNodeActions={renderActions}
        renderSearchFallback={(query, close) => query.length >= 2 ? <SearchFallbackActions query={query} canAsk={!!publicMapAccount?.canAsk} onChoose={(source) => {
          close(); setSourcesFor(null); setConnectingId(null);
          setSearchFallback({ query, source, requestId: ++counter.current });
        }} /> : null} renderNodeMenuActions={renderMenuActions} connectingConversationId={connectingId}
        toolbarLeading={personalVisible ? <div className="knowledge-map-switcher is-inline">{mapControls}</div> : null}
        toolbarTrailing={personalVisible ? addActions : null}
        focusRequest={personalProps.focusRequest ?? personalFocus}
        onFocusRequestHandled={(id) => { if (personalProps.focusRequest?.requestId === id) personalProps.onFocusRequestHandled?.(id); else setPersonalFocus(null); }}
        onConnectConversation={(source, target) => { if (source !== target) { onSetMapConnection(source, target, true); setConnectingId(null); } }}
        onRemoveConnection={(source, target) => onSetMapConnection(source, target, false)} />
      {personalVisible && sourcesFor && publicMapAccount && onAddTopicConnections && (sourcesFor === "add" || sourceNote) ? <MapTopicSourcesPanel
        note={sourcesFor === "add" ? null : sourceNote} account={publicMapAccount} onClose={() => setSourcesFor(null)}
        onAddTopic={(topic) => { onSavePublicTopic(topic); setAddedTopicId(topic.id); }}
        onAddConnections={onAddTopicConnections}
        onSaveAnswer={(id, answer) => onSavePrivateAnswer?.(id, answer)}
        onExplorePublic={(topic) => { setSourcesFor(null); setPublicFocus({ id: topic.id, requestId: ++counter.current, topic }); setMode("public"); }} /> : null}
      {personalVisible && searchFallback && !sourcesFor ? <MapSearchFallbackPanel key={searchFallback.requestId} query={searchFallback.query} source={searchFallback.source}
        account={publicMapAccount} onClose={() => setSearchFallback(null)}
        onAddTopic={(topic) => { onSavePublicTopic(topic); setAddedTopicId(topic.id); }} topicActionLabel="Add to my map"
        isTopicAdded={(topic) => Boolean(savedTopics[topic.id])}
        onSaveAnswer={onSavePrivateAnswer ? (answer) => onSavePrivateAnswer(null, answer) : undefined}
        onOpenRelated={onSavePublicTopic} relatedActionLabel="Add to my map" /> : null}
    </div>
    <div className="knowledge-map-panel" hidden={mode !== "public" || urlMapOpen}>
      <PublicKnowledgeMap isVisible={isVisible && mode === "public" && !urlMapOpen} explorerContainer={personalProps.explorerContainer} onOpenExplorer={personalProps.onOpenExplorer} onFocusCanvas={personalProps.onFocusCanvas} key={personalProps.workspaceKey} workspaceKey={personalProps.workspaceKey ?? "workspace"} focusRequest={isVisible ? publicFocus : null} searchRequest={isVisible ? publicSearch : null}
        onFocusRequestHandled={(id) => setPublicFocus((request) => request?.requestId === id ? null : request)}
        onSearchRequestHandled={(id) => setPublicSearch((request) => request?.requestId === id ? null : request)}
        savedTopics={savedTopics} onSave={onSavePublicTopic} onShowInMyMap={showPersonal} account={publicMapAccount}
        toolbarLeading={mode === "public" && !urlMapOpen ? <div className="knowledge-map-switcher is-inline">{mapControls}</div> : null} />
    </div>
    <div className="knowledge-map-panel" hidden={!urlMapOpen}>
      <UrlMapPanel key={personalProps.workspaceKey} workspaceKey={personalProps.workspaceKey ?? "workspace"} conversations={personalProps.conversations}
        aiOptions={urlMapAIOptions} onSave={onSaveUrlMapNode}
        onShowInMyMap={(id) => { setUrlMapOpen(false); showPersonal(id); }}
        onExplorePublic={(query) => { setUrlMapOpen(false); setPublicSearch({ query, requestId: ++counter.current }); setMode("public"); }} />
    </div>
  </section>;
}
