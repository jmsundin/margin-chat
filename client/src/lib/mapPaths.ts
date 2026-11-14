import { createMapNote } from "./graphWorkspaceEdits";
import { applyRoadmapChange, buildRoadmapGraph, getRoadmap, makeRoadmapDocument, newRoadmapId, roadmapNodeTitle, roadmapStatus } from "./roadmap";
import type { AgentRoadmapProposal, AppState, Conversation, RoadmapStatus } from "../types";

/**
 * A path is a roadmap drawn on the Map: an ordered walk through notes that stay
 * where they are, with "needs first" arrows between them. It is stored as a
 * roadmap document (its "path note"), so its name, text, stages, statuses and
 * prerequisites are the roadmap's own.
 */
export interface MapPathStep {
  nodeId: string;
  docId: string;
  title: string;
  status: RoadmapStatus;
  stageId: string;
  stageTitle: string;
  /** 1-based place in the path. */
  number: number;
  /** Doc ids this step needs first, and doc ids it unlocks. */
  needs: string[];
  unlocks: string[];
}

export interface MapPath {
  id: string;
  name: string;
  steps: MapPathStep[];
  /** Prerequisite arrows between documents: `from` is needed first by `to`. */
  arrows: { from: string; to: string }[];
  finished: number;
  total: number;
  /** The first step that isn't done and whose prerequisites are. */
  nextUpDocId: string | null;
}

export interface MapPathSummary { id: string; name: string; finished: number; total: number; parentId?: string }

export const isPathDocument = (conversation: Conversation | undefined) => conversation?.nodeType === "roadmap";

/** Every path in the vault, most recently changed first. */
export function listMapPaths(conversations: Record<string, Conversation>): MapPathSummary[] {
  return Object.values(conversations).filter(isPathDocument)
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.id.localeCompare(b.id))
    .map((conversation) => {
      const nodes = getRoadmap(conversation).nodes.filter((node) => conversations[node.target.docId]);
      return { id: conversation.id, name: conversation.title || "Untitled path", total: nodes.length,
        finished: nodes.filter((node) => node.status === "done" || node.status === "skipped").length };
    });
}

/** A path's steps in reading order (stage by stage, prerequisites first). Steps whose document is gone are left out. */
export function buildMapPath(conversation: Conversation, conversations: Record<string, Conversation>): MapPath {
  const graph = buildRoadmapGraph(getRoadmap(conversation), conversations);
  const docOf = (nodeId: string) => graph.nodesById.get(nodeId)?.target.docId;
  const steps: MapPathStep[] = [];
  const seen = new Set<string>();
  for (const stage of graph.stages) {
    for (const row of stage.rows) for (const nodeId of row.nodeIds) {
      const node = graph.nodesById.get(nodeId);
      if (!node || graph.missing.has(nodeId) || seen.has(node.target.docId)) continue;
      seen.add(node.target.docId);
      steps.push({ nodeId, docId: node.target.docId, title: roadmapNodeTitle(node, conversations), status: roadmapStatus(node),
        stageId: stage.id, stageTitle: stage.title, number: steps.length + 1, needs: [], unlocks: [] });
    }
  }
  const byDoc = new Map(steps.map((step) => [step.docId, step]));
  const arrows: MapPath["arrows"] = [];
  const arrowKeys = new Set<string>();
  for (const edge of graph.edges) {
    const from = docOf(edge.to), to = docOf(edge.from);
    if (!from || !to || from === to || !byDoc.has(from) || !byDoc.has(to) || arrowKeys.has(`${from}\0${to}`)) continue;
    arrowKeys.add(`${from}\0${to}`);
    arrows.push({ from, to });
    byDoc.get(to)!.needs.push(from);
    byDoc.get(from)!.unlocks.push(to);
  }
  const finished = steps.filter((step) => step.status === "done" || step.status === "skipped").length;
  const nextUp = steps.find((step) => graph.nextUp.has(step.nodeId)) ?? steps.find((step) => step.status !== "done" && step.status !== "skipped");
  return { id: conversation.id, name: conversation.title || "Untitled path", steps, arrows, finished, total: steps.length, nextUpDocId: nextUp?.docId ?? null };
}

