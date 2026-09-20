import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ConversationGraphView from "../../client/src/components/ConversationGraphView";
import GraphSourceFocus from "../../client/src/components/GraphSourceFocus";
import { createChildConversation, createMainConversation, createStandaloneNoteConversation } from "../../client/src/initialState";
import { buildThreadSummaries } from "../../client/src/lib/conversationSearch";
import { assignConversationToGroup, getConversationGroupId } from "../../client/src/lib/conversationGroups";
import { createDefaultGraphNodeLayout } from "../../client/src/lib/graphLayout";
import type { Conversation, ConversationGroup, GraphNodeLayout } from "../../client/src/types";
import type { GraphEvidenceRef } from "../../client/src/lib/graphExploration";
import "../../client/src/styles.css";

const createdAt = "2026-09-19T12:00:00.000Z";

/** Synthetic fixture only. No authentication, API, vault, or real workspace access. */
function createFixture() {
  const conversations: Record<string, Conversation> = {};
  const layouts: Record<string, GraphNodeLayout> = {};
  function chat(id: string, title: string, content: string, x: number, y: number, parentId?: string) {
    const parent = parentId ? conversations[parentId] : null;
    const conversation = parent
      ? createChildConversation({ id, createdAt, parentConversation: parent })
      : createMainConversation({ id, createdAt });
    conversation.title = title;
    conversation.messages = [
      { id: `${id}-question`, role: "user", content: `How should we explore ${title.toLowerCase()}?`, createdAt },
      { id: `${id}-answer`, role: "assistant", content, createdAt },
      { id: `${id}-followup`, role: "user", content: "Show the evidence behind that recommendation.", createdAt },
      { id: `${id}-detail`, role: "assistant", content: "A concrete example keeps the overview connected to its sources. We should be able to return to the same place after reading the details.", createdAt },
    ];
    if (parent) {
      const message = parent.messages[1];
      const quote = message.content.split(". ")[0];
      conversation.branchAnchor = {
        id: `${id}-origin`, sourceConversationId: parent.id, sourceMessageId: message.id,
        startOffset: 0, endOffset: quote.length, quote,
        prompt: conversation.messages[0].content, createdAt,
      };
      parent.childIds.push(id);
    }
    conversations[id] = conversation;
    layouts[id] = createDefaultGraphNodeLayout({ x, y, positioned: true });
  }
  function note(id: string, title: string, content: string, x: number, y: number) {
    const conversation = createStandaloneNoteConversation({ id, noteId: `${id}-body`, createdAt });
    conversation.title = title;
    conversation.notes![0].content = content;
    conversations[id] = conversation;
    layouts[id] = createDefaultGraphNodeLayout({ x, y, positioned: true });
  }
  chat("atlas", "An atlas of ideas", "A useful knowledge map connects high-level themes to exact source passages. People need to see both the territory and the evidence behind each idea.", -750, -400);
  chat("theme-map", "Themes across conversations", "A concept can belong to many conversations at once. Overview cards should explain the shared idea and show how much evidence supports it.", -50, -580, "atlas");
  chat("evidence", "Evidence and provenance", "Every substantive relationship needs a source. Exact message references help readers verify a summary without losing their place.", -50, 150, "atlas");
  chat("relation-types", "Different kinds of connections", "Conversation ancestry is different from concept membership. Suggested relevance should be explicitly identified as a suggestion.", 650, -580, "theme-map");
  chat("source-jumps", "From concepts to source passages", "A source jump should open the exact passage in a docked reader. If the passage changed, the interface should say so instead of highlighting unrelated text.", 650, 150, "evidence");
  chat("back-stack", "Return without losing your place", "Back and Forward should restore the viewport, current scope, selected conversation, and reader state. Stable positions preserve spatial memory.", 1350, 150, "source-jumps");
  chat("research", "Study exploration behavior", "Evaluate whether people can name the main themes, discover a bridge between discussions, and verify a claim using its original source.", -750, 950);
  chat("discovery", "Discover unexpected connections", "Start from a search result, reveal nearby conversations, and expand only what helps answer the current question.", -50, 950, "research");
  chat("evaluation", "Measure source verification", "Measure time to find supporting evidence and whether people can explain the meaning of a connection. Count wrong turns as well as successful clicks.", 650, 950, "discovery");
  chat("accessibility", "Keyboard and small screens", "Readers should reach every map action with a keyboard. A narrow screen should keep evidence readable and preserve a clear route back to the overview.", 1350, 950);
  note("design-note", "Overview design notes", "# Theme cards\n\nUse a short description, representative conversations, and a source count.\n\n## Open question\n\nHow can overlapping concepts remain easy to scan?", -750, -1150);
  note("memory-note", "Spatial memory checklist", "# Return to the same place\n\n- Keep the camera when leaving the map.\n- Preserve the selected source.\n- Keep account histories separate.\n\nSearch should reveal a result on the map.", -50, -1150);
  note("limits-note", "Coverage and uncertainty", "# Explain coverage\n\nAn overview should say what was indexed. Related suggestions based on a sample cannot stand in for a complete concept index.", 650, -1150);
  note("release-note", "Exploration acceptance tasks", "# Walkthrough\n\n1. Find a shared theme.\n2. Enter its conversations.\n3. Inspect an exact source.\n4. Return to the overview.\n5. Follow a connection across a collapsed group.", 1350, -1150);
  const groups: Record<string, ConversationGroup> = {
    research: { id: "research", name: "Concept research", color: "#4fbf9f", collapsed: false, conversationIds: ["atlas", "theme-map", "evidence", "design-note"] },
    implementation: { id: "implementation", name: "Navigation design", color: "#6f88ff", collapsed: true, conversationIds: ["relation-types", "source-jumps", "back-stack", "memory-note"] },
  };
  return { conversations, layouts, groups };
}

