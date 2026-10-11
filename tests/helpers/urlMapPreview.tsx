import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import KnowledgeGraphWorkspace from "../../client/src/components/KnowledgeGraphWorkspace";
import { createEmptyState } from "../../client/src/initialState";
import { createMapNote, setPersonalMapConnection } from "../../client/src/lib/graphWorkspaceEdits";
import { keepExploredItems } from "../../client/src/lib/keepExplored";
import "../../client/src/styles.css";

/** A small workspace for trying the map search: links, questions and Wikipedia previews. */
function seed() {
  let state = createEmptyState();
  const notes: Array<[string, string, string, number, number]> = [
    ["doc-angular", "Angular", "Notes on components, templates and dependency injection.", 120, 120],
    ["doc-signals", "Signals", "Fine-grained reactivity in Angular.", 120, 320],
    ["doc-rxjs", "RxJS", "Observables and operators.", 420, 220],
  ];
  for (const [id, title, content, x, y] of notes) state = createMapNote(state, { id, noteId: `${id}-note`, createdAt: "2026-10-11T00:00:00.000Z", title, content, position: { x, y } });
  state = setPersonalMapConnection(state, "doc-angular", "doc-signals", true, "2026-10-11T00:00:00.000Z");
  return setPersonalMapConnection(state, "doc-angular", "doc-rxjs", true, "2026-10-11T00:00:00.000Z");
}

function Preview() {
  const [state, setState] = useState(seed);
  const latest = useRef(state);
  latest.current = state;
  const params = new URLSearchParams(location.search);
  return <main style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
    <KnowledgeGraphWorkspace workspaceKey={params.get("key") ?? "map-preview"} activeConversationId={state.activeConversationId} conversations={state.conversations} groups={state.groups} graphLayouts={state.graphLayouts}
      onActivateConversation={(id) => setState((current) => ({ ...current, activeConversationId: id }))} onAssignGroup={() => {}} onCreateChildConversation={() => null} onOpenConversation={() => {}} onToggleGroup={() => {}}
      publicMapAccount={{ userId: params.get("user") ?? "url-map-preview", canAsk: params.get("member") !== "0", isAdmin: false }}
      onKeepExplored={(exploration, ids, detached) => {
        let sequence = 0;
        const { state: next, kept } = keepExploredItems(latest.current, exploration, ids, { createdAt: new Date().toISOString(), detached,
          newNote: (id) => ({ id: `kept-${Date.now()}-${++sequence}-${id.length}`, noteId: `kept-${Date.now()}-${sequence}-note` }) });
        setState(next);
        return kept;
      }}
      onSavePublicTopic={() => {}} onCreateMapNote={() => {}} onSetMapConnection={() => {}} onRemoveMapNote={() => {}} onUndoMapEdit={() => {}}
      renderDockedConversation={(id) => <div style={{ padding: 20 }}><h2>{state.conversations[id].title}</h2><pre style={{ whiteSpace: "pre-wrap" }}>{state.conversations[id].notes?.[0]?.content}</pre></div>} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
