import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Conversation, RoadmapNode, RoadmapStatus } from "../types";
import { getEditableDocument } from "../lib/editableDocument";
import {
  buildRoadmapGraph, getRoadmap, newRoadmapId, plainPreview, roadmapDraftLink, roadmapDraftOutcome, roadmapNodeTitle, roadmapStatus, ROADMAP_STATUS_LABELS, type RoadmapChange, type RoadmapGraph,
} from "../lib/roadmap";
import DocumentLinkPicker from "./DocumentLinkPicker";
import AgentRunLog from "./AgentRunLog";
import RoadmapCanvas, { openSubKey, roadmapOfStep, type RoadmapFilter, type RoadmapLayoutMode, type RoadmapStep } from "./RoadmapCanvas";
import StatusMark, { ROADMAP_STATUSES as STATUSES } from "./RoadmapStatusMark";
import type { AgentProgress } from "../lib/useChatStreams";
import ServicePickerModal from "./ServicePickerModal";
import { getBackendServiceSelectionLabel, supportsAgentMode, type RecentBackendServiceSelection } from "../lib/services";
import type { BackendServiceId } from "../types";
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
  onDraft?: (goal: string, options: { agent: boolean }) => string | null;
  /** The model Draft with AI uses (this document's, as in Ask AI), and a way to pick another. */
  model?: { serviceId: BackendServiceId; modelId: string; recentSelections: RecentBackendServiceSelection[]; onChange: (serviceId: BackendServiceId, modelId: string) => void };
  /** AI is writing in this document. */
  drafting?: boolean;
  /** Ask AI to write an explanation of a step's topic into its document; returns why it couldn't start, or null.
   * `roadmapId` names the roadmap the step is in when it is a sub-roadmap shown inside this one. */
  onExplain?: (docId: string, context: string, roadmapId?: string) => string | null;
  /** Ask AI to break a step's topic into its own roadmap, inside the step's document; returns why it couldn't start, or null. */
  onDiveDeeper?: (docId: string, roadmapId?: string) => string | null;
  /** Applies one edit to another roadmap shown inside this one (a step's own roadmap); returns why it was refused, or null. */
  onChangeRoadmap?: (roadmapId: string, change: RoadmapChange) => string | null;
  /** Make a new document and add it as a step; returns why it couldn't, or null. */
  onCreateStep?: (roadmapId: string, stageId: string, title: string, nodeId: string) => string | null;
  /** A document as it opens anywhere else, for the sheet beside the roadmap; null when it can't be shown here. */
  renderDocument?: (docId: string) => ReactNode;
  /** The roadmap is the whole page: it fills the space, and its own text opens beside it. */
  fill?: boolean;
  /** Documents AI is writing in now. */
  writingIds?: Record<string, unknown>;
  /** The agent's live progress while it drafts this roadmap: its steps, thinking, and the roadmap so far. */
  progress?: AgentProgress;
  budgetMicros?: number;
  onStop?: () => void;
  /** Approve or dismiss a roadmap the agent drafted for this document; returns why it couldn't, or null. */
  onDraftDecision?: (messageId: string, proposalId: string, action: "approve" | "dismiss") => string | null;
  /** Why AI's last request in this document failed, shown here because the roadmap page hides the document's text. */
  draftError?: string | null;
}

const LAYOUT_KEY = "margin-chat:roadmap-layout";
const SHEET_KEY = "margin-chat:roadmap-sheet";
type SheetMode = "beside" | "card" | "page";
const phoneQuery = "(max-width: 720px)";
const isPhone = () => typeof window !== "undefined" && Boolean(window.matchMedia?.(phoneQuery).matches);
function savedLayout(): RoadmapLayoutMode {
  try {
    const saved = window.localStorage?.getItem(LAYOUT_KEY);
    if (saved === "map" || saved === "list") return saved;
  } catch { /* nothing remembered */ }
  return isPhone() ? "list" : "map";
}
function savedSheetMode(): SheetMode {
  try { const saved = window.localStorage?.getItem(SHEET_KEY); return saved === "card" ? "card" : "beside"; } catch { return "beside"; }
}
const FILTERS: { id: RoadmapFilter; label: string }[] = [
  { id: "all", label: "All steps" }, { id: "next", label: "Next up" }, { id: "open", label: "Not done" }, { id: "done", label: "Done" },
];

type Sheet = { kind: "step"; step: RoadmapStep } | { kind: "text"; roadmapId: string };
type Adding = { roadmapId: string; stageId: string };

function percent(finished: number, total: number) {
  return total ? Math.round((finished / total) * 100) : 0;
}

/**
 * A roadmap is a map of its own: stages are boxes of steps, lines run from what a
 * step needs to the step, and List is the same map stacked one stage under another.
 * A step opens its document beside the map, as documents open from the Map; the
 * roadmap's own text opens the same way from its name.
 */
