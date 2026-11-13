import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Conversation, RoadmapNode, RoadmapStatus } from "../types";
import { getEditableDocument } from "../lib/editableDocument";
import {
  buildRoadmapGraph, getRoadmap, plainPreview, roadmapDraftLink, roadmapNodeTitle, roadmapStatus, ROADMAP_STATUS_LABELS, type RoadmapChange,
} from "../lib/roadmap";
import DocumentLinkPicker from "./DocumentLinkPicker";
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
  /** Ask AI to write an explanation of a step's topic into its document; returns why it couldn't start, or null. */
  onExplain?: (docId: string, context: string) => string | null;
  /** Ask AI to break a step's topic into its own roadmap, inside the step's document; returns why it couldn't start, or null. */
  onDiveDeeper?: (docId: string) => string | null;
  /** Documents AI is writing in now. */
  writingIds?: Record<string, unknown>;
}

const STATUSES: RoadmapStatus[] = ["not-started", "learning", "done", "skipped"];
/** Tapping a node's status mark steps through the common path; Skipped is in the detail pane. */
const NEXT_STATUS: Record<RoadmapStatus, RoadmapStatus> = { "not-started": "learning", learning: "done", done: "not-started", skipped: "not-started" };

type Picker = { mode: "add"; stageId: string } | { mode: "relink"; nodeId: string };
type EdgePath = { key: string; d: string; from: string; to: string };

function percent(finished: number, total: number) {
  return total ? Math.round((finished / total) * 100) : 0;
}

function StatusMark({ status }: { status: RoadmapStatus }) {
  return <svg viewBox="0 0 16 16" aria-hidden="true" className={`roadmap-status-mark is-${status}`}>
    <circle cx="8" cy="8" r="6.5" />
    {status === "learning" ? <path d="M8 1.5a6.5 6.5 0 0 1 0 13Z" className="roadmap-status-fill" /> : null}
    {status === "done" ? <path d="m5 8.2 2 2 4-4.4" /> : null}
    {status === "skipped" ? <path d="M4.5 8h7" /> : null}
  </svg>;
}

export default function RoadmapView({ conversation, conversations, onChange, onOpen, cloudDocuments, onLoadTargets, onDraft, drafting = false, onExplain, onDiveDeeper, writingIds }: RoadmapViewProps) {
  const roadmap = useMemo(() => getRoadmap(conversation), [conversation]);
  const graph = useMemo(() => buildRoadmapGraph(roadmap, conversations), [roadmap, conversations]);
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
  const empty = !roadmap.nodes.length;
  const showEditing = editing || empty;
  // A new roadmap opens ready to edit and stays that way after its first step.
  useEffect(() => { if (empty) setEditing(true); }, [empty]);

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
  }, [graph, showEditing, selectedId]);

  const titleOf = (id: string) => { const node = graph.nodesById.get(id); return node ? roadmapNodeTitle(node, conversations) : "Missing step"; };

  function renderCard(node: RoadmapNode) {
    const status = roadmapStatus(node);
    const pending = isWaiting(node);
    const missing = graph.missing.has(node.id) && !pending;
    const next = graph.nextUp.has(node.id);
    const locked = !missing && !pending && !next && status !== "done" && status !== "skipped";
    const title = pending ? (node.title ?? cloudTitles.get(node.target.docId) ?? "Loading…") : missing ? (node.title ?? "Missing document") : roadmapNodeTitle(node, conversations);
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
    </div>;
  }

  // The selected step opens in place, under its row, so what it says is read where it was clicked.
  const detail = selected ? <RoadmapDetail key={selected.id} node={selected} graph={graph} pending={isWaiting(selected)} conversations={conversations} editing={showEditing}
        stages={roadmap.stages} titleOf={titleOf} onChange={change} onOpen={onOpen} onClose={() => setSelectedId(null)}
        onRelink={() => setPicker({ mode: "relink", nodeId: selected.id })}
        writing={Boolean(writingIds?.[selected.target.docId])}
        onExplain={onExplain ? () => {
          // Where the step sits, so the explanation is pitched for this roadmap and not written in a vacuum.
          const stage = roadmap.stages.find((item) => item.id === selected.stage)?.title;
          const before = (graph.needs.get(selected.id) ?? []).map(titleOf);
          const after = (graph.neededBy.get(selected.id) ?? []).map(titleOf);
          const context = [stage ? `It is in the stage “${stage}”.` : "", before.length ? `I learn these first: ${before.join(", ")}.` : "",
            after.length ? `It leads on to: ${after.join(", ")}.` : ""].filter(Boolean).join(" ");
          const error = onExplain(selected.target.docId, context); setMessage(error); return !error;
        } : undefined}
        onDiveDeeper={onDiveDeeper ? () => { const error = onDiveDeeper(selected.target.docId); setMessage(error); return !error; } : undefined} /> : null;

  return <section className={`roadmap${selected ? " has-detail" : ""}`} aria-label={`Roadmap: ${conversation.title || "Untitled roadmap"}`}>
    <header className="roadmap-head">
      <div className="roadmap-progress" role="group" aria-label="Progress">
        <span className="roadmap-progress-label">{graph.total ? `${graph.finished} of ${graph.total} done` : "No steps yet"}</span>
        <span className="roadmap-bar" aria-hidden="true"><span style={{ width: `${percent(graph.finished, graph.total)}%` }} /></span>
        {graph.nextUp.size ? <span className="roadmap-progress-next">{graph.nextUp.size} next up</span> : null}
      </div>
      {onDraft && !draftOpen ? <button type="button" className="roadmap-edit-toggle" disabled={drafting}
        title="AI proposes stages and steps for you to approve, from your documents or from a link you paste" onClick={() => { setDraftOpen(true); setMessage(null); }}>
        {drafting ? "Drafting…" : "Draft with AI"}
      </button> : null}
      {!empty ? <button type="button" className="roadmap-edit-toggle" aria-pressed={editing} onClick={() => { setEditing(!editing); setMessage(null); }}>
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
    <div className="roadmap-layout">
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
          </Fragment>)}
          {showEditing && !stage.unknown ? <button type="button" className="roadmap-add" onClick={() => setPicker({ mode: "add", stageId: stage.id })}>+ Add step</button> : null}
        </section>)}
        {showEditing ? <button type="button" className="roadmap-add is-stage" onClick={() => change({ kind: "add-stage", title: `Stage ${roadmap.stages.length + 1}` })}>+ Add stage</button> : null}
        {empty ? <p className="roadmap-empty">Add steps from your documents, then mark what each one needs first. Done and skipped steps unlock the ones after them.</p> : null}
      </div>
    </div>
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
}

function RoadmapDetail({ node, pending, graph, conversations, stages, editing, titleOf, onChange, onOpen, onClose, onRelink, writing = false, onExplain, onDiveDeeper }: RoadmapDetailProps) {
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
        {hasRoadmap ? <button type="button" title="This step has a roadmap of its own" onClick={() => onOpen({ docId: node.target.docId })}>Open its roadmap ({hasRoadmap} {hasRoadmap === 1 ? "step" : "steps"})</button>
          : onDiveDeeper && !node.target.blockId ? <button type="button" disabled={writing} title="AI breaks this topic into its own roadmap, inside the step's document, for you to approve"
            onClick={() => { onDiveDeeper(); }}>Dive deeper</button> : null}
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