function PreviewReader({ conversation, source }: { conversation: Conversation; source?: GraphEvidenceRef | null }) {
  const panelRef = useRef<HTMLElement | null>(null);
  return <>
    <GraphSourceFocus source={source} getPanelElement={() => panelRef.current} />
    <article className="chat-panel is-active" ref={panelRef}>
      <div className="panel-body" style={{ overflow: "auto" }}>
        <header style={{ padding: "20px 24px" }}><h2>{conversation.title}</h2><p>Synthetic preview content</p></header>
        <div className="message-list" style={{ padding: "0 24px 32px" }}>
          {conversation.kind === "note" ? <p style={{ whiteSpace: "pre-wrap" }}>{conversation.notes?.[0]?.content}</p> : conversation.messages.map((message) =>
            <section key={message.id} className={`message-row is-${message.role}`} data-message-row-id={message.id} tabIndex={-1}>
              <div className={`message-bubble is-${message.role}`}><div className="message-meta"><span>{message.role}</span></div><p>{message.content}</p></div>
            </section>,
          )}
        </div>
      </div>
    </article>
  </>;
}

function GraphExplorationPreview() {
  const [fixture, setFixture] = useState(createFixture);
  const [activeId, setActiveId] = useState("atlas");
  const [view, setView] = useState<"graph" | "chat">("graph");
  const [dark, setDark] = useState(true);
  const [focusRequest, setFocusRequest] = useState<{ conversationId: string; requestId: number } | null>(null);
  const focusRequestCounterRef = useRef(0);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  const threads = buildThreadSummaries(fixture.conversations).map((thread) => ({ ...thread, groupId: getConversationGroupId(fixture.groups, thread.id) }));
  function reveal(conversationId: string) {
    setActiveId(conversationId);
    setView("graph");
    setFocusRequest({ conversationId, requestId: ++focusRequestCounterRef.current });
  }
  return <main style={{ height: "100dvh", display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg)" }}>
    <header style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 12, padding: "10px 16px", borderBottom: "1px solid var(--line)", flex: "0 0 auto" }}>
      <strong>Graph exploration preview</strong><span style={{ fontSize: 12, color: "var(--muted)" }}>14 synthetic items · no workspace data</span>
      <button type="button" onClick={() => reveal("back-stack")}>Reveal deep branch</button>
      <button type="button" onClick={() => setDark((value) => !value)}>{dark ? "Light" : "Dark"} theme</button>
      {view === "chat" ? <button type="button" onClick={() => setView("graph")}>Return to map</button> : null}
    </header>
    {view === "chat" ? <PreviewReader conversation={fixture.conversations[activeId]} /> :
      <ConversationGraphView
        workspaceKey="graph-exploration-preview"
        activeConversationId={activeId}
        conversations={fixture.conversations}
        groups={fixture.groups}
        graphLayouts={fixture.layouts}
        threads={threads}
        focusRequest={focusRequest}
        onFocusRequestHandled={(requestId) => setFocusRequest((current) => current?.requestId === requestId ? null : current)}
        relatedItems={[{ id: activeId === "memory-note" ? "design-note" : "memory-note", score: 0.9 }]}
        relatedStatus="ready"
        onActivateConversation={setActiveId}
        onAssignGroup={(id, groupId) => setFixture((current) => ({ ...current, groups: assignConversationToGroup(current.groups, id, groupId) }))}
        onCreateChildConversation={(parentId) => {
          const id = `preview-child-${Date.now()}`;
          const child = createChildConversation({ id, parentConversation: fixture.conversations[parentId] });
          child.title = "A new exploration branch";
          setFixture((current) => ({ ...current, conversations: {
            ...current.conversations,
            [parentId]: { ...current.conversations[parentId], childIds: [...current.conversations[parentId].childIds, id] },
            [id]: child,
          } }));
          return id;
        }}
        onOpenConversation={(id) => { setActiveId(id); setView("chat"); }}
        onToggleGroup={(id) => setFixture((current) => ({ ...current, groups: { ...current.groups, [id]: { ...current.groups[id], collapsed: !current.groups[id].collapsed } } }))}
        onUpdateGraphNodeLayouts={(updates) => setFixture((current) => ({ ...current, layouts: {
          ...current.layouts,
          ...Object.fromEntries(Object.entries(updates).map(([id, layout]) => [id, { ...createDefaultGraphNodeLayout(), ...current.layouts[id], ...layout }])),
        } }))}
        renderDockedConversation={(id, source) => <PreviewReader conversation={fixture.conversations[id]} source={source} />}
        renderExpandedConversation={(id) => <PreviewReader conversation={fixture.conversations[id]} />}
      />}
  </main>;
}

createRoot(document.getElementById("root")!).render(<GraphExplorationPreview />);