/** A draft path AI finished for this path note, waiting to be kept or discarded. */
export function waitingPathDraft(conversation: Conversation): { messageId: string; proposal: AgentRoadmapProposal } | null {
  for (const item of [...conversation.messages].reverse()) {
    const proposal = item.execution?.agent?.proposals?.find((entry) => entry.kind === "roadmap" && entry.roadmapId === conversation.id && !entry.status);
    if (proposal?.kind === "roadmap") return { messageId: item.id, proposal };
  }
  return null;
}

/** The step after or before `docId`; with no current step, the next-up step. */
export function stepAround(path: MapPath, docId: string | null, direction: 1 | -1): string | null {
  if (!path.steps.length) return null;
  const index = docId ? path.steps.findIndex((step) => step.docId === docId) : -1;
  if (index < 0) return path.nextUpDocId ?? path.steps[0].docId;
  return path.steps[Math.max(0, Math.min(path.steps.length - 1, index + direction))].docId;
}

/**
 * A new path through the given documents, in the order given: a new path note
 * (a roadmap document) with one stage, each document a step needing the one
 * before it. The active document stays the one you were on.
 */
export function createMapPath(state: AppState, args: { id: string; noteId: string; title: string; docIds: string[]; createdAt: string; position?: { x: number; y: number }; stageTitle?: string;
  /** Fixed ids, so the same call gives the same path when replayed on newer state. */
  stageId?: string; nodeIds?: string[] }): AppState {
  const made = createMapNote(state, { id: args.id, noteId: args.noteId, createdAt: args.createdAt, title: args.title, position: args.position });
  const note = made.conversations[args.id];
  if (!note) return state;
  const stageId = args.stageId ?? newRoadmapId("stage");
  let next: AppState = { ...made, activeConversationId: state.activeConversationId, rootId: state.rootId,
    conversations: { ...made.conversations, [args.id]: { ...makeRoadmapDocument(note, args.createdAt), roadmap: { version: 1, stages: [{ id: stageId, title: args.stageTitle ?? "Steps" }], nodes: [] } } } };
  const nodeIds: string[] = [];
  [...new Set(args.docIds)].forEach((docId, index) => {
    if (!next.conversations[docId] || docId === args.id) return;
    const nodeId = args.nodeIds?.[index] ?? newRoadmapId("node");
    next = applyRoadmapChange(next, args.id, { kind: "add-node", stageId, target: { docId }, nodeId }, args.createdAt).state;
    const before = nodeIds.at(-1);
    nodeIds.push(nodeId);
    // A loop (B already needs A) is refused; the step simply has no arrow in.
    if (before) {
      const linked = applyRoadmapChange(next, args.id, { kind: "add-prerequisite", nodeId, prerequisiteId: before }, args.createdAt);
      if (!linked.error) next = linked.state;
    }
  });
  return next;
}

/** A short name for a path from what was asked for: the goal itself, or the page a link points at. */
export function pathNameFromGoal(goal: string): string {
  const text = goal.trim().replace(/\s+/g, " ");
  try {
    const url = new URL(text);
    const last = url.pathname.split("/").filter(Boolean).at(-1) ?? url.hostname;
    const words = decodeURIComponent(last).replace(/[-_]+/g, " ").replace(/\b[a-z0-9]{4,6}$/i, (tail) => /\d/.test(tail) ? "" : tail).trim();
    return (words ? words[0].toUpperCase() + words.slice(1) : url.hostname).slice(0, 80);
  } catch {
    return (text.length > 80 ? `${text.slice(0, 79)}…` : text) || "New path";
  }
}

const ACTIVE_KEY = "margin-chat:map-path";
export function readActivePath(workspaceKey: string): string | null {
  try { return window.localStorage?.getItem(`${ACTIVE_KEY}:${workspaceKey}`) || null; } catch { return null; }
}
export function rememberActivePath(workspaceKey: string, pathId: string | null) {
  try {
    if (pathId) window.localStorage?.setItem(`${ACTIVE_KEY}:${workspaceKey}`, pathId);
    else window.localStorage?.removeItem(`${ACTIVE_KEY}:${workspaceKey}`);
  } catch { /* not remembered */ }
}
const LAYOUT_KEY = "margin-chat:map-path-layout";
export function readPathLayout(): "map" | "list" {
  try { return window.localStorage?.getItem(LAYOUT_KEY) === "list" ? "list" : "map"; } catch { return "map"; }
}
export function rememberPathLayout(layout: "map" | "list") {
  try { window.localStorage?.setItem(LAYOUT_KEY, layout); } catch { /* not remembered */ }
}
