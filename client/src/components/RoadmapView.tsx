import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Conversation, RoadmapNode } from "../types";
import { getEditableDocument } from "../lib/editableDocument";
import {
  buildRoadmapGraph, getRoadmap, plainPreview, roadmapDraftLink, roadmapNodeTitle, roadmapStatus, ROADMAP_STATUS_LABELS, type RoadmapChange,
} from "../lib/roadmap";
import DocumentLinkPicker from "./DocumentLinkPicker";
import AgentRunLog from "./AgentRunLog";
import RoadmapMap, { openSubKey, roadmapOfStep, type RoadmapMapStep } from "./RoadmapMap";
import StatusMark, { NEXT_ROADMAP_STATUS as NEXT_STATUS, ROADMAP_STATUSES as STATUSES } from "./RoadmapStatusMark";
import type { AgentProgress } from "../lib/useChatStreams";
import "./RoadmapView.css";

export interface RoadmapViewProps {
  conversation: Conversation;
  conversations: Record<string, Conversation>;
  /** Applies one edit; returns why it was refused, or null. */
  onChange: (change: RoadmapChange) => string | null;
  onOpen: (target: RoadmapNode["target"]) => void;
  /** Documents still only in the cloud: their steps wait for them instead of showing as missing. */
  cloudDocuments?: { id: string; title: string }[];
  /** Download steps' documents that are still only in the cloud. */
  onLoadTargets?: (ids: string[]) => void;
  /** Ask AI to draft stages and steps, from the vault for a goal or from a page whose link is given; returns why it couldn't start, or null. */
  onDraft?: (goal: string) => string | null;
  /** AI is writing in this document. */
  drafting?: boolean;
  /** Ask AI to write an explanation of a step's topic into its document; returns why it couldn't start, or null.
   * `roadmapId` names the roadmap the step is in when it is a sub-roadmap shown inside this one. */
  onExplain?: (docId: string, context: string, roadmapId?: string) => string | null;
  /** Ask AI to break a step's topic into its own roadmap, inside the step's document; returns why it couldn't start, or null. */
  onDiveDeeper?: (docId: string, roadmapId?: string) => string | null;
  /** Applies one edit to another roadmap shown inside this one (a step's own roadmap); returns why it was refused, or null. */
  onChangeRoadmap?: (roadmapId: string, change: RoadmapChange) => string | null;
  /** Shown inside another roadmap, under the step it belongs to: these roadmaps hold it, outermost first. */
  nestedIn?: string[];
  /** Documents AI is writing in now. */
  writingIds?: Record<string, unknown>;
  /** The agent's live progress while it drafts this roadmap: its steps, thinking, and the roadmap so far. */
  progress?: AgentProgress;
  budgetMicros?: number;
  onStop?: () => void;
  /** Approve or dismiss a roadmap the agent drafted for this document; returns why it couldn't, or null. */
  onDraftDecision?: (messageId: string, proposalId: string, action: "approve" | "dismiss") => string | null;
}

export type RoadmapLayoutMode = "list" | "map";
const LAYOUT_KEY = "margin-chat:roadmap-layout";
function savedLayout(): RoadmapLayoutMode {
  try { return window.localStorage?.getItem(LAYOUT_KEY) === "map" ? "map" : "list"; } catch { return "list"; }
}

type Picker = { mode: "add"; stageId: string } | { mode: "relink"; nodeId: string };
type EdgePath = { key: string; d: string; from: string; to: string };

function percent(finished: number, total: number) {
  return total ? Math.round((finished / total) * 100) : 0;
}