export default function RoadmapView({ conversation, conversations, onChange, onOpen, cloudDocuments, onLoadTargets, onDraft, model, drafting = false, onExplain, onDiveDeeper,
  writingIds, progress, budgetMicros, onStop, onDraftDecision, draftError, onChangeRoadmap, onCreateStep, renderDocument, fill = false }: RoadmapViewProps) {
  // ---- Which roadmap is on the canvas: this one, or a step's roadmap gone into ----
  const [trail, setTrail] = useState<string[]>([]);
  useEffect(() => { setTrail([]); }, [conversation.id]);
  const path = useMemo(() => {
    const ids = [conversation.id];
    for (const id of trail) { const item = conversations[id]; if (!item || item.nodeType !== "roadmap" || ids.includes(id)) break; ids.push(id); }
    return ids;
  }, [conversation.id, trail, conversations]);
  const shown = path.length > 1 ? conversations[path[path.length - 1]] : conversation;
  const atRoot = shown.id === conversation.id;
  const roadmap = useMemo(() => getRoadmap(shown), [shown]);
  const graph = useMemo(() => buildRoadmapGraph(roadmap, conversations), [roadmap, conversations]);
  const rootGraph = useMemo(() => atRoot ? graph : buildRoadmapGraph(getRoadmap(conversation), conversations), [atRoot, graph, conversation, conversations]);

  const [layout, setLayout] = useState<RoadmapLayoutMode>(savedLayout);
  function chooseLayout(next: RoadmapLayoutMode) {
    setLayout(next);
    try { window.localStorage?.setItem(LAYOUT_KEY, next); } catch { /* the choice just isn't remembered */ }
  }
  const [filter, setFilter] = useState<RoadmapFilter>("all");
  const [filterOpen, setFilterOpen] = useState(false);
  // Steps whose own roadmap is open: beside the step on the map, under it in the list.
  const [openSubs, setOpenSubs] = useState<Set<string>>(() => new Set());
  const toggleSub = (step: RoadmapStep, force?: boolean) => setOpenSubs((current) => {
    const next = new Set(current), key = openSubKey(step.roadmapId, step.nodeId);
    if (force ?? !next.has(key)) next.add(key); else next.delete(key);
    return next;
  });
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [sheetMode, setSheetModeState] = useState<SheetMode>(savedSheetMode);
  const setSheetMode = (mode: SheetMode) => {
    setSheetModeState(mode);
    if (mode !== "page") try { window.localStorage?.setItem(SHEET_KEY, mode); } catch { /* not remembered */ }
  };
  const closeSheet = () => { setSheet(null); if (sheetMode === "page") setSheetModeState(savedSheetMode()); };
  const [adding, setAdding] = useState<Adding | null>(null);
  const [relinking, setRelinking] = useState<RoadmapStep | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(null), 2600); return () => window.clearTimeout(timer); }, [toast]);
  const [draftOpen, setDraftOpen] = useState(false);
  const [goal, setGoal] = useState("");
  // Agent mode is on for drafts unless turned off here; a model without it drafts from its own knowledge.
  const [agentWanted, setAgentWanted] = useState(true);
  const [pickingModel, setPickingModel] = useState(false);
  const agentAvailable = model ? supportsAgentMode(model.serviceId) : true;
  const useAgent = agentWanted && agentAvailable;
  const draftLink = useMemo(() => roadmapDraftLink(goal), [goal]);
  const draftLinkName = useMemo(() => {
    if (!draftLink) return "";
    const url = new URL(draftLink);
    const pathName = url.pathname.replace(/\/$/u, "");
    return `${url.hostname.replace(/^www\./u, "")}${pathName.length > 28 ? `${pathName.slice(0, 27)}…` : pathName}`;
  }, [draftLink]);
  useEffect(() => { setMessage(null); setSheet(null); setOpenSubs(new Set()); }, [conversation.id]);

  // A finished draft waits here, in the roadmap it is for, until it is added or discarded.
  const waitingDraft = useMemo(() => {
    for (const item of [...conversation.messages].reverse()) {
      const proposal = item.execution?.agent?.proposals?.find((entry) => entry.kind === "roadmap" && entry.roadmapId === conversation.id && !entry.status);
      if (proposal?.kind === "roadmap") return { messageId: item.id, proposal };
    }
    return null;
  }, [conversation.messages, conversation.id]);
  // A run that ended without a draft for this roadmap says what the agent answered instead.
  const outcome = useMemo(() => roadmapDraftOutcome(conversation), [conversation]);
  const [dismissedOutcome, setDismissedOutcome] = useState<string | null>(null);
  const working = drafting && Boolean(progress);
  const building = working ? progress?.roadmapDraft ?? null : null;
  const draftStages = building?.stages ?? (working ? null : waitingDraft?.proposal.stages) ?? null;
  const draftSteps = draftStages?.reduce((sum, stage) => sum + stage.steps.length, 0) ?? 0;
  const draftEnd = useRef<HTMLDivElement>(null);
  // While it is being written, the newest step stays in view.
  useEffect(() => { if (building) draftEnd.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" }); }, [building, draftSteps]);

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

  /** Apply an edit to whichever roadmap on the canvas it belongs to. */
  function changeIn(roadmapId: string, next: RoadmapChange, quiet = false) {
    const error = roadmapId === conversation.id ? onChange(next) : onChangeRoadmap ? onChangeRoadmap(roadmapId, next) : "This roadmap can be changed from its own document.";
    if (error) { if (quiet) setToast(error); else setMessage(error); }
    return !error;
  }
  const graphOf = (roadmapId: string): RoadmapGraph | null => {
    if (roadmapId === shown.id) return graph;
    if (roadmapId === conversation.id) return rootGraph;
    const item = conversations[roadmapId];
    return item ? buildRoadmapGraph(getRoadmap(item), conversations) : null;
  };
  const stepTitle = (roadmapId: string, nodeId: string) => {
    const node = graphOf(roadmapId)?.nodesById.get(nodeId);
    return node ? isWaiting(node) ? node.title ?? cloudTitles.get(node.target.docId) ?? "Loading…" : roadmapNodeTitle(node, conversations) : "Missing step";
  };

  // ---- The open document: beside the map, a card over it, or the whole page; a sheet from the bottom on phones ----
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [surface, setSurface] = useState({ width: 1000, height: 640 });
  const [phone, setPhone] = useState(isPhone);
  useLayoutEffect(() => {
    const el = surfaceRef.current; if (!el) return;
    const measure = () => setSurface((current) => current.width === el.clientWidth && current.height === el.clientHeight ? current : { width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(el);
    const media = window.matchMedia?.(phoneQuery);
    const onMedia = () => setPhone(Boolean(media?.matches));
    media?.addEventListener?.("change", onMedia);
    return () => { observer?.disconnect(); media?.removeEventListener?.("change", onMedia); };
  }, []);
  const narrow = phone || surface.width < 640;
  const besideWidth = Math.round(Math.min(560, Math.max(320, surface.width * .46)));
  const cover = !sheet || sheetMode === "page" ? { right: 0, bottom: 0 }
    : narrow ? { right: 0, bottom: Math.round(surface.height * .62) }
    : sheetMode === "card" ? { right: Math.min(420, surface.width * .5) + 16, bottom: 0 } : { right: besideWidth, bottom: 0 };

  // Escape closes the open document, or brings a full page back beside the map.
  useEffect(() => {
    if (!sheet) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("[contenteditable='true'], input, textarea, select, [role='dialog']")) return;
      if (sheetMode === "page") setSheetModeState(savedSheetMode()); else setSheet(null);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [sheet, sheetMode]);

  // A step that went away (removed, or its roadmap closed) closes its document.
  const sheetGraph = sheet?.kind === "step" ? graphOf(sheet.step.roadmapId) : null;
  const sheetNode = sheet?.kind === "step" ? sheetGraph?.nodesById.get(sheet.step.nodeId) ?? null : null;
  useEffect(() => { if (sheet?.kind === "step" && !sheetNode) setSheet(null); }, [sheet, sheetNode]);

  function openStep(step: RoadmapStep) {
    setSheet((current) => current?.kind === "step" && current.step.roadmapId === step.roadmapId && current.step.nodeId === step.nodeId && !narrow ? current : { kind: "step", step });
  }
  function enter(step: RoadmapStep) {
    const node = graphOf(step.roadmapId)?.nodesById.get(step.nodeId);
    const sub = node ? roadmapOfStep(node, conversations) : null;
    if (!sub) return;
    const at = path.indexOf(step.roadmapId);
    setTrail([...path.slice(1, at + 1), sub.id]);
    setSheet(null);
  }

  const stages = roadmap.stages;
  const empty = !stages.length && !roadmap.nodes.length;
  const order = (target: RoadmapGraph) => target.stages.flatMap((stage) => stage.rows.flatMap((row) => row.nodeIds));

  function addStage() {
    const stageId = newRoadmapId("stage");
    if (changeIn(shown.id, { kind: "add-stage", title: `Stage ${stages.length + 1}`, stageId }, true)) setToast(`Added a stage. Double-click its name to rename it.`);
  }

  return <section className={`roadmap${fill ? " is-fill" : ""}${narrow ? " is-narrow" : ""}`} aria-label={`Roadmap: ${conversation.title || "Untitled roadmap"}`}>
    <header className="roadmap-toolbar">
      <nav className="roadmap-trail" aria-label="Roadmap path">
        {path.map((id, index) => {
          const last = index === path.length - 1, item = conversations[id];
          const name = item?.title || "Untitled roadmap";
          return <span key={id} className="roadmap-trail-item">
            {index ? <span className="roadmap-trail-sep" aria-hidden="true">›</span> : null}
            <button type="button" className={last ? "is-current" : undefined} aria-current={last ? "page" : undefined}
              title={last ? "Open this roadmap's own text" : `Back to ${name}`}
              onClick={() => { if (last) setSheet({ kind: "text", roadmapId: id }); else { setTrail(path.slice(1, index + 1)); setSheet(null); } }}>
              {index && !last ? <span className="roadmap-trail-back" aria-hidden="true">‹</span> : null}{name}
            </button>
          </span>;
        })}
      </nav>
      {graph.total ? <div className="roadmap-progress" role="group" aria-label="Progress">
        <span className="roadmap-progress-label"><strong>{graph.finished} of {graph.total}</strong> done</span>
        <span className="roadmap-bar" aria-hidden="true"><span style={{ width: `${percent(graph.finished, graph.total)}%` }} /></span>
        {graph.nextUp.size ? <span className="roadmap-progress-next">{graph.nextUp.size} next up</span> : null}
      </div> : <span className="roadmap-toolbar-gap" />}
      <div className="roadmap-layout-switch" role="group" aria-label="Layout">
        <button type="button" aria-pressed={layout === "map"} onClick={() => chooseLayout("map")} title="Stages side by side, like the Map" aria-label="Map layout">
          <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2" width="4.5" height="12" rx="1.2" /><rect x="10" y="2" width="4.5" height="7" rx="1.2" /><path d="M6 5.5h4" /></svg><span>Map</span>
        </button>
        <button type="button" aria-pressed={layout === "list"} onClick={() => chooseLayout("list")} title="The same stages, one under another" aria-label="List layout">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5h8M5 8h8M5 12.5h8M2.5 3.5h0M2.5 8h0M2.5 12.5h0" strokeLinecap="round" /></svg><span>List</span>
        </button>
      </div>
      {graph.total ? <div className="roadmap-menu-wrap">
        <button type="button" className={`roadmap-tool${filter !== "all" ? " is-on" : ""}`} aria-haspopup="menu" aria-expanded={filterOpen} onClick={() => setFilterOpen(!filterOpen)}>
          {filter === "all" ? "Filter" : FILTERS.find((item) => item.id === filter)!.label}
        </button>
        {filterOpen ? <div className="roadmap-menu" role="menu" onKeyDown={(event) => { if (event.key === "Escape") setFilterOpen(false); }}>
          {FILTERS.map((item) => <button key={item.id} type="button" role="menuitemradio" aria-checked={filter === item.id}
            onClick={() => { setFilter(item.id); setFilterOpen(false); }}>{item.label}</button>)}
        </div> : null}
      </div> : null}
      {onDraft && atRoot ? <button type="button" className="roadmap-tool" disabled={drafting}
        title="AI proposes stages and steps for you to approve, from your documents or from a link you paste" onClick={() => { setDraftOpen(!draftOpen); setMessage(null); }}>
        {drafting ? "Drafting…" : <><span className="roadmap-tool-long">Draft with </span>AI</>}
      </button> : null}
      <button type="button" className="roadmap-tool is-icon" aria-label="Add a stage" title="Add a stage" onClick={addStage}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" strokeLinecap="round" /></svg>
      </button>
    </header>
    {draftOpen && onDraft && atRoot ? <form className="roadmap-draft" onSubmit={(event) => {
      event.preventDefault();
      if (!goal.trim()) return;
      const error = onDraft(goal.trim(), { agent: useAgent });
      setMessage(error);
      if (!error) { setDraftOpen(false); setGoal(""); }
    }}>
      <input autoFocus value={goal} maxLength={600} aria-label="What do you want to learn, or a link to build from" placeholder="What do you want to learn? Or paste a link"
        onChange={(event) => setGoal(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setDraftOpen(false); }} />
      <button type="submit" disabled={!goal.trim()}>{draftLink ? "Build from link" : "Draft"}</button>
      <button type="button" onClick={() => setDraftOpen(false)}>Cancel</button>
      {model ? <div className="roadmap-draft-model">
        <button type="button" className="roadmap-draft-model-pick" aria-haspopup="dialog" aria-expanded={pickingModel} title="Choose the AI model, as in Ask AI"
          onClick={() => setPickingModel(true)}>{getBackendServiceSelectionLabel(model.serviceId, model.modelId)}<span aria-hidden="true"> ▾</span></button>
        <label className={agentAvailable ? undefined : "is-unavailable"} title={agentAvailable ? "The agent reads pages and searches your documents, then proposes the roadmap" : "This model can't use Agent mode"}>
          <input type="checkbox" checked={useAgent} disabled={!agentAvailable} onChange={(event) => setAgentWanted(event.target.checked)} /> Agent mode
        </label>
        {!agentAvailable ? <span className="roadmap-draft-model-note">This model can't use Agent mode, so it drafts from its own knowledge.</span> : null}
      </div> : null}
      {!useAgent
        ? <p>Without Agent mode, AI drafts stages and steps from its own knowledge in one answer{draftLink ? " and may not read the page" : ""}. Each step becomes a new document. Nothing is added until you approve it.</p>
        : draftLink
        ? <p>AI reads <strong>{draftLinkName}</strong> and proposes its sections as stages and its topics as steps, using your documents where they fit and new ones for the rest. Nothing is added until you approve it.</p>
        : <p>AI searches your documents and proposes stages and steps for this roadmap. Paste a link to a roadmap, an article or an X post to build from that page instead. Nothing is added until you approve it.</p>}
    </form> : null}
    {model ? <ServicePickerModal currentModelId={model.modelId} currentServiceId={model.serviceId} isOpen={pickingModel} onClose={() => setPickingModel(false)}
      onSelectModel={(serviceId, modelId) => { model.onChange(serviceId, modelId); setPickingModel(false); }} recentSelections={model.recentSelections} /> : null}
    {message ? <p className="roadmap-message" role="alert">{message}<button type="button" aria-label="Dismiss" onClick={() => setMessage(null)}>×</button></p> : null}
    {graph.cycleEdges.length ? <p className="roadmap-message" role="note">
      Some prerequisites loop back on each other, so {graph.cycleEdges.length === 1 ? "one is" : `${graph.cycleEdges.length} are`} ignored:{" "}
      {graph.cycleEdges.map((edge) => `${stepTitle(shown.id, edge.from)} needs ${stepTitle(shown.id, edge.to)}`).join("; ")}.
    </p> : null}
    {atRoot && !drafting && !waitingDraft && draftError ? <p className="roadmap-message" role="alert">AI couldn't draft the roadmap: {draftError}</p> : null}
    {atRoot && !drafting && !waitingDraft && !draftError && outcome && dismissedOutcome !== outcome.messageId ? <section className="roadmap-build roadmap-outcome" aria-label="What the agent answered">
      <header className="roadmap-build-head">
        <strong>{outcome.elsewhere ? `The agent drafted its roadmap for “${outcome.elsewhere}”, not this one` : "The agent finished without a roadmap"}</strong>
        {onDraft ? <button type="button" className="is-primary" onClick={() => { setDraftOpen(true); setMessage(null); }}>Try again</button> : null}
        <button type="button" onClick={() => setDismissedOutcome(outcome.messageId)}>Dismiss</button>
      </header>
      {outcome.reply ? <p className="roadmap-outcome-reply">{outcome.reply.length > 1200 ? `${outcome.reply.slice(0, 1199)}…` : outcome.reply}</p> : null}
    </section> : null}
    {atRoot && (working || draftStages) ? <section className={`roadmap-build${working ? " is-live" : ""}`} aria-label="Roadmap draft" aria-busy={working}>
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
    <div className={`roadmap-surface${sheet ? ` has-sheet is-sheet-${narrow && sheetMode !== "page" ? "bottom" : sheetMode}` : ""}`} ref={surfaceRef}>
      {empty ? <div className="roadmap-empty">
        <strong>An empty roadmap</strong>
        <p>Add a stage, then add steps to it from your documents. Drag a step's dot onto a step that needs it first; done steps unlock the ones after them.</p>
        <div>
          <button type="button" onClick={addStage}>+ Add a stage</button>
          {onDraft && atRoot ? <button type="button" onClick={() => setDraftOpen(true)}>Draft with AI</button> : null}
        </div>
      </div> : <RoadmapCanvas roadmap={shown} graph={graph} conversations={conversations} layout={layout} filter={filter}
        open={openSubs} onToggle={(step) => toggleSub(step)} onEnter={enter}
        selected={sheet?.kind === "step" ? sheet.step : null} onSelect={openStep}
        onStatus={(step, status) => changeIn(step.roadmapId, { kind: "status", nodeId: step.nodeId, status }, true)}
        onMove={(step, stageId) => {
          const owner = conversations[step.roadmapId] ?? shown;
          const stage = getRoadmap(owner).stages.find((item) => item.id === stageId);
          if (stage && changeIn(step.roadmapId, { kind: "move-node", nodeId: step.nodeId, stageId }, true)) setToast(`Moved “${stepTitle(step.roadmapId, step.nodeId)}” to ${stage.title}`);
        }}
        onLink={(before, step) => {
          if (changeIn(step.roadmapId, { kind: "add-prerequisite", nodeId: step.nodeId, prerequisiteId: before.nodeId }, true))
            setToast(`“${stepTitle(step.roadmapId, step.nodeId)}” now needs “${stepTitle(before.roadmapId, before.nodeId)}” first`);
        }}
        onAddStep={(roadmapId, stageId) => setAdding({ roadmapId, stageId })}
        onRenameStage={(roadmapId, stageId, title) => changeIn(roadmapId, { kind: "rename-stage", stageId, title }, true)}
        onMoveStage={(roadmapId, stageId, direction) => changeIn(roadmapId, { kind: "move-stage", stageId, direction }, true)}
        onRemoveStage={(roadmapId, stageId) => changeIn(roadmapId, { kind: "remove-stage", stageId }, true)}
        cloudTitles={cloudTitles} writingIds={writingIds} cover={cover} fitKey={`${shown.id}|${layout}${layout === "list" ? `|${cover.right}` : ""}`} />}
      {sheet ? <aside className="roadmap-sheet" style={!narrow && sheetMode === "beside" ? { width: besideWidth } : undefined}
        aria-label={sheet.kind === "text" ? `${conversations[sheet.roadmapId]?.title || "Roadmap"}: its own text` : `Step: ${stepTitle(sheet.step.roadmapId, sheet.step.nodeId)}`}>
        <div className="roadmap-sheet-bar">
          <span className="roadmap-sheet-name">{sheet.kind === "text" ? conversations[sheet.roadmapId]?.title || "Untitled roadmap" : stepTitle(sheet.step.roadmapId, sheet.step.nodeId)}</span>
          {narrow ? null : <button type="button" aria-pressed={sheetMode === "card"} title="A card over the roadmap" aria-label="Show as a card" onClick={() => setSheetMode("card")}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="1.5" /></svg></button>}
          {narrow ? null : <button type="button" aria-pressed={sheetMode === "beside"} title="Beside the roadmap" aria-label="Show beside the roadmap" onClick={() => setSheetMode("beside")}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M9 3v10" /></svg></button>}
          <button type="button" aria-pressed={sheetMode === "page"} title={sheetMode === "page" ? "Back beside the roadmap" : "Full page"} aria-label={sheetMode === "page" ? "Back to the roadmap" : "Show as a full page"}
            onClick={() => sheetMode === "page" ? setSheetModeState(savedSheetMode()) : setSheetModeState("page")}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" /></svg></button>
          <button type="button" aria-label="Close" title="Close" onClick={closeSheet}>×</button>
        </div>
        <div className="roadmap-sheet-scroll">
          {sheet.kind === "text" ? <>
            <div className="roadmap-strip"><p className="roadmap-strip-where">This roadmap's own text{graphOf(sheet.roadmapId)?.total ? ` · ${graphOf(sheet.roadmapId)!.finished} of ${graphOf(sheet.roadmapId)!.total} steps done` : ""}</p></div>
            {(fill || sheet.roadmapId !== conversation.id) && renderDocument ? renderDocument(sheet.roadmapId) ?? <SheetFallback conversation={conversations[sheet.roadmapId]} onOpen={() => onOpen({ docId: sheet.roadmapId })} />
              : <SheetFallback conversation={conversations[sheet.roadmapId]} onOpen={() => onOpen({ docId: sheet.roadmapId })} note={fill ? undefined : "This roadmap's text is right below it."} />}
          </> : sheetNode && sheetGraph ? <StepSheet key={`${sheet.step.roadmapId}/${sheet.step.nodeId}`} step={sheet.step} node={sheetNode} graph={sheetGraph}
            owner={conversations[sheet.step.roadmapId] ?? shown} conversations={conversations} pending={isWaiting(sheetNode)}
            writing={Boolean(writingIds?.[sheetNode.target.docId])} order={order(sheetGraph)} titleOf={(id) => stepTitle(sheet.step.roadmapId, id)}
            subOpen={openSubs.has(openSubKey(sheet.step.roadmapId, sheet.step.nodeId))}
            onGo={(nodeId) => openStep({ roadmapId: sheet.step.roadmapId, nodeId })}
            onChange={(next) => changeIn(sheet.step.roadmapId, next)}
            onToggleSub={() => toggleSub(sheet.step)} onEnter={() => enter(sheet.step)} onOpen={onOpen}
            onRelink={() => setRelinking(sheet.step)} renderDocument={renderDocument}
            onExplain={onExplain ? (context) => { const busy = Boolean(writingIds?.[sheetNode.target.docId]); const error = onExplain(sheetNode.target.docId, context, sheet.step.roadmapId === conversation.id ? undefined : sheet.step.roadmapId); setMessage(error); if (!error && busy) setToast("Explain starts when AI finishes writing here"); return !error; } : undefined}
            onDiveDeeper={onDiveDeeper ? () => { const busy = Boolean(writingIds?.[sheetNode.target.docId]); const error = onDiveDeeper(sheetNode.target.docId, sheet.step.roadmapId === conversation.id ? undefined : sheet.step.roadmapId); setMessage(error); if (!error && busy) setToast("Dive deeper starts when AI finishes writing here"); return !error; } : undefined} /> : null}
        </div>
      </aside> : null}
      {toast ? <p className="roadmap-toast" role="status" style={{ bottom: 64 + cover.bottom }}>{toast}</p> : null}
    </div>
    {adding ? <AddStepDialog adding={adding} conversations={conversations} roadmapId={adding.roadmapId}
      stageTitle={getRoadmap(conversations[adding.roadmapId] ?? shown).stages.find((stage) => stage.id === adding.stageId)?.title ?? "this stage"}
      onCreate={onCreateStep ? (title) => {
        const nodeId = newRoadmapId("node");
        const error = onCreateStep(adding.roadmapId, adding.stageId, title, nodeId);
        if (error) { setToast(error); return; }
        setAdding(null);
        setSheet({ kind: "step", step: { roadmapId: adding.roadmapId, nodeId } });
      } : undefined}
      onPick={(target) => {
        const nodeId = newRoadmapId("node");
        if (changeIn(adding.roadmapId, { kind: "add-node", stageId: adding.stageId, target, nodeId })) setAdding(null);
      }} onCancel={() => setAdding(null)} /> : null}
    {relinking ? <div className="roadmap-picker" role="dialog" aria-modal="true" aria-label="Relink step"
      onPointerDown={(event) => { if (event.target === event.currentTarget) setRelinking(null); }}>
      <div className="roadmap-picker-card">
        <DocumentLinkPicker conversations={conversations} sourceConversationId={relinking.roadmapId} heading="Point this step at another document"
          onCancel={() => setRelinking(null)}
          onSelect={(target) => {
            changeIn(relinking.roadmapId, { kind: "relink", nodeId: relinking.nodeId, target: { docId: target.conversationId, ...(target.blockId ? { blockId: target.blockId } : {}) } });
            setRelinking(null);
          }} />
      </div>
    </div> : null}
  </section>;
}

function AddStepDialog({ adding, conversations, roadmapId, stageTitle, onCreate, onPick, onCancel }: {
  adding: Adding; conversations: Record<string, Conversation>; roadmapId: string; stageTitle: string;
  onCreate?: (title: string) => void; onPick: (target: RoadmapNode["target"]) => void; onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  return <div className="roadmap-picker" role="dialog" aria-modal="true" aria-label={`Add a step to ${stageTitle}`}
    onPointerDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <div className="roadmap-picker-card" data-stage={adding.stageId}>
      {onCreate ? <form className="roadmap-new-step" onSubmit={(event) => { event.preventDefault(); if (title.trim()) onCreate(title.trim()); }}>
        <label htmlFor="roadmap-new-step">New step in <strong>{stageTitle}</strong></label>
        <div>
          <input id="roadmap-new-step" autoFocus value={title} maxLength={200} placeholder="What to learn or do" onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape") onCancel(); }} />
          <button type="submit" disabled={!title.trim()}>Add</button>
        </div>
        <p>Makes a new document for it. Or pick one you already have:</p>
      </form> : null}
      <DocumentLinkPicker conversations={conversations} sourceConversationId={roadmapId}
        heading={onCreate ? "Use a document or block" : "Add a document or block as a step"} onCancel={onCancel}
        onSelect={(target) => onPick({ docId: target.conversationId, ...(target.blockId ? { blockId: target.blockId } : {}) })} />
    </div>
  </div>;
}

/** What a document says, read here when it can't be opened beside the roadmap. */
function SheetFallback({ conversation, onOpen, note, blockId }: { conversation?: Conversation; onOpen: () => void; note?: string; blockId?: string }) {
  const paragraphs = useMemo(() => {
    if (!conversation) return [];
    const blocks = getEditableDocument(conversation).blocks;
    const text = blockId ? blocks.find((block) => block.id === blockId)?.content ?? "" : blocks.map((block) => block.content).join("\n\n");
    return text.split(/\n+/u).map((line) => ({ text: plainPreview(line),
      kind: /^\s*#{1,6}\s/u.test(line) ? "heading" : /^\s*(?:[-+*]|\d+[.)])\s/u.test(line) ? "item" : "text" })).filter((line) => line.text).slice(0, 200);
  }, [conversation, blockId]);
  return <div className="roadmap-sheet-reading">
    {note ? <p className="roadmap-sheet-muted">{note}</p> : null}
    {paragraphs.length ? paragraphs.map((line, index) => <p key={index} className={`is-${line.kind}`}>{line.text}</p>) : <p className="roadmap-sheet-muted">Nothing written here yet.</p>}
    <button type="button" className="roadmap-sheet-action" onClick={onOpen}>Open {blockId ? "passage" : "document"}<span aria-hidden="true"> ↗</span></button>
  </div>;
}

interface StepSheetProps {
  step: RoadmapStep;
  node: RoadmapNode;
  graph: RoadmapGraph;
  owner: Conversation;
  conversations: Record<string, Conversation>;
  pending: boolean;
  writing: boolean;
  /** The roadmap's steps in reading order, for Previous and Next. */
  order: string[];
  titleOf: (nodeId: string) => string;
  subOpen: boolean;
  onGo: (nodeId: string) => void;
  onChange: (change: RoadmapChange) => boolean;
  onToggleSub: () => void;
  onEnter: () => void;
  onOpen: (target: RoadmapNode["target"]) => void;
  onRelink: () => void;
  renderDocument?: (docId: string) => ReactNode;
  onExplain?: (context: string) => boolean;
  onDiveDeeper?: () => boolean;
}

/** A step's document, under a strip that says where it sits on the roadmap and what it needs and unlocks. */
function StepSheet({ node, graph, owner, conversations, pending, writing, order, titleOf, subOpen, onGo, onChange, onToggleSub, onEnter, onOpen, onRelink, renderDocument, onExplain, onDiveDeeper }: StepSheetProps) {
  const status = roadmapStatus(node);
  const target = conversations[node.target.docId];
  const missing = graph.missing.has(node.id) && !pending;
  const index = order.indexOf(node.id);
  const stage = getRoadmap(owner).stages.find((item) => item.id === node.stage);
  const position = useMemo(() => new Map(order.map((id, at) => [id, at])), [order]);
  const inOrder = (ids: string[]) => [...ids].sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0));
  const needs = inOrder(graph.needs.get(node.id) ?? []);
  const unlocks = inOrder(graph.neededBy.get(node.id) ?? []);
  const others = graph.roadmap.nodes.filter((item) => item.id !== node.id && !needs.includes(item.id));
  const sub = roadmapOfStep(node, conversations);
  const subSteps = sub ? getRoadmap(sub).nodes.length : 0;
  const [settings, setSettings] = useState(false);
  const [proof, setProof] = useState(node.proof ?? "");
  useEffect(() => { setProof(node.proof ?? ""); }, [node.proof]);

  const context = () => {
    const before = needs.map(titleOf), after = unlocks.map(titleOf);
    return [stage ? `It is in the stage “${stage.title}”.` : "", before.length ? `I learn these first: ${before.join(", ")}.` : "",
      after.length ? `It leads on to: ${after.join(", ")}.` : ""].filter(Boolean).join(" ");
  };
  // Opening a step whose document has nothing to read yet asks AI for the explanation, once.
  const thin = useMemo(() => {
    if (!target || node.target.blockId) return false;
    const editable = getEditableDocument(target);
    return !editable.generations.length && plainPreview(editable.blocks.map((block) => block.content).join("\n\n")).length < 600;
  }, [target, node.target.blockId]);
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current || !thin || writing || pending || missing || !onExplain) return;
    asked.current = true;
    onExplain(context());
    // context reads the same graph; asking once is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thin, writing, pending, missing, onExplain]);

  const chips = (ids: string[], label: string, removable: boolean) => ids.length ? <div className="roadmap-strip-links">
    <span>{label}</span>
    {ids.map((id) => <span key={id} className="roadmap-strip-chip">
      <button type="button" onClick={() => onGo(id)} title={`Open ${titleOf(id)}`}><StatusMark status={roadmapStatus(graph.nodesById.get(id)!)} />{titleOf(id)}</button>
      {removable ? <button type="button" className="roadmap-strip-remove" aria-label={`Remove prerequisite ${titleOf(id)}`} title="Doesn't need this first"
        onClick={() => onChange({ kind: "remove-prerequisite", nodeId: node.id, prerequisiteId: id })}>×</button> : null}
    </span>)}
  </div> : null;

  // One row: status, where it sits, Previous and Next, and everything else in a menu, so the document gets the space.
  const [menu, setMenu] = useState<"status" | "more" | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => { if (!stripRef.current?.contains(event.target as Node)) setMenu(null); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setMenu(null); } };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", key); };
  }, [menu]);
  const pick = (action: () => void) => () => { setMenu(null); action(); };
  const linkItems = (ids: string[], label: string) => ids.length ? <>
    <p className="roadmap-strip-menu-label">{label}</p>
    {ids.map((id) => <button key={id} type="button" role="menuitem" onClick={pick(() => onGo(id))}>
      <StatusMark status={roadmapStatus(graph.nodesById.get(id)!)} /><span>{titleOf(id)}</span>
    </button>)}
  </> : null;
  const where = `${stage?.title ?? "Unstaged"} · ${owner.title || "Untitled roadmap"}`;
  const chevron = <svg className="roadmap-strip-chevron" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 4l2.5 2.5L7.5 4" /></svg>;

  return <>
    <div className="roadmap-strip" ref={stripRef}>
      <div className="roadmap-strip-row">
        {missing || pending ? null : <div className="roadmap-strip-pop">
          <button type="button" className={`roadmap-strip-status is-${status}`} aria-haspopup="menu" aria-expanded={menu === "status"}
            aria-label={`Status: ${ROADMAP_STATUS_LABELS[status]}. Change`} onClick={() => setMenu(menu === "status" ? null : "status")}>
            <StatusMark status={status} /><span>{ROADMAP_STATUS_LABELS[status]}</span>{chevron}
          </button>
          {menu === "status" ? <div className="roadmap-strip-menu" role="menu" aria-label="Status">
            {STATUSES.map((item: RoadmapStatus) => <button key={item} type="button" role="menuitemradio" aria-checked={status === item}
              onClick={pick(() => onChange({ kind: "status", nodeId: node.id, status: item }))}>
              <StatusMark status={item} /><span>{ROADMAP_STATUS_LABELS[item]}</span>
            </button>)}
          </div> : null}
        </div>}
        {writing ? <span className="roadmap-strip-writing" role="status" title="AI is writing in this step's document"><span aria-hidden="true" />Writing</span> : null}
        <p className="roadmap-strip-where" title={where}>{where}</p>
        <button type="button" className="roadmap-strip-icon" disabled={index <= 0} onClick={() => onGo(order[index - 1])}
          aria-label="Previous step" title={index > 0 ? `Previous: ${titleOf(order[index - 1])}` : undefined}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" /></svg>
        </button>
        <button type="button" className="roadmap-strip-icon" disabled={index < 0 || index >= order.length - 1} onClick={() => onGo(order[index + 1])}
          aria-label="Next step" title={index >= 0 && index < order.length - 1 ? `Next: ${titleOf(order[index + 1])}` : undefined}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" /></svg>
        </button>
        <div className="roadmap-strip-pop">
          <button type="button" className="roadmap-strip-icon" aria-haspopup="menu" aria-expanded={menu === "more"} aria-label="More for this step"
            title="What it needs and unlocks, AI and settings" onClick={() => setMenu(menu === "more" ? null : "more")}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r=".9" /><circle cx="8" cy="8" r=".9" /><circle cx="12.5" cy="8" r=".9" /></svg>
          </button>
          {menu === "more" ? <div className="roadmap-strip-menu is-end" role="menu" aria-label="This step">
            {linkItems(needs, "Needs first")}
            {linkItems(unlocks, "Unlocks")}
            {missing || pending ? null : <>
              {needs.length || unlocks.length ? <hr /> : null}
              {sub ? <>
                <button type="button" role="menuitem" onClick={pick(onToggleSub)}>{subOpen ? "Hide its roadmap" : `Show its roadmap (${subSteps} ${subSteps === 1 ? "step" : "steps"})`}</button>
                <button type="button" role="menuitem" onClick={pick(onEnter)}>Go into its roadmap <span aria-hidden="true">↘</span></button>
              </> : null}
              {onDiveDeeper && !node.target.blockId ? <button type="button" role="menuitem"
                title={writing ? "Starts as soon as AI finishes writing in this step's document" : "AI breaks this topic into its own roadmap, inside the step's document, for you to approve"}
                onClick={pick(() => { onDiveDeeper(); })}>{sub ? "Dive deeper again" : "Dive deeper"}</button> : null}
              {onExplain && !node.target.blockId ? <button type="button" role="menuitem"
                title={writing ? "Starts as soon as AI finishes writing in this step's document" : "AI writes an explanation of this topic into the step's document"}
                onClick={pick(() => { onExplain(context()); })}>Explain with AI</button> : null}
              <button type="button" role="menuitem" onClick={pick(() => setSettings(!settings))}>{settings ? "Hide step settings" : "Step settings"}</button>
            </>}
          </div> : null}
        </div>
      </div>
      {settings && !missing && !pending ? <div className="roadmap-strip-settings">
        {needs.length ? <div className="roadmap-strip-settings-wide">{chips(needs, "Needs first", true)}</div> : null}
        <label>
          <span>Name on the roadmap</span>
          <input defaultValue={node.title ?? ""} placeholder={target?.title || "Untitled document"} maxLength={200} key={node.title ?? ""}
            onBlur={(event) => { if (event.target.value !== (node.title ?? "")) onChange({ kind: "rename-node", nodeId: node.id, title: event.target.value }); }}
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
        </label>
        <label>
          <span>Stage</span>
          <select value={node.stage} onChange={(event) => onChange({ kind: "move-node", nodeId: node.id, stageId: event.target.value })}>
            {stage ? null : <option value={node.stage}>Unstaged</option>}
            {getRoadmap(owner).stages.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select>
        </label>
        <label>
          <span>Proof</span>
          <input value={proof} placeholder="Built X, can explain Y…" maxLength={500} onChange={(event) => setProof(event.target.value)}
            onBlur={() => { if (proof !== (node.proof ?? "")) onChange({ kind: "proof", nodeId: node.id, proof }); }}
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
        </label>
        {others.length ? <label>
          <span>Needs first</span>
          <select aria-label="Add a step it needs first" value="" onChange={(event) => { if (event.target.value) onChange({ kind: "add-prerequisite", nodeId: node.id, prerequisiteId: event.target.value }); }}>
            <option value="">Add a step it needs…</option>
            {others.map((item) => <option key={item.id} value={item.id}>{titleOf(item.id)}</option>)}
          </select>
        </label> : null}
        <div className="roadmap-strip-actions">
          <button type="button" onClick={onRelink}>Point at another document</button>
          <button type="button" className="is-danger" onClick={() => onChange({ kind: "remove-node", nodeId: node.id })}>Remove from roadmap</button>
        </div>
      </div> : null}
    </div>
    {pending ? <p className="roadmap-sheet-muted roadmap-sheet-pad">Bringing this document in from your cloud vault…</p>
      : missing ? <div className="roadmap-sheet-pad">
        <p>The {node.target.blockId ? "block" : "document"} this step pointed at was deleted or moved.</p>
        <div className="roadmap-strip-actions">
          <button type="button" onClick={onRelink}>Relink</button>
          <button type="button" className="is-danger" onClick={() => onChange({ kind: "remove-node", nodeId: node.id })}>Remove step</button>
        </div>
      </div>
      : node.target.blockId ? <SheetFallback conversation={target} blockId={node.target.blockId} onOpen={() => onOpen(node.target)} />
      : renderDocument?.(node.target.docId) ?? <SheetFallback conversation={target} onOpen={() => onOpen(node.target)} />}
  </>;
}
