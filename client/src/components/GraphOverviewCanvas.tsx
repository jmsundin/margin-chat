import { useId, useMemo, useState } from "react";
import type { Conversation } from "../types";
import type { GraphExplorationOverviewItem } from "./GraphExplorationPanel";
import "./GraphOverviewCanvas.css";

export interface GraphOverviewCanvasProps {
  items: GraphExplorationOverviewItem[];
  memberships: Record<string, string[]>;
  conversations: Record<string, Conversation>;
  selectedTopicId?: string | null;
  onSelectTopic?: (id: string) => void;
  onOpen: (id: string) => void;
  onInspectConnection: (sourceIds: string[]) => void;
}

interface OverviewBranch {
  parentConversationId: string;
  childConversationId: string;
}

export interface GraphOverviewConnection {
  targetId: string;
  sharedConversationIds: string[];
  outgoingBranches: OverviewBranch[];
  incomingBranches: OverviewBranch[];
}

/** Connections describe membership and ancestry only; they make no claim of agreement. */
export function getGraphOverviewConnections(
  selectedId: string,
  items: GraphExplorationOverviewItem[],
  memberships: Record<string, string[]>,
  conversations: Record<string, Conversation>,
): GraphOverviewConnection[] {
  const liveIds = (id: string) => new Set((memberships[id] ?? []).filter((sourceId) => Object.hasOwn(conversations, sourceId)));
  const selected = liveIds(selectedId);
  return items.filter((item) => item.id !== selectedId).map((item): GraphOverviewConnection => {
    const target = liveIds(item.id);
    const sharedConversationIds = [...selected].filter((id) => target.has(id));
    const outgoingBranches: OverviewBranch[] = [];
    const incomingBranches: OverviewBranch[] = [];
    for (const conversation of Object.values(conversations)) {
      const parentId = conversation.parentId;
      if (!parentId || !Object.hasOwn(conversations, parentId)) continue;
      const branch = { parentConversationId: parentId, childConversationId: conversation.id };
      // Edges internal to either hub stay inside that hub. Shared memberships are counted above.
      if (selected.has(parentId) && !selected.has(conversation.id) && target.has(conversation.id) && !target.has(parentId)) {
        outgoingBranches.push(branch);
      } else if (target.has(parentId) && !target.has(conversation.id) && selected.has(conversation.id) && !selected.has(parentId)) {
        incomingBranches.push(branch);
      }
    }
    return { targetId: item.id, sharedConversationIds, outgoingBranches, incomingBranches };
  }).filter((connection) => connection.sharedConversationIds.length || connection.outgoingBranches.length || connection.incomingBranches.length);
}

function branchSources(branches: OverviewBranch[]) {
  return [...new Set(branches.flatMap((branch) => [branch.parentConversationId, branch.childConversationId]))];
}

function ConnectionGlyph({ direction }: { direction: "shared" | "outgoing" | "incoming" }) {
  return <svg className="graph-overview-connection-glyph" viewBox="0 0 66 18" width="66" height="18" aria-hidden="true">
    <circle cx="5" cy="9" r="3" />
    <path d="M9 9 H57" strokeDasharray={direction === "shared" ? "3 4" : undefined} />
    <circle cx="61" cy="9" r="3" />
    {direction === "outgoing" ? <path d="m49 5 5 4-5 4" /> : null}
    {direction === "incoming" ? <path d="m17 5-5 4 5 4" /> : null}
  </svg>;
}

