import { useEffect, useMemo, useRef, useState } from "react";
import DismissibleDetails from "./DismissibleDetails";
import StatusMark, { ROADMAP_STATUSES } from "./RoadmapStatusMark";
import type { MapOverlayContext } from "./ConversationGraphView";
import { ROADMAP_STATUS_LABELS, roadmapDraftLink, type RoadmapChange } from "../lib/roadmap";
import { waitingPathDraft, type MapPath, type MapPathStep, type MapPathSummary } from "../lib/mapPaths";
import type { AgentProgress } from "../lib/useChatStreams";
import type { AgentRoadmapProposal, Conversation, RoadmapStatus } from "../types";
import "./MapPaths.css";

/** What the Map needs from the workspace to show, make and change paths. */
export interface MapPathActions {
  /** A new path through these documents, in order; returns its id, or an error. */
  onCreatePath(title: string, docIds: string[]): { id: string } | { error: string };
  /** A new path note that AI drafts from a goal or a link; returns its id, or an error. */
  onDraftPath(goal: string): { id: string } | { error: string };
  /** One edit to a path; returns why it was refused, or null. */
  onChange(pathId: string, change: RoadmapChange): string | null;
  /** Explain a step with AI, or Dive deeper (the step becomes a path of its own); returns why it couldn't start, or null. */
  onStepAI(pathId: string, docId: string, action: "explain" | "deeper"): string | null;
  /** Keep or discard the path AI drafted; returns why it couldn't, or null. */
  onDraftDecision(pathId: string, messageId: string, proposalId: string, action: "approve" | "dismiss"): string | null;
  onStopDraft(pathId: string): void;
  /** Documents AI is writing in now. */
  writingIds: Record<string, unknown>;
  progress: Record<string, AgentProgress | undefined>;
  /** Download steps' documents that are still only in the cloud. */
  onLoadDocuments?(ids: string[]): void;
}

const PathIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="18.5" r="2.4" /><circle cx="19" cy="5.5" r="2.4" /><path d="M7.2 17.2C14 15 9 9.5 16.8 6.8" /></svg>;
const ListIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 6.5h11M8.5 12h11M8.5 17.5h11" /><circle cx="4.5" cy="6.5" r=".9" /><circle cx="4.5" cy="12" r=".9" /><circle cx="4.5" cy="17.5" r=".9" /></svg>;
const MapIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="7" r="2.2" /><circle cx="18" cy="9" r="2.2" /><circle cx="10" cy="17" r="2.2" /><path d="m8 8 8 .6M7.3 9l1.9 6.1M16.4 10.6l-4.6 5" /></svg>;

/** The toolbar's Paths menu: turn a path on, start one by hand, or have AI draft one. */
export function MapPathsMenu({ paths, activeId, onPick, onNew, onDraft }: {
  paths: MapPathSummary[];
  activeId: string | null;
  onPick(id: string | null): void;
  onNew(): void;
  onDraft(goal: string): string | null;
}) {
  const [drafting, setDrafting] = useState(false);
  const [goal, setGoal] = useState("");
  const [error, setError] = useState<string | null>(null);
  const active = paths.find((path) => path.id === activeId);
  const close = (element: HTMLElement) => { element.closest("details")?.removeAttribute("open"); setDrafting(false); setError(null); };
  const link = roadmapDraftLink(goal);
  return <DismissibleDetails className="map-paths-menu" onToggle={(event) => { if (!event.currentTarget.open) { setDrafting(false); setError(null); } }}>
    <summary aria-label={active ? `Path: ${active.name}` : "Paths"} title="Paths: learning roadmaps drawn over your map" className={active ? "is-on" : undefined}>
      <PathIcon /><span>{active ? active.name : "Paths"}</span>
    </summary>
    <div role="menu">
      {drafting ? <form className="map-paths-draft" onSubmit={(event) => {
        event.preventDefault();
        const reason = onDraft(goal);
        if (reason) { setError(reason); return; }
        setGoal(""); close(event.currentTarget);
      }}>
        <label htmlFor="map-paths-goal">What do you want to learn? A goal, or a link to a roadmap or article.</label>
        <input id="map-paths-goal" autoFocus value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="Lower my ApoB, or https://roadmap.sh/…" />
        <small>{link ? "AI reads the page and builds a path from it, reusing notes you have." : "AI builds a path from your notes, and adds notes for what's missing."}</small>
        {error ? <p role="alert">{error}</p> : null}
        <div><button type="submit" disabled={!goal.trim()}>Draft path</button><button type="button" onClick={() => { setDrafting(false); setError(null); }}>Back</button></div>
      </form> : <>
        {paths.length ? paths.map((path) => <button key={path.id} type="button" role="menuitemradio" aria-checked={path.id === activeId}
          onClick={(event) => { close(event.currentTarget); onPick(path.id === activeId ? null : path.id); }}>
          <PathIcon /><span>{path.name}</span><em>{path.finished}/{path.total}</em>
        </button>) : <p className="map-paths-empty">A path is a roadmap through your notes: steps in order, with what each needs first.</p>}
        <hr />
        <button type="button" role="menuitem" onClick={(event) => { close(event.currentTarget); onNew(); }}>+ New path: click notes in order</button>
        <button type="button" role="menuitem" onClick={() => setDrafting(true)}>✦ Draft a path with AI…</button>
      </>}
    </div>
  </DismissibleDetails>;
}

