import { useState } from "react";
import { createRoot } from "react-dom/client";
import KnowledgeGraphWorkspace from "../../client/src/components/KnowledgeGraphWorkspace";
import { createEmptyState } from "../../client/src/initialState";
import { saveUrlMapNode } from "../../client/src/lib/urlMap";
import "../../client/src/styles.css";

function Preview() {
  const [state, setState] = useState(createEmptyState);
  return <main style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
    <KnowledgeGraphWorkspace workspaceKey="url-map-preview" activeConversationId={state.activeConversationId} conversations={state.conversations} groups={state.groups} graphLayouts={state.graphLayouts}
      onActivateConversation={(id) => setState((current) => ({ ...current, activeConversationId: id }))} onAssignGroup={() => {}} onCreateChildConversation={() => null} onOpenConversation={() => {}} onToggleGroup={() => {}}
      onSavePublicTopic={() => {}} onCreateMapNote={() => {}} onSetMapConnection={() => {}} onRemoveMapNote={() => {}} onUndoMapEdit={() => {}}
      onSaveUrlMapNode={(graph, nodeId) => setState((current) => saveUrlMapNode(current, graph, nodeId))}
      renderDockedConversation={(id) => <div style={{ padding: 20 }}><h2>{state.conversations[id].title}</h2><pre style={{ whiteSpace: "pre-wrap" }}>{state.conversations[id].notes?.[0]?.content}</pre></div>} />
    <output style={{ padding: 5, fontSize: 12 }}>URL-map test fixture · {Object.keys(state.conversations).length - 1} saved topics</output>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
