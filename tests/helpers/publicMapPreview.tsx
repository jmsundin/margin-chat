import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import KnowledgeGraphWorkspace from "../../client/src/components/KnowledgeGraphWorkspace";
import StandaloneNotePanel from "../../client/src/components/StandaloneNotePanel";
import { createEmptyState } from "../../client/src/initialState";
import { addMapChildNote, createMapNote, setPersonalMapConnection } from "../../client/src/lib/graphWorkspaceEdits";
import { useTopicExpansion } from "../../client/src/lib/useTopicExpansion";
import { savePublicTopic } from "../../client/src/lib/publicTopicWorkspace";
import { buildThreadSummaries } from "../../client/src/lib/conversationSearch";
import "../../client/src/styles.css";

/** Synthetic personal workspace; public search/expansion uses the real Wikimedia API. */
function Preview() {
  const [state, setState] = useState(() => createMapNote(createEmptyState(), { id: "research", noteId: "research-note", createdAt: "2026-09-20T12:00:00Z" }));
  const [focus, setFocus] = useState<{ conversationId: string; requestId: number; openReader?: boolean; neighborhoodDepth?: number; preserveMapMode?: boolean } | null>(null);
  const counter = useRef(0);
  const expansion = useTopicExpansion({ state, setState, userId: "preview", onAuthExpired() {}, onBillingRefresh() {}, onReady: (conversationId) => setFocus({ conversationId, requestId: ++counter.current, neighborhoodDepth: 2, preserveMapMode: true }) });
  function reader(id: string) {
    const conversation = state.conversations[id];
    return conversation.kind === "note" ? <StandaloneNotePanel conversation={conversation} isActive={true} onActivate={() => {}}
      onRename={(id, title) => setState((current) => ({ ...current, conversations: { ...current.conversations, [id]: { ...current.conversations[id], title } } }))}
      onUpdate={(id, noteId, content) => setState((current) => ({ ...current, conversations: { ...current.conversations, [id]: { ...current.conversations[id], notes: current.conversations[id].notes!.map((note) => note.id === noteId ? { ...note, content } : note) } } }))}
      registerPanelRef={() => {}} /> : <p>Fixture chat</p>;
  }
  return <main style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
    <KnowledgeGraphWorkspace workspaceKey="public-map-preview" activeConversationId={state.activeConversationId} conversations={state.conversations} groups={state.groups} graphLayouts={state.graphLayouts} threads={buildThreadSummaries(state.conversations)} focusRequest={focus} onFocusRequestHandled={() => setFocus(null)}
      onExpandTopicWithAI={(id) => { void expansion.expand(id); }} onCancelTopicExpansion={expansion.cancel} expandingTopicId={expansion.pendingId} topicExpansionProgress={expansion.progress} topicExpansionError={expansion.error} onDismissTopicExpansionError={expansion.dismissError}
      onAddChildNote={(parentId) => { const id = `child-${++counter.current}`; setState((current) => addMapChildNote(current, { parentId, id, noteId: `${id}-body`, createdAt: new Date().toISOString() })); setFocus({ conversationId: id, requestId: counter.current, openReader: true }); }}
      onActivateConversation={(id) => setState((current) => ({ ...current, activeConversationId: id }))} onAssignGroup={() => {}} onCreateChildConversation={() => null} onOpenConversation={(id) => setFocus({ conversationId: id, requestId: ++counter.current })} onToggleGroup={() => {}}
      onUpdateGraphNodeLayouts={(layouts) => setState((current) => ({ ...current, graphLayouts: Object.fromEntries(Object.entries(current.graphLayouts).map(([id, layout]) => [id, { ...layout, ...layouts[id] }])) }))}
      renderDockedConversation={reader} renderExpandedConversation={reader}
      onSavePublicTopic={(topic) => setState((current) => savePublicTopic(current, topic).state)}
      onCreateMapNote={(args) => { const id = `fixture-note-${++counter.current}`; setState((current) => createMapNote(current, { ...args, id, noteId: `${id}-body`, createdAt: new Date().toISOString() })); setFocus({ conversationId: id, requestId: counter.current }); }}
      onSetMapConnection={(source, target, connected) => setState((current) => setPersonalMapConnection(current, source, target, connected, new Date().toISOString()))}
      onRemoveMapNote={() => {}} onUndoMapEdit={() => {}} />
    <output style={{ padding: 4, fontSize: 12 }}>Preview workspace · {Object.values(state.conversations).filter((conversation) => conversation.publicTopic).length} saved public topics · AI responses are synthetic test data</output>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