type Box = { x: number; y: number; width: number; height: number };
const center = (box: Box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
/** Where the line from a box's centre toward a point leaves the box. */
function edgePoint(box: Box, toward: { x: number; y: number }, pad = 4) {
  const c = center(box), dx = toward.x - c.x, dy = toward.y - c.y;
  const scale = Math.min(Math.abs((box.width / 2 + pad) / (dx || 1e-6)), Math.abs((box.height / 2 + pad) / (dy || 1e-6)));
  return { x: c.x + dx * scale, y: c.y + dy * scale };
}

/** The active path drawn over the map: numbered steps with their status, and "needs first" arrows. */
export function MapPathLayer({ context, path, currentDocId }: { context: MapOverlayContext; path: MapPath; currentDocId: string | null }) {
  const boxes = new Map<string, Box>();
  const dots = new Set<string>();
  for (const step of path.steps) {
    const dot = context.dotBox?.(step.docId);
    const box = dot ?? context.nodeBox(step.docId);
    if (dot) dots.add(step.docId);
    if (box) boxes.set(step.docId, box);
  }
  const touches = (docId: string) => currentDocId === docId;
  return <div className="map-path-layer" aria-hidden="true">
    <svg width={context.size.width} height={context.size.height}>
      <defs>
        <marker id="map-path-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" /></marker>
        <marker id="map-path-arrow-on" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" /></marker>
      </defs>
      {path.arrows.map(({ from, to }) => {
        const a = boxes.get(from), b = boxes.get(to);
        if (!a || !b) return null;
        const p1 = edgePoint(a, center(b)), p2 = edgePoint(b, center(a));
        const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2, bend = 0.12;
        const on = touches(from) || touches(to);
        return <path key={`${from}>${to}`} className={on ? "is-on" : undefined} markerEnd={`url(#${on ? "map-path-arrow-on" : "map-path-arrow"})`}
          d={`M${p1.x},${p1.y} Q${mx - (p2.y - p1.y) * bend},${my + (p2.x - p1.x) * bend} ${p2.x},${p2.y}`} />;
      })}
    </svg>
    {path.steps.map((step) => {
      const box = boxes.get(step.docId);
      if (!box) return null;
      return <span key={step.docId} className={`map-path-badge is-${step.status}${step.docId === currentDocId ? " is-current" : ""}${step.docId === path.nextUpDocId ? " is-next" : ""}`}
        style={dots.has(step.docId) ? { left: box.x - 6, top: box.y - 6 } : { left: box.x, top: box.y }}>{step.status === "done" ? "✓" : step.number}</span>;
    })}
  </div>;
}

/** Making a path by hand: every note on screen can be clicked to add it as the next step. */
export function MapPathPicker({ context, ids, picked, onToggle }: { context: MapOverlayContext; ids: string[]; picked: string[]; onToggle(id: string): void }) {
  const targets: { id: string; box: Box }[] = [];
  for (const id of ids) {
    const box = context.dotBox?.(id) ?? context.nodeBox(id);
    if (!box || box.x + box.width < 0 || box.y + box.height < 0 || box.x > context.size.width || box.y > context.size.height) continue;
    targets.push({ id, box });
    if (targets.length > 600) break;
  }
  return <div className="map-path-picker">
    {targets.map(({ id, box }) => {
      const index = picked.indexOf(id);
      const pad = box.width < 20 ? 8 : 0;
      return <button key={id} type="button" className={index >= 0 ? "is-picked" : undefined} aria-pressed={index >= 0}
        style={{ left: box.x - pad, top: box.y - pad, width: box.width + pad * 2, height: box.height + pad * 2 }}
        onClick={() => onToggle(id)}>{index >= 0 ? <span>{index + 1}</span> : null}</button>;
    })}
  </div>;
}

export function MapPathPickBanner({ count, onCancel, onDone }: { count: number; onCancel(): void; onDone(title: string): void }) {
  const [title, setTitle] = useState("");
  return <form className="map-path-pick-banner" data-graph-ui="true" onSubmit={(event) => { event.preventDefault(); if (count) onDone(title.trim() || "New path"); }}>
    <span>{count ? `${count} step${count === 1 ? "" : "s"}. Click more notes, or click one again to take it out.` : "Click notes in the order you want to learn them."}</span>
    <input aria-label="Path name" placeholder="Name the path" value={title} onChange={(event) => setTitle(event.target.value)} />
    <button type="button" onClick={onCancel}>Cancel</button>
    <button type="submit" className="is-primary" disabled={!count}>Make path</button>
  </form>;
}

/**
 * The path bar at the bottom of the map: progress, ‹ step ›, Map | List and ✕,
 * with the current step's strip above it (status, needs first, unlocks, AI).
 */
export function MapPathBar({ path, trail, conversations, currentDocId, layout, actions, message, onStep, onLayout, onClose, onOpenNote, onOpenStep, onGoIn, onGoTo, onMessage }: {
  path: MapPath;
  /** Paths this one was gone into from, outermost first. */
  trail: MapPathSummary[];
  conversations: Record<string, Conversation>;
  currentDocId: string | null;
  layout: "map" | "list";
  actions: MapPathActions;
  message: string | null;
  onStep(docId: string): void;
  onLayout(layout: "map" | "list"): void;
  onClose(): void;
  onOpenNote(): void;
  onOpenStep(docId: string): void;
  onGoIn(pathId: string): void;
  onGoTo(pathId: string): void;
  onMessage(text: string | null): void;
}) {
  const step = path.steps.find((item) => item.docId === currentDocId) ?? null;
  const index = step ? path.steps.indexOf(step) : -1;
  const shown = step ?? path.steps.find((item) => item.docId === path.nextUpDocId) ?? null;
  const pathNote = conversations[path.id];
  const progress = actions.progress[path.id];
  const draft = useMemo(() => pathNote ? waitingPathDraft(pathNote) : null, [pathNote]);
  const drafting = Boolean(actions.writingIds[path.id]);
  const writing = step ? Boolean(actions.writingIds[step.docId]) : false;
  const stepIsPath = step && step.docId !== path.id && conversations[step.docId]?.nodeType === "roadmap";
  const percent = path.total ? Math.round((path.finished / path.total) * 100) : 0;
  const titleOf = (docId: string) => path.steps.find((item) => item.docId === docId)?.title ?? conversations[docId]?.title ?? "Untitled";
  const run = (reason: string | null) => onMessage(reason);

  return <div className="map-path-dock" data-graph-ui="true">
    {drafting || draft ? <div className="map-path-draft" role="status" aria-live="polite">
      {draft ? <>
        <span>✦ AI drafted {draftSize(draft.proposal)} for “{path.name}”.</span>
        <button type="button" onClick={() => run(actions.onDraftDecision(path.id, draft.messageId, draft.proposal.id, "dismiss"))}>Discard</button>
        <button type="button" className="is-primary" onClick={() => run(actions.onDraftDecision(path.id, draft.messageId, draft.proposal.id, "approve"))}>Keep</button>
      </> : <>
        <span className="map-path-spinner" aria-hidden="true" />
        <span>{progress?.label || (progress?.roadmapDraft ? `Drafting: ${progress.roadmapDraft.stages.reduce((sum, stage) => sum + stage.steps.length, 0)} steps so far…` : "AI is drafting this path…")}</span>
        <button type="button" onClick={() => actions.onStopDraft(path.id)}>Stop</button>
      </>}
    </div> : null}
    {step ? <section className="map-path-step" aria-label={`Step ${index + 1}: ${step.title}`}>
      <header>
        <StatusMark status={step.status} />
        <strong>{index + 1}. {step.title}</strong>
        <em>{step.stageTitle}</em>
        <select aria-label="Status" value={step.status} onChange={(event) => run(actions.onChange(path.id, { kind: "status", nodeId: step.nodeId, status: event.target.value as RoadmapStatus }))}>
          {ROADMAP_STATUSES.map((status) => <option key={status} value={status}>{ROADMAP_STATUS_LABELS[status]}</option>)}
        </select>
      </header>
      {step.needs.length || step.unlocks.length ? <div className="map-path-links">
        {step.needs.length ? <span>Needs first {step.needs.map((id) => <button key={id} type="button" onClick={() => onStep(id)}>{titleOf(id)}</button>)}</span> : null}
        {step.unlocks.length ? <span>Unlocks {step.unlocks.map((id) => <button key={id} type="button" onClick={() => onStep(id)}>{titleOf(id)}</button>)}</span> : null}
      </div> : null}
      <div className="map-path-actions">
        <button type="button" onClick={() => onOpenStep(step.docId)}>Open</button>
        <button type="button" disabled={writing} onClick={() => run(actions.onStepAI(path.id, step.docId, "explain"))}>{writing ? "AI is writing…" : "✦ Explain"}</button>
        {stepIsPath ? <button type="button" onClick={() => onGoIn(step.docId)}>Go into its path ›</button>
          : <button type="button" onClick={() => { const reason = actions.onStepAI(path.id, step.docId, "deeper"); run(reason ?? "AI is breaking this step into a path of its own. Keep it in the step's note, then Go into its path."); }}>↘ Dive deeper</button>}
      </div>
    </section> : null}
    {message ? <p className="map-path-message" role="status">{message}<button type="button" aria-label="Dismiss" onClick={() => onMessage(null)}>×</button></p> : null}
    <div className="map-path-bar" role="toolbar" aria-label={`Path: ${path.name}`}>
      <span className="map-path-name">
        <PathIcon />
        {trail.map((item) => <button key={item.id} type="button" className="is-crumb" onClick={() => onGoTo(item.id)}>{item.name} ›</button>)}
        <button type="button" onClick={onOpenNote} title="Open the path's own note">{path.name}</button>
      </span>
      <span className="map-path-meter" aria-hidden="true"><span style={{ width: `${percent}%` }} /></span>
      <span className="map-path-count">{path.finished}/{path.total}</span>
      <span className="map-path-stepper">
        <button type="button" aria-label="Previous step" disabled={!path.steps.length || index === 0} onClick={() => onStep(path.steps[Math.max(0, index - 1)]?.docId ?? path.steps[0].docId)}>‹</button>
        <button type="button" className="map-path-current" disabled={!shown} onClick={() => shown && onStep(shown.docId)}>
          {step ? `${index + 1}. ${step.title}` : shown ? `Next up: ${shown.title}` : path.steps.length ? "All done" : "No steps yet"}
        </button>
        <button type="button" aria-label="Next step" disabled={!path.steps.length || index === path.steps.length - 1} onClick={() => onStep(path.steps[index < 0 ? 0 : index + 1]?.docId)}>›</button>
      </span>
      <span className="map-path-layouts" role="group" aria-label="Layout">
        <button type="button" aria-pressed={layout === "map"} aria-label="Map" title="On the map" onClick={() => onLayout("map")}><MapIcon /><span>Map</span></button>
        <button type="button" aria-pressed={layout === "list"} aria-label="List" title="As a list" onClick={() => onLayout("list")}><ListIcon /><span>List</span></button>
      </span>
      <button type="button" className="map-path-close" aria-label="Turn the path off" title="Turn the path off" onClick={onClose}>×</button>
    </div>
  </div>;
}

function draftSize(proposal: AgentRoadmapProposal) {
  const steps = proposal.stages.reduce((sum, stage) => sum + stage.steps.length, 0);
  const fresh = proposal.stages.reduce((sum, stage) => sum + stage.steps.filter((item) => !item.documentId).length, 0);
  return `${steps} step${steps === 1 ? "" : "s"}${fresh ? `, ${fresh} new note${fresh === 1 ? "" : "s"}` : ""}`;
}

/** List: the same steps in order, stage by stage, over the dimmed map. */
export function MapPathList({ path, currentDocId, onStep }: { path: MapPath; currentDocId: string | null; onStep(docId: string): void }) {
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    listRef.current?.querySelector(".is-current")?.scrollIntoView?.({ block: "nearest" });
  }, [currentDocId]);
  const stages: { id: string; title: string; steps: MapPathStep[] }[] = [];
  for (const step of path.steps) {
    const last = stages.at(-1);
    if (last?.id === step.stageId) last.steps.push(step); else stages.push({ id: step.stageId, title: step.stageTitle, steps: [step] });
  }
  return <div className="map-path-list" data-graph-ui="true">
    <ol ref={listRef}>
      {stages.map((stage) => <li key={stage.id} className="map-path-list-stage">
        <h3>{stage.title}<span>{stage.steps.filter((step) => step.status === "done" || step.status === "skipped").length}/{stage.steps.length}</span></h3>
        <ol>{stage.steps.map((step) => <li key={step.docId}>
          <button type="button" className={`${step.docId === currentDocId ? "is-current" : ""}${step.docId === path.nextUpDocId ? " is-next" : ""}`} onClick={() => onStep(step.docId)}>
            <span className="map-path-list-number">{step.number}</span><StatusMark status={step.status} /><span>{step.title}</span>
            {step.docId === path.nextUpDocId ? <em>Next up</em> : null}
          </button>
        </li>)}</ol>
      </li>)}
      {!path.steps.length ? <li className="map-path-list-empty">No steps yet. Draft it with AI from the Paths menu, or make a path by clicking notes.</li> : null}
    </ol>
  </div>;
}