export default function RoadmapView({ conversation, conversations, onChange, onOpen, cloudDocuments, onLoadTargets, onDraft, drafting = false, onExplain, onDiveDeeper, writingIds, progress, budgetMicros, onStop, onDraftDecision, onChangeRoadmap, nestedIn }: RoadmapViewProps) {
  const roadmap = useMemo(() => getRoadmap(conversation), [conversation]);
  const graph = useMemo(() => buildRoadmapGraph(roadmap, conversations), [roadmap, conversations]);
  const nested = Boolean(nestedIn?.length);
  const [layoutChoice, setLayoutChoice] = useState<RoadmapLayoutMode>(savedLayout);
  const layout: RoadmapLayoutMode = nested ? "list" : layoutChoice;
  function chooseLayout(next: RoadmapLayoutMode) {
    setLayoutChoice(next);
    try { window.localStorage?.setItem(LAYOUT_KEY, next); } catch { /* the choice just isn't remembered */ }
  }
  // Steps whose own roadmap is open: beside the step on the map, under it in the list.
  const [openSubs, setOpenSubs] = useState<Set<string>>(() => new Set());
  const toggleSub = (step: RoadmapMapStep) => setOpenSubs((current) => {
    const next = new Set(current), key = openSubKey(step.roadmapId, step.nodeId);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  // On the map a step of an open sub-roadmap can be selected too.
  const [mapSelected, setMapSelected] = useState<RoadmapMapStep | null>(null);
  const [editing, setEditing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [picker, setPicker] = useState<Picker | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [draftOpen, setDraftOpen] = useState(false);
  const [goal, setGoal] = useState("");
  const draftLink = useMemo(() => roadmapDraftLink(goal), [goal]);
  const draftLinkName = useMemo(() => {
    if (!draftLink) return "";
    const url = new URL(draftLink);
    const path = url.pathname.replace(/\/$/u, "");
    return `${url.hostname.replace(/^www\./u, "")}${path.length > 28 ? `${path.slice(0, 27)}…` : path}`;
  }, [draftLink]);
  const [edges, setEdges] = useState<EdgePath[]>([]);
  const spineRef = useRef<HTMLDivElement>(null);
  const selected = selectedId ? graph.nodesById.get(selectedId) ?? null : null;
  // A finished draft waits here, in the roadmap it is for, until it is added or discarded.
  const waitingDraft = useMemo(() => {
    for (const message of [...conversation.messages].reverse()) {
      const proposal = message.execution?.agent?.proposals?.find((item) => item.kind === "roadmap" && item.roadmapId === conversation.id && !item.status);
      if (proposal?.kind === "roadmap") return { messageId: message.id, proposal };
    }
    return null;
  }, [conversation.messages, conversation.id]);
  const working = drafting && Boolean(progress);
  const building = working ? progress?.roadmapDraft ?? null : null;
  const draftStages = building?.stages ?? (working ? null : waitingDraft?.proposal.stages) ?? null;
  const draftSteps = draftStages?.reduce((sum, stage) => sum + stage.steps.length, 0) ?? 0;
  const draftEnd = useRef<HTMLDivElement>(null);
  // While it is being written, the newest step stays in view.
  useEffect(() => { if (building) draftEnd.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" }); }, [building, draftSteps]);
  const empty = !roadmap.nodes.length;
  const showEditing = !nested && (editing || empty);
  // A new roadmap opens ready to edit and stays that way after its first step.
  useEffect(() => { if (empty && !nested) setEditing(true); }, [empty, nested]);
  // The map is for reading and moving through a roadmap; changing its shape happens in the list.
  const mapShown = layout === "map" && !empty && !showEditing;

  useEffect(() => { if (selectedId && !graph.nodesById.has(selectedId)) setSelectedId(null); }, [graph, selectedId]);
  const cloudTitles = useMemo(() => new Map((cloudDocuments ?? []).map((entry) => [entry.id, entry.title])), [cloudDocuments]);
  // Steps and their prerequisites only draw the same everywhere once every
  // target is on this device, so a roadmap brings its documents in.
  const waiting = useMemo(() => [...new Set(roadmap.nodes.map((node) => node.target.docId)
    .filter((id) => !conversations[id] && cloudTitles.has(id)))], [roadmap, conversations, cloudTitles]);
  const requested = useRef(new Set<string>());
  useEffect(() => {
    const ids = waiting.filter((id) => !requested.current.has(id));
    if (!ids.length || !onLoadTargets) return;
    for (const id of ids) requested.current.add(id);
    onLoadTargets(ids);
  }, [waiting, onLoadTargets]);
  const isWaiting = (node: RoadmapNode) => !conversations[node.target.docId] && cloudTitles.has(node.target.docId);
  useEffect(() => { setMessage(null); }, [conversation.id]);

  function change(next: RoadmapChange) {
    const error = onChange(next);
    setMessage(error);
    return !error;
  }

  // Prerequisite lines are drawn between the cards where the browser laid them
  // out, so they follow wrapping on any width.
  useLayoutEffect(() => {
    const spine = spineRef.current;
    if (!spine) return;
    const measure = () => {
      const box = spine.getBoundingClientRect();
      const rects = new Map<string, DOMRect>();
      for (const card of spine.querySelectorAll<HTMLElement>("[data-roadmap-node]")) rects.set(card.dataset.roadmapNode!, card.getBoundingClientRect());
      const next: EdgePath[] = [];
      for (const edge of graph.edges) {
        // Stages already read in order, so lines between stages show only for the selected step.
        const across = graph.nodesById.get(edge.from)?.stage !== graph.nodesById.get(edge.to)?.stage;
        if (across && selectedId !== edge.from && selectedId !== edge.to) continue;
        const from = rects.get(edge.to);
        const to = rects.get(edge.from);
        if (!from || !to) continue;
        const down = to.top >= from.bottom - 1;
        const x1 = from.left + from.width / 2 - box.left, x2 = to.left + to.width / 2 - box.left;
        const y1 = (down ? from.bottom : from.top) - box.top, y2 = (down ? to.top : to.bottom) - box.top;
        const bend = Math.max(18, Math.abs(y2 - y1) / 2) * (down ? 1 : -1);
        next.push({ key: `${edge.from}>${edge.to}`, from: edge.to, to: edge.from, d: `M${x1},${y1} C${x1},${y1 + bend} ${x2},${y2 - bend} ${x2},${y2}` });
      }
      setEdges((current) => current.length === next.length && current.every((edge, index) => edge.d === next[index].d && edge.key === next[index].key) ? current : next);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(spine);
    return () => observer?.disconnect();
  }, [graph, showEditing, selectedId, mapShown, openSubs]);

  const titleOf = (id: string) => { const node = graph.nodesById.get(id); return node ? roadmapNodeTitle(node, conversations) : "Missing step"; };

  // A step's own roadmap, unless it would show a roadmap that already holds this one.
  function subRoadmapOf(node: RoadmapNode) {
    const sub = roadmapOfStep(node, conversations);
    return sub && sub.id !== conversation.id && !nestedIn?.includes(sub.id) ? sub : null;
  }

  function renderCard(node: RoadmapNode) {
    const status = roadmapStatus(node);
    const pending = isWaiting(node);
    const missing = graph.missing.has(node.id) && !pending;
    const next = graph.nextUp.has(node.id);
    const locked = !missing && !pending && !next && status !== "done" && status !== "skipped";
    const title = pending ? (node.title ?? cloudTitles.get(node.target.docId) ?? "Loading…") : missing ? (node.title ?? "Missing document") : roadmapNodeTitle(node, conversations);
    const sub = subRoadmapOf(node);
    const subSteps = sub ? getRoadmap(sub).nodes.length : 0;
    const subOpen = Boolean(sub) && openSubs.has(openSubKey(conversation.id, node.id));
    const classes = ["roadmap-node", `is-${status}`, next ? "is-next" : "", locked ? "is-locked" : "", missing ? "is-missing" : "", pending ? "is-pending" : "", node.id === selectedId ? "is-selected" : ""].filter(Boolean).join(" ");
    return <div key={node.id} className={classes} data-roadmap-node={node.id}>
      {missing ? <span className="roadmap-node-mark" aria-hidden="true">?</span> : pending ? <span className="roadmap-node-mark" aria-hidden="true"><StatusMark status={status} /></span> : <button type="button" className="roadmap-node-mark"
        aria-label={`${title}: ${ROADMAP_STATUS_LABELS[status]}. Mark ${ROADMAP_STATUS_LABELS[NEXT_STATUS[status]].toLowerCase()}`}
        title={`Mark ${ROADMAP_STATUS_LABELS[NEXT_STATUS[status]].toLowerCase()}`}
        onClick={() => change({ kind: "status", nodeId: node.id, status: NEXT_STATUS[status] })}>
        <StatusMark status={status} />
      </button>}
      <button type="button" className="roadmap-node-open" aria-pressed={node.id === selectedId}
        aria-label={`${title}${missing ? ", target missing" : next ? ", next up" : ""}. Show details`}
        onClick={() => setSelectedId((current) => current === node.id ? null : node.id)}>
        <span className="roadmap-node-title">{title}</span>
        {pending ? <span className="roadmap-node-tag">Loading</span> : next ? <span className="roadmap-node-tag">Next up</span> : missing ? <span className="roadmap-node-tag">Missing</span> : null}
      </button>
      {sub && !showEditing ? <button type="button" className="roadmap-node-chip" aria-expanded={subOpen}
        title={subOpen ? "Close its roadmap" : "Show its roadmap here"}
        aria-label={`${subOpen ? "Close" : "Show"} the roadmap of ${title} (${subSteps} ${subSteps === 1 ? "step" : "steps"})`}
        onClick={() => toggleSub({ roadmapId: conversation.id, nodeId: node.id })}>
        {subSteps} {subSteps === 1 ? "step" : "steps"}<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 2l3 3-3 3" /></svg>
      </button> : null}
    </div>;
  }

  /** Details of a step in this roadmap or, on the map, in one of the sub-roadmaps open inside it. */
  function renderDetail(owner: Conversation, ownerGraph: ReturnType<typeof buildRoadmapGraph>, node: RoadmapNode, onClose: () => void, onSubToggle?: () => void, subOpen = false): ReactNode {
    const own = owner.id === conversation.id;
    const changeIn = (next: RoadmapChange) => {
      if (own) return change(next);
      const error = onChangeRoadmap ? onChangeRoadmap(owner.id, next) : "This roadmap can be changed from its own document.";
      setMessage(error);
      return !error;
    };
    const ownerTitleOf = (id: string) => { const item = ownerGraph.nodesById.get(id); return item ? roadmapNodeTitle(item, conversations) : "Missing step"; };
    const roadmapId = own ? undefined : owner.id;
    return <RoadmapDetail key={`${owner.id}/${node.id}`} node={node} graph={ownerGraph} pending={isWaiting(node)} conversations={conversations} editing={own && showEditing}
      stages={getRoadmap(owner).stages} titleOf={ownerTitleOf} onChange={changeIn} onOpen={onOpen} onClose={onClose}
      onRelink={() => setPicker({ mode: "relink", nodeId: node.id })}
      writing={Boolean(writingIds?.[node.target.docId])}
      subRoadmap={onSubToggle ? { open: subOpen, onToggle: onSubToggle } : undefined}
      onExplain={onExplain ? () => {
        // Where the step sits, so the explanation is pitched for this roadmap and not written in a vacuum.
        const stage = getRoadmap(owner).stages.find((item) => item.id === node.stage)?.title;
        const before = (ownerGraph.needs.get(node.id) ?? []).map(ownerTitleOf);
        const after = (ownerGraph.neededBy.get(node.id) ?? []).map(ownerTitleOf);
        const context = [stage ? `It is in the stage “${stage}”.` : "", before.length ? `I learn these first: ${before.join(", ")}.` : "",
          after.length ? `It leads on to: ${after.join(", ")}.` : ""].filter(Boolean).join(" ");
        const error = onExplain(node.target.docId, context, roadmapId); setMessage(error); return !error;
      } : undefined}
      onDiveDeeper={onDiveDeeper ? () => { const error = onDiveDeeper(node.target.docId, roadmapId); setMessage(error); return !error; } : undefined} />;
  }

  // The selected step opens in place, under its row, so what it says is read where it was clicked.
  const detail = selected && !mapShown ? renderDetail(conversation, graph, selected, () => setSelectedId(null)) : null;

  // On the map the selected step can be in any roadmap open on it.
  const mapOwner = mapSelected ? mapSelected.roadmapId === conversation.id ? conversation : conversations[mapSelected.roadmapId] : null;
  const mapOwnerGraph = useMemo(() => !mapOwner ? null : mapOwner.id === conversation.id ? graph : buildRoadmapGraph(getRoadmap(mapOwner), conversations),
    [mapOwner, conversation.id, graph, conversations]);
  const mapNode = mapSelected && mapOwnerGraph ? mapOwnerGraph.nodesById.get(mapSelected.nodeId) ?? null : null;
  useEffect(() => { if (mapSelected && !mapNode) setMapSelected(null); }, [mapSelected, mapNode]);
  const mapDetail = mapShown && mapOwner && mapOwnerGraph && mapNode ? renderDetail(mapOwner, mapOwnerGraph, mapNode, () => setMapSelected(null),
    roadmapOfStep(mapNode, conversations) ? () => toggleSub(mapSelected!) : undefined, openSubs.has(openSubKey(mapOwner.id, mapNode.id))) : null;

  return <section className={`roadmap${selected && !mapShown ? " has-detail" : ""}${nested ? " is-nested" : ""}`} aria-label={`Roadmap: ${conversation.title || "Untitled roadmap"}`}>
    <header className="roadmap-head">
      <div className="roadmap-progress" role="group" aria-label="Progress">
        <span className="roadmap-progress-label">{graph.total ? `${graph.finished} of ${graph.total} done` : "No steps yet"}</span>
        <span className="roadmap-bar" aria-hidden="true"><span style={{ width: `${percent(graph.finished, graph.total)}%` }} /></span>
        {graph.nextUp.size ? <span className="roadmap-progress-next">{graph.nextUp.size} next up</span> : null}
      </div>
      {!nested && !empty ? <div className="roadmap-layout-switch" role="group" aria-label="Layout">
        <button type="button" aria-pressed={layout === "list"} onClick={() => chooseLayout("list")} title="Stages as a list, one under another">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5h8M5 8h8M5 12.5h8M2.5 3.5h0M2.5 8h0M2.5 12.5h0" strokeLinecap="round" /></svg>List
        </button>
        <button type="button" aria-pressed={layout === "map"} onClick={() => { chooseLayout("map"); setEditing(false); }} title="Stages as connected boxes, with sub-roadmaps beside their steps">
          <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2" width="4.5" height="12" rx="1.2" /><rect x="10" y="2" width="4.5" height="7" rx="1.2" /><path d="M6 5.5h4" /></svg>Map
        </button>
      </div> : null}
      {onDraft && !draftOpen && !nested ? <button type="button" className="roadmap-edit-toggle" disabled={drafting}
        title="AI proposes stages and steps for you to approve, from your documents or from a link you paste" onClick={() => { setDraftOpen(true); setMessage(null); }}>
        {drafting ? "Drafting…" : "Draft with AI"}
      </button> : null}
      {!empty && !nested ? <button type="button" className="roadmap-edit-toggle" aria-pressed={editing} onClick={() => { setEditing(!editing); setMessage(null); }}>
        {editing ? "Done" : "Edit"}
      </button> : null}
    </header>
    {draftOpen && onDraft ? <form className="roadmap-draft" onSubmit={(event) => {
      event.preventDefault();
      if (!goal.trim()) return;
      const error = onDraft(goal.trim());
      setMessage(error);
      if (!error) { setDraftOpen(false); setGoal(""); }
    }}>
      <input autoFocus value={goal} maxLength={600} aria-label="What do you want to learn, or a link to build from" placeholder="What do you want to learn? Or paste a link"
        onChange={(event) => setGoal(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setDraftOpen(false); }} />
      <button type="submit" disabled={!goal.trim()}>{draftLink ? "Build from link" : "Draft"}</button>
      <button type="button" onClick={() => setDraftOpen(false)}>Cancel</button>
      {draftLink
        ? <p>AI reads <strong>{draftLinkName}</strong> and proposes its sections as stages and its topics as steps, using your documents where they fit and new ones for the rest. Nothing is added until you approve it.</p>
        : <p>AI searches your documents and proposes stages and steps below the roadmap. Paste a link to a roadmap, an article or an X post to build from that page instead. Nothing is added until you approve it.</p>}
    </form> : null}
    {message ? <p className="roadmap-message" role="alert">{message}<button type="button" aria-label="Dismiss" onClick={() => setMessage(null)}>×</button></p> : null}
    {graph.cycleEdges.length ? <p className="roadmap-message" role="note">
      Some prerequisites loop back on each other, so {graph.cycleEdges.length === 1 ? "one is" : `${graph.cycleEdges.length} are`} ignored:{" "}
      {graph.cycleEdges.map((edge) => `${titleOf(edge.from)} needs ${titleOf(edge.to)}`).join("; ")}.
    </p> : null}
    {working || draftStages ? <section className={`roadmap-build${working ? " is-live" : ""}`} aria-label="Roadmap draft" aria-busy={working}>
      <header className="roadmap-build-head">
        <strong>{working ? draftStages ? "Building the roadmap…" : "Agent is working…" : `Draft ready: ${draftStages!.length} ${draftStages!.length === 1 ? "stage" : "stages"}, ${draftSteps} ${draftSteps === 1 ? "step" : "steps"}`}</strong>
        {working && draftStages ? <span className="roadmap-build-count">{draftSteps} {draftSteps === 1 ? "step" : "steps"} so far</span> : null}
        {working && onStop ? <button type="button" onClick={onStop}>Stop</button> : null}
        {!working && waitingDraft && onDraftDecision ? <>
          <button type="button" className="is-primary" onClick={() => setMessage(onDraftDecision(waitingDraft.messageId, waitingDraft.proposal.id, "approve"))}>Add to roadmap</button>
          <button type="button" onClick={() => setMessage(onDraftDecision(waitingDraft.messageId, waitingDraft.proposal.id, "dismiss"))}>Discard</button>
        </> : null}
      </header>
      {working ? <AgentRunLog live steps={progress?.steps ?? []} spentMicros={progress?.spentMicros} thinking={progress?.thinking}
        activity={progress?.activity} label={progress?.label} since={progress?.since} budgetMicros={budgetMicros} /> : null}
      {draftStages ? <div className="roadmap-build-stages">
        {draftStages.map((stage, index) => <div key={index} className="roadmap-build-stage">
          <h3>{stage.title}</h3>
          <div className="roadmap-build-steps">{stage.steps.map((step, stepIndex) => <span key={stepIndex} className="roadmap-build-step">
            {step.title || (step.documentId ? conversations[step.documentId]?.title ?? cloudTitles.get(step.documentId) : "") || "Document from your vault"}
          </span>)}{working && index === draftStages.length - 1 ? <span className="roadmap-build-step is-writing" aria-hidden="true">…</span> : null}</div>
        </div>)}
        <div ref={draftEnd} />
      </div> : null}
    </section> : null}
    {mapShown ? <RoadmapMap conversation={conversation} graph={graph} conversations={conversations} open={openSubs} onToggle={toggleSub}
      selected={mapNode ? mapSelected : null} onSelect={setMapSelected} isWaiting={isWaiting} cloudTitles={cloudTitles} writingIds={writingIds} detail={mapDetail}
      onStatus={(step, status) => {
        if (step.roadmapId === conversation.id) { change({ kind: "status", nodeId: step.nodeId, status }); return; }
        setMessage(onChangeRoadmap ? onChangeRoadmap(step.roadmapId, { kind: "status", nodeId: step.nodeId, status }) : null);
      }} /> : <div className="roadmap-layout">
      <div className="roadmap-spine" ref={spineRef}>
        <svg className="roadmap-edges" aria-hidden="true">
          {edges.map((edge) => <path key={edge.key} d={edge.d}
            className={selectedId && (edge.from === selectedId || edge.to === selectedId) ? "is-active" : undefined} />)}
        </svg>
        {graph.stages.map((stage, stageIndex) => <section key={stage.id || "unstaged"} className="roadmap-stage" aria-label={stage.title}>
          <header className="roadmap-stage-head">
            {showEditing && !stage.unknown ? <input className="roadmap-stage-title-input" aria-label="Stage name" defaultValue={stage.title}
              key={stage.title} onBlur={(event) => { if (event.target.value.trim() && event.target.value !== stage.title) change({ kind: "rename-stage", stageId: stage.id, title: event.target.value }); }}
              onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
              : <h3 className="roadmap-stage-title">{stage.title}</h3>}
            <span className="roadmap-stage-count">{stage.finished}/{stage.total}</span>
            <span className="roadmap-bar is-small" aria-hidden="true"><span style={{ width: `${percent(stage.finished, stage.total)}%` }} /></span>
            {showEditing && !stage.unknown ? <span className="roadmap-stage-actions">
              <button type="button" aria-label={`Move ${stage.title} up`} title="Move up" disabled={stageIndex === 0}
                onClick={() => change({ kind: "move-stage", stageId: stage.id, direction: -1 })}>↑</button>
              <button type="button" aria-label={`Move ${stage.title} down`} title="Move down" disabled={stageIndex >= roadmap.stages.length - 1}
                onClick={() => change({ kind: "move-stage", stageId: stage.id, direction: 1 })}>↓</button>
              <button type="button" aria-label={`Remove ${stage.title}`} title="Remove stage"
                onClick={() => change({ kind: "remove-stage", stageId: stage.id })}>×</button>
            </span> : null}
          </header>
          {stage.rows.map((row, rowIndex) => <Fragment key={rowIndex}>
            <div className="roadmap-row">{row.nodeIds.map((id) => renderCard(graph.nodesById.get(id)!))}</div>
            {selectedId && row.nodeIds.includes(selectedId) ? detail : null}
            {showEditing ? null : row.nodeIds.map((id) => {
              const node = graph.nodesById.get(id)!, sub = subRoadmapOf(node);
              if (!sub || !openSubs.has(openSubKey(conversation.id, id))) return null;
              return <div key={`sub-${id}`} className="roadmap-nested">
                <p className="roadmap-nested-title">Roadmap of <strong>{sub.title || "Untitled roadmap"}</strong></p>
                <RoadmapView conversation={sub} conversations={conversations} nestedIn={[...(nestedIn ?? []), conversation.id]}
                  onChange={(next) => onChangeRoadmap ? onChangeRoadmap(sub.id, next) : "This roadmap can be changed from its own document."}
                  onChangeRoadmap={onChangeRoadmap} onOpen={onOpen} cloudDocuments={cloudDocuments} onLoadTargets={onLoadTargets} writingIds={writingIds}
                  onExplain={onExplain ? (docId, context, roadmapId) => onExplain(docId, context, roadmapId ?? sub.id) : undefined}
                  onDiveDeeper={onDiveDeeper ? (docId, roadmapId) => onDiveDeeper(docId, roadmapId ?? sub.id) : undefined} />
              </div>;
            })}
          </Fragment>)}
          {showEditing && !stage.unknown ? <button type="button" className="roadmap-add" onClick={() => setPicker({ mode: "add", stageId: stage.id })}>+ Add step</button> : null}
        </section>)}
        {showEditing ? <button type="button" className="roadmap-add is-stage" onClick={() => change({ kind: "add-stage", title: `Stage ${roadmap.stages.length + 1}` })}>+ Add stage</button> : null}
        {empty ? <p className="roadmap-empty">Add steps from your documents, then mark what each one needs first. Done and skipped steps unlock the ones after them.</p> : null}
      </div>
    </div>}
    {picker ? <div className="roadmap-picker" role="dialog" aria-modal="true" aria-label={picker.mode === "add" ? "Add a step" : "Relink step"}
      onPointerDown={(event) => { if (event.target === event.currentTarget) setPicker(null); }}>
      <div className="roadmap-picker-card">
        <DocumentLinkPicker conversations={conversations} sourceConversationId={conversation.id}
          heading={picker.mode === "add" ? "Add a document or block as a step" : "Point this step at another document"}
          onCancel={() => setPicker(null)}
          onSelect={(target) => {
            const node = { docId: target.conversationId, ...(target.blockId ? { blockId: target.blockId } : {}) };
            if (picker.mode === "add") change({ kind: "add-node", stageId: picker.stageId, target: node });
            else change({ kind: "relink", nodeId: picker.nodeId, target: node });
            setPicker(null);
          }} />
      </div>
    </div> : null}
  </section>;
}

interface RoadmapDetailProps {
  node: RoadmapNode;
  pending: boolean;
  graph: ReturnType<typeof buildRoadmapGraph>;
  conversations: Record<string, Conversation>;
  stages: { id: string; title: string }[];
  editing: boolean;
  titleOf: (id: string) => string;
  onChange: (change: RoadmapChange) => boolean;
  onOpen: (target: RoadmapNode["target"]) => void;
  onClose: () => void;
  onRelink: () => void;
  /** AI is writing in the step's document. */
  writing?: boolean;
  onExplain?: () => boolean;
  onDiveDeeper?: () => boolean;
  /** On the map: show or hide the step's own roadmap beside it. */
  subRoadmap?: { open: boolean; onToggle: () => void };
}

function RoadmapDetail({ node, pending, graph, conversations, stages, editing, titleOf, onChange, onOpen, onClose, onRelink, writing = false, onExplain, onDiveDeeper, subRoadmap }: RoadmapDetailProps) {
  const status = roadmapStatus(node);
  const target = conversations[node.target.docId];
  const missing = graph.missing.has(node.id) && !pending;
  const [proof, setProof] = useState(node.proof ?? "");
  useEffect(() => { setProof(node.proof ?? ""); }, [node.proof]);
  const position = useMemo(() => new Map(graph.stages.flatMap((stage) => stage.rows.flatMap((row) => row.nodeIds)).map((id, index) => [id, index])), [graph]);
  const inReadingOrder = (ids: string[]) => [...ids].sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0));
  const needs = inReadingOrder(graph.needs.get(node.id) ?? []);
  const neededBy = inReadingOrder(graph.neededBy.get(node.id) ?? []);
  const others = graph.roadmap.nodes.filter((item) => item.id !== node.id && !needs.includes(item.id));
  // A step that was dived into holds a roadmap of its own, which can be dived into in turn.
  const hasRoadmap = target?.nodeType === "roadmap" && !node.target.blockId ? getRoadmap(target).nodes.length : 0;
  // The step's text is read here, a paragraph per line of the document.
  const [reading, setReading] = useState(true);
  const { preview, paragraphs, long, thin } = useMemo(() => {
    if (!target) return { preview: "", paragraphs: [] as { text: string; kind: string }[], long: false, thin: false };
    const editable = getEditableDocument(target);
    const blocks = editable.blocks;
    const text = node.target.blockId ? blocks.find((block) => block.id === node.target.blockId)?.content ?? ""
      : blocks.map((block) => block.content).join("\n\n");
    const plain = plainPreview(text);
    return { preview: plain.length > 360 ? `${plain.slice(0, 360).trimEnd()}…` : plain, long: plain.length > 360,
      // Only a title or an outline so far, and AI hasn't written in it: there is nothing to learn from yet.
      thin: !node.target.blockId && !editable.generations.length && plain.length < 600,
      paragraphs: text.split(/\n+/u).map((line) => ({ text: plainPreview(line),
        kind: /^\s*#{1,6}\s/u.test(line) ? "heading" : /^\s*(?:[-+*]|\d+[.)])\s/u.test(line) ? "item" : "text" }))
        .filter((line) => line.text).slice(0, 200) };
  }, [target, node.target.blockId]);
  const resources = (target?.relations ?? []).filter((relation) => relation.type === "cites" && relation.targetConversationId && conversations[relation.targetConversationId]);
  const notes = target ? Object.values(conversations).filter((item) => item.parentId === target.id && item.document?.marginNote
    && (!node.target.blockId || item.branchAnchor?.sourceBlockId === node.target.blockId)) : [];
  // Opening a step whose document has nothing to read yet asks AI for the explanation, once.
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current || !thin || writing || pending || missing || !onExplain) return;
    asked.current = true;
    onExplain();
  }, [thin, writing, pending, missing, onExplain]);
  const title = pending ? (node.title ?? "Loading…") : missing ? (node.title ?? "Missing document") : roadmapNodeTitle(node, conversations);
  const row = graph.stages.flatMap((stage) => stage.rows).find((item) => item.nodeIds.includes(node.id));
  const rowIndex = row?.nodeIds.indexOf(node.id) ?? 0;

  return <aside className="roadmap-detail" aria-label={`Step: ${title}`}>
    <header className="roadmap-detail-head">
      <h3>{title}</h3>
      <button type="button" className="roadmap-detail-close" aria-label="Close step details" onClick={onClose}>×</button>
    </header>
    {pending ? <p className="roadmap-detail-muted">Bringing this document in from your cloud vault…</p> : missing ? <div className="roadmap-detail-missing">
      <p>The {node.target.blockId ? "block" : "document"} this step pointed at was deleted or moved.</p>
      <div className="roadmap-detail-actions">
        <button type="button" onClick={onRelink}>Relink</button>
        <button type="button" onClick={() => onChange({ kind: "remove-node", nodeId: node.id })}>Remove step</button>
      </div>
    </div> : <>
      {reading && paragraphs.length ? <div className="roadmap-detail-preview is-reading">{paragraphs.map((line, index) => <p key={index} className={`is-${line.kind}`}>{line.text}</p>)}</div>
        : preview ? <p className="roadmap-detail-preview">{preview}</p> : null}
      {writing ? <p className="roadmap-detail-muted" role="status">AI is writing an explanation…</p> : null}
      <div className="roadmap-detail-actions">
        {long || reading ? <button type="button" aria-expanded={reading} onClick={() => setReading(!reading)}>{reading ? "Show less" : "Read here"}</button> : null}
        <button type="button" onClick={() => onOpen(node.target)}>
          Open {node.target.blockId ? "passage" : "document"}<span aria-hidden="true"> ↗</span>
        </button>
        {onExplain && !node.target.blockId ? <button type="button" disabled={writing} title="AI writes an explanation of this topic into the step's document"
          onClick={() => { if (onExplain()) setReading(true); }}>Explain with AI</button> : null}
        {hasRoadmap && subRoadmap ? <button type="button" aria-expanded={subRoadmap.open} onClick={subRoadmap.onToggle}>
          {subRoadmap.open ? "Hide its roadmap" : `Show its roadmap (${hasRoadmap} ${hasRoadmap === 1 ? "step" : "steps"})`}
        </button> : null}
        {hasRoadmap ? <button type="button" title="This step has a roadmap of its own" onClick={() => onOpen({ docId: node.target.docId })}>
          {subRoadmap ? <>Open its roadmap<span aria-hidden="true"> ↗</span></> : `Open its roadmap (${hasRoadmap} ${hasRoadmap === 1 ? "step" : "steps"})`}
        </button>
          : onDiveDeeper && !node.target.blockId ? <button type="button" disabled={writing} title="AI breaks this topic into its own roadmap, inside the step's document, for you to approve"
            onClick={() => {
              // On a phone the step is a sheet over the page; it steps aside for the document the answer is written in.
              if (onDiveDeeper() && window.matchMedia?.("(max-width: 720px)").matches) onClose();
            }}>Dive deeper</button> : null}
      </div>
      <div className="roadmap-status-picker" role="radiogroup" aria-label="Status">
        {STATUSES.map((item) => <button key={item} type="button" role="radio" aria-checked={status === item}
          className={`is-${item}`} onClick={() => onChange({ kind: "status", nodeId: node.id, status: item })}>
          <StatusMark status={item} />{ROADMAP_STATUS_LABELS[item]}
        </button>)}
      </div>
      <label className="roadmap-detail-field">
        <span>Proof</span>
        <input value={proof} placeholder="Built X, can explain Y…" maxLength={500}
          onChange={(event) => setProof(event.target.value)}
          onBlur={() => { if (proof !== (node.proof ?? "")) onChange({ kind: "proof", nodeId: node.id, proof }); }}
          onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
      </label>
    </>}
    {needs.length || editing ? <div className="roadmap-detail-section">
      <h4>Needs first</h4>
      {needs.length ? <ul>{needs.map((id) => <li key={id}>
        <StatusMark status={roadmapStatus(graph.nodesById.get(id)!)} /><span>{titleOf(id)}</span>
        {editing ? <button type="button" aria-label={`Remove prerequisite ${titleOf(id)}`} title="Remove"
          onClick={() => onChange({ kind: "remove-prerequisite", nodeId: node.id, prerequisiteId: id })}>×</button> : null}
      </li>)}</ul> : <p className="roadmap-detail-muted">Nothing. This step can start any time.</p>}
      {editing && others.length ? <select aria-label="Add a prerequisite" value=""
        onChange={(event) => { if (event.target.value) onChange({ kind: "add-prerequisite", nodeId: node.id, prerequisiteId: event.target.value }); }}>
        <option value="">Add a step it needs…</option>
        {others.map((item) => <option key={item.id} value={item.id}>{titleOf(item.id)}</option>)}
      </select> : null}
    </div> : null}
    {neededBy.length ? <div className="roadmap-detail-section">
      <h4>Unlocks</h4>
      <ul>{neededBy.map((id) => <li key={id}><StatusMark status={roadmapStatus(graph.nodesById.get(id)!)} /><span>{titleOf(id)}</span></li>)}</ul>
    </div> : null}
    {resources.length ? <div className="roadmap-detail-section">
      <h4>Resources</h4>
      <ul>{resources.map((relation) => <li key={relation.targetConversationId}>
        <button type="button" className="roadmap-detail-link" onClick={() => onOpen({ docId: relation.targetConversationId!, ...(relation.targetBlockId ? { blockId: relation.targetBlockId } : {}) })}>
          {conversations[relation.targetConversationId!].title || "Untitled document"}
        </button>
      </li>)}</ul>
    </div> : null}
    {notes.length ? <div className="roadmap-detail-section">
      <h4>Margin notes</h4>
      <ul>{notes.map((note) => <li key={note.id}>
        <button type="button" className="roadmap-detail-link" onClick={() => onOpen({ docId: note.id })}>
          {plainPreview(getEditableDocument(note).blocks.map((block) => block.content).join(" ")).slice(0, 120) || note.title || "Empty note"}
        </button>
      </li>)}</ul>
    </div> : null}
    {editing ? <div className="roadmap-detail-section roadmap-detail-edit">
      <label className="roadmap-detail-field">
        <span>Name on the roadmap</span>
        <input defaultValue={node.title ?? ""} placeholder={target?.title || "Untitled document"} maxLength={200} key={node.title ?? ""}
          onBlur={(event) => { if (event.target.value !== (node.title ?? "")) onChange({ kind: "rename-node", nodeId: node.id, title: event.target.value }); }}
          onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
      </label>
      <label className="roadmap-detail-field">
        <span>Stage</span>
        <select value={node.stage} onChange={(event) => onChange({ kind: "move-node", nodeId: node.id, stageId: event.target.value })}>
          {stages.some((stage) => stage.id === node.stage) ? null : <option value={node.stage}>Unstaged</option>}
          {stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.title}</option>)}
        </select>
      </label>
      <div className="roadmap-detail-actions">
        <button type="button" disabled={rowIndex <= 0} onClick={() => onChange({ kind: "move-node", nodeId: node.id, direction: -1 })}>← Earlier</button>
        <button type="button" disabled={!row || rowIndex >= row.nodeIds.length - 1} onClick={() => onChange({ kind: "move-node", nodeId: node.id, direction: 1 })}>Later →</button>
        {!missing ? <button type="button" onClick={onRelink}>Relink</button> : null}
        {!missing ? <button type="button" className="is-danger" onClick={() => onChange({ kind: "remove-node", nodeId: node.id })}>Remove step</button> : null}
      </div>
    </div> : null}
  </aside>;
}