export default function GraphOverviewCanvas({ items, memberships, conversations, selectedTopicId, onSelectTopic, onOpen, onInspectConnection }: GraphOverviewCanvasProps) {
  const headingId = useId();
  const connectionsId = useId();
  const visibleItems = useMemo(() => items.some((item) => item.kind === "Group" || item.kind === "Concept")
    ? items.filter((item) => item.kind !== "Category") : items, [items]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const effectiveSelectedId = selectedTopicId === undefined ? selectedId : selectedTopicId;
  const selected = visibleItems.find((item) => item.id === effectiveSelectedId) ?? visibleItems[0];
  function selectTopic(id: string) {
    if (selectedTopicId === undefined) setSelectedId(id);
    onSelectTopic?.(id);
  }
  const connections = useMemo(() => selected
    ? getGraphOverviewConnections(selected.id, visibleItems, memberships, conversations) : [],
  [selected, visibleItems, memberships, conversations]);
  const connectedIds = useMemo(() => new Set(connections.map((connection) => connection.targetId)), [connections]);
  const totalSources = useMemo(() => new Set(visibleItems.flatMap((item) => memberships[item.id] ?? [])
    .filter((id) => Object.hasOwn(conversations, id))).size, [visibleItems, memberships, conversations]);

  return <section className="graph-overview-canvas" aria-labelledby={headingId} data-graph-ui="true">
    <header className="graph-overview-header">
      <div>
        <span className="graph-overview-eyebrow">The big picture</span>
        <h2 id={headingId}>Your ideas, connected</h2>
        <p>Select a topic to see its connections. Explore it to reach the original chats and notes.</p>
      </div>
      <span className="graph-overview-total">{visibleItems.length} {visibleItems.length === 1 ? "topic" : "topics"}<span aria-hidden="true"> · </span>{totalSources} {totalSources === 1 ? "source" : "sources"}</span>
    </header>
    {!visibleItems.length ? <p className="graph-overview-empty">Create a group or concept to start exploring your workspace.</p> :
      <div className="graph-overview-layout">
        <div className="graph-overview-hubs" aria-label="Map topics">
          {visibleItems.map((item) => {
            const current = item.id === selected?.id;
            const connected = connectedIds.has(item.id);
            const count = new Set((memberships[item.id] ?? []).filter((id) => Object.hasOwn(conversations, id))).size;
            return <article key={item.id} className={`graph-overview-hub${current ? " is-selected" : ""}${connected ? " is-connected" : ""}`} data-kind={item.kind}>
              <button className="graph-overview-hub-select" type="button" aria-pressed={current}
                aria-controls={connectionsId} onClick={() => selectTopic(item.id)}>
                <span className="graph-overview-hub-meta"><span>{item.kind}</span><span>{count} {count === 1 ? "source" : "sources"}</span></span>
                <strong>{item.label}</strong>
                {item.description ? <span className="graph-overview-description">{item.description}</span> : null}
                {item.examples.length ? <span className="graph-overview-examples"><span>Including</span>{item.examples.slice(0, 2).join(" · ")}</span> : null}
              </button>
              <footer>
                <span className="graph-overview-hub-status">{current ? "Selected topic" : connected ? "Connected to selection" : "Select to see connections"}</span>
                <button type="button" className="graph-overview-explore" aria-label={`Explore ${item.label}`} onClick={() => onOpen(item.id)}>Explore <span aria-hidden="true">↗</span></button>
              </footer>
            </article>;
          })}
        </div>
        <aside className="graph-overview-connections" id={connectionsId} aria-label="Selected topic connections">
          <header><span className="graph-overview-eyebrow">Connections from</span><h3>{selected?.label}</h3>
            <p>Shared sources appear in both topics. Branches follow conversation ancestry.</p></header>
          {connections.length ? <ul>{connections.map((connection) => {
            const target = visibleItems.find((item) => item.id === connection.targetId)!;
            return <li key={connection.targetId}>
              <button className="graph-overview-target" type="button" onClick={() => selectTopic(target.id)} title={`Select ${target.label}`}><span>{target.label}</span><span aria-hidden="true">↗</span></button>
              {connection.sharedConversationIds.length ? <button className="graph-overview-connection" type="button" onClick={() => onInspectConnection(connection.sharedConversationIds)}
                aria-label={`Inspect ${connection.sharedConversationIds.length} shared ${connection.sharedConversationIds.length === 1 ? "source" : "sources"} between ${selected?.label} and ${target.label}`}>
                <ConnectionGlyph direction="shared" /><span>{connection.sharedConversationIds.length} shared {connection.sharedConversationIds.length === 1 ? "source" : "sources"}</span><span className="graph-overview-inspect">Inspect</span>
              </button> : null}
              {connection.outgoingBranches.length ? <button className="graph-overview-connection" type="button" onClick={() => onInspectConnection(branchSources(connection.outgoingBranches))}
                aria-label={`Inspect ${connection.outgoingBranches.length} ${connection.outgoingBranches.length === 1 ? "branch" : "branches"} from ${selected?.label} to ${target.label}`}>
                <ConnectionGlyph direction="outgoing" /><span>{connection.outgoingBranches.length} {connection.outgoingBranches.length === 1 ? "branch" : "branches"} to this topic</span><span className="graph-overview-inspect">Inspect</span>
              </button> : null}
              {connection.incomingBranches.length ? <button className="graph-overview-connection" type="button" onClick={() => onInspectConnection(branchSources(connection.incomingBranches))}
                aria-label={`Inspect ${connection.incomingBranches.length} ${connection.incomingBranches.length === 1 ? "branch" : "branches"} from ${target.label} to ${selected?.label}`}>
                <ConnectionGlyph direction="incoming" /><span>{connection.incomingBranches.length} {connection.incomingBranches.length === 1 ? "branch" : "branches"} from this topic</span><span className="graph-overview-inspect">Inspect</span>
              </button> : null}
            </li>;
          })}</ul> : <p className="graph-overview-no-connections">No shared sources or branches connect this topic to the other topics yet.</p>}
        </aside>
      </div>}
  </section>;
}
