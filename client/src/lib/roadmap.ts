import { createEmptyRoadmap, normalizeRoadmap, ROADMAP_NODE_TYPE } from "@margin-chat/workspace-contracts";
import type { AgentRoadmapProposal, AppState, Conversation, Roadmap, RoadmapNode, RoadmapStatus } from "../types";
import { setDocumentRelation } from "./documentRelations";

/** A prerequisite: `from` needs `to` first. `source` says where the edge is stored. */
export interface RoadmapEdge { from: string; to: string; source: "relation" | "local" }

export interface RoadmapLayoutRow { nodeIds: string[] }
export interface RoadmapLayoutStage { id: string; title: string; rows: RoadmapLayoutRow[]; total: number; finished: number; unknown?: true }
export interface RoadmapGraph {
  roadmap: Roadmap;
  nodesById: Map<string, RoadmapNode>;
  edges: RoadmapEdge[];
  /** Prerequisites of each node, including ones from a cycle that the layout ignored. */
  needs: Map<string, string[]>;
  neededBy: Map<string, string[]>;
  stages: RoadmapLayoutStage[];
  nextUp: Set<string>;
  missing: Set<string>;
  /** Edges left out of the layout because they close a cycle (hand-edited files only). */
  cycleEdges: RoadmapEdge[];
  total: number;
  finished: number;
}

export const ROADMAP_STATUS_LABELS: Record<RoadmapStatus, string> = {
  "not-started": "Not started", learning: "Learning", done: "Done", skipped: "Skipped",
};

export function getRoadmap(conversation: Conversation): Roadmap {
  return normalizeRoadmap(conversation.roadmap) ?? createEmptyRoadmap();
}

export function roadmapStatus(node: RoadmapNode): RoadmapStatus {
  return node.status ?? "not-started";
}

const isFinished = (node: RoadmapNode) => node.status === "done" || node.status === "skipped";
const byOrder = (a: RoadmapNode, b: RoadmapNode) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Prerequisites stored on the roadmap, plus `depends-on` relations between
 * whole-document targets. Block targets use the roadmap's own `dependsOn`.
 */
export function roadmapEdges(roadmap: Roadmap, conversations: Record<string, Conversation>): RoadmapEdge[] {
  const edges = new Map<string, RoadmapEdge>();
  const add = (edge: RoadmapEdge) => { const key = `${edge.from}\0${edge.to}`; if (!edges.has(key) && edge.from !== edge.to) edges.set(key, edge); };
  const byDocument = new Map<string, RoadmapNode[]>();
  for (const node of roadmap.nodes) {
    for (const to of node.dependsOn ?? []) add({ from: node.id, to, source: "local" });
    if (!node.target.blockId) byDocument.set(node.target.docId, [...(byDocument.get(node.target.docId) ?? []), node]);
  }
  for (const node of roadmap.nodes) {
    if (node.target.blockId) continue;
    for (const relation of conversations[node.target.docId]?.relations ?? []) {
      if (relation.type !== "depends-on" || !relation.targetConversationId || relation.targetBlockId) continue;
      for (const prerequisite of byDocument.get(relation.targetConversationId) ?? []) add({ from: node.id, to: prerequisite.id, source: "relation" });
    }
  }
  return [...edges.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

/** True when making `from` need `to` would close a loop; returns the loop as node ids, from `to` back to `from`. */
export function findRoadmapCycle(edges: RoadmapEdge[], from: string, to: string): string[] | null {
  if (from === to) return [from];
  const needs = new Map<string, string[]>();
  for (const edge of edges) needs.set(edge.from, [...(needs.get(edge.from) ?? []), edge.to]);
  // A path from `to` through its prerequisites back to `from` closes the loop.
  const previous = new Map<string, string>([[to, ""]]);
  const queue = [to];
  while (queue.length) {
    const current = queue.shift()!;
    if (current === from) {
      const path = [from];
      for (let step = previous.get(from); step; step = previous.get(step)) path.unshift(step);
      return path;
    }
    for (const next of needs.get(current) ?? []) if (!previous.has(next)) { previous.set(next, current); queue.push(next); }
  }
  return null;
}

/**
 * Deterministic layered layout: a node sits one row below its deepest
 * prerequisite, stages keep their saved order, and each row is in saved node
 * order. The same roadmap draws the same picture on every device.
 */
export function buildRoadmapGraph(roadmap: Roadmap, conversations: Record<string, Conversation>): RoadmapGraph {
  const nodesById = new Map(roadmap.nodes.map((node) => [node.id, node]));
  const edges = roadmapEdges(roadmap, conversations);
  const needs = new Map<string, string[]>();
  const neededBy = new Map<string, string[]>();
  for (const edge of edges) {
    needs.set(edge.from, [...(needs.get(edge.from) ?? []), edge.to]);
    neededBy.set(edge.to, [...(neededBy.get(edge.to) ?? []), edge.from]);
  }
  // Depth-first in saved order; an edge back into the current path is a cycle
  // (only possible in a hand-edited file) and is left out of the layout.
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const cycleEdges: RoadmapEdge[] = [];
  const ordered = [...roadmap.nodes].sort(byOrder);
  const findCycles = (id: string) => {
    if (visited.has(id)) return;
    visiting.add(id);
    for (const prerequisite of needs.get(id) ?? []) {
      if (visiting.has(prerequisite)) cycleEdges.push(edges.find((edge) => edge.from === id && edge.to === prerequisite)!);
      else findCycles(prerequisite);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const node of ordered) findCycles(node.id);
  const ignored = new Set(cycleEdges.map((edge) => `${edge.from}\0${edge.to}`));
  // Rows within a stage follow prerequisites in that stage; earlier stages
  // already come first, so a step needing only earlier stages starts its stage.
  const layer = new Map<string, number>();
  const rowOf = (id: string): number => {
    const known = layer.get(id);
    if (known !== undefined) return known;
    layer.set(id, 0);
    const stage = nodesById.get(id)!.stage;
    let depth = 0;
    for (const prerequisite of needs.get(id) ?? []) {
      if (ignored.has(`${id}\0${prerequisite}`) || nodesById.get(prerequisite)!.stage !== stage) continue;
      depth = Math.max(depth, rowOf(prerequisite) + 1);
    }
    layer.set(id, depth);
    return depth;
  };
  for (const node of ordered) rowOf(node.id);

  const missing = new Set(roadmap.nodes.filter((node) => {
    const target = conversations[node.target.docId];
    return !target || (node.target.blockId && !target.document?.blocks.some((block) => block.id === node.target.blockId));
  }).map((node) => node.id));
  const nextUp = new Set(roadmap.nodes.filter((node) => !isFinished(node) && !missing.has(node.id)
    && (needs.get(node.id) ?? []).every((id) => ignored.has(`${node.id}\0${id}`) || isFinished(nodesById.get(id)!))).map((node) => node.id));

  const knownStages = new Set(roadmap.stages.map((stage) => stage.id));
  const unstaged = ordered.filter((node) => !knownStages.has(node.stage));
  const stageList: { id: string; title: string; unknown?: true }[] = [...roadmap.stages, ...(unstaged.length ? [{ id: "", title: "Unstaged", unknown: true as const }] : [])];
  const stages = stageList.map((stage) => {
    const members = stage.unknown ? unstaged : ordered.filter((node) => node.stage === stage.id);
    const depths = [...new Set(members.map((node) => layer.get(node.id)!))].sort((a, b) => a - b);
    return {
      ...stage,
      rows: depths.map((depth) => ({ nodeIds: members.filter((node) => layer.get(node.id) === depth).map((node) => node.id) })),
      total: members.length,
      finished: members.filter(isFinished).length,
    };
  });
  return { roadmap, nodesById, edges, needs, neededBy, stages, nextUp, missing, cycleEdges,
    total: roadmap.nodes.length, finished: roadmap.nodes.filter(isFinished).length };
}

export function roadmapNodeTitle(node: RoadmapNode, conversations: Record<string, Conversation>): string {
  if (node.title) return node.title;
  const target = conversations[node.target.docId];
  if (!target) return "Missing document";
  if (node.target.blockId) {
    const block = target.document?.blocks.find((item) => item.id === node.target.blockId);
    const line = block ? plainPreview(block.content).slice(0, 80) : "";
    if (line) return line;
  }
  return target.title || "Untitled document";
}

/** Plain text only: previews never render a target's HTML or interactive Markdown. */
export function plainPreview(content: string): string {
  return content
    .replace(/^\s*(`{3,}|~{3,}).*$/gm, "")
    .replace(/!?\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_, target: string, label?: string) => label || target)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-+*]\s+|\d+[.)]\s+)+/gm, "")
    .replace(/[*`~]+/g, "")
    .replace(/\s+/g, " ").trim();
}

export function newRoadmapId(prefix: "node" | "stage") {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function withRoadmap(state: AppState, roadmapId: string, change: (roadmap: Roadmap) => Roadmap, updatedAt: string): AppState {
  const conversation = state.conversations[roadmapId];
  if (!conversation) return state;
  const roadmap = normalizeRoadmap(change(getRoadmap(conversation)));
  if (!roadmap) return state;
  return { ...state, conversations: { ...state.conversations, [roadmapId]: { ...conversation, roadmap, updatedAt } } };
}

export type RoadmapChange =
  | { kind: "status"; nodeId: string; status: RoadmapStatus }
  | { kind: "proof"; nodeId: string; proof: string }
  | { kind: "add-node"; stageId: string; target: RoadmapNode["target"]; nodeId?: string }
  | { kind: "relink"; nodeId: string; target: RoadmapNode["target"] }
  | { kind: "remove-node"; nodeId: string }
  | { kind: "move-node"; nodeId: string; stageId?: string; direction?: -1 | 1 }
  | { kind: "rename-node"; nodeId: string; title: string }
  | { kind: "add-stage"; title: string; stageId?: string }
  | { kind: "rename-stage"; stageId: string; title: string }
  | { kind: "move-stage"; stageId: string; direction: -1 | 1 }
  | { kind: "remove-stage"; stageId: string }
  | { kind: "add-prerequisite"; nodeId: string; prerequisiteId: string }
  | { kind: "remove-prerequisite"; nodeId: string; prerequisiteId: string };

export type RoadmapChangeResult = { state: AppState; error?: string };

const swap = <T,>(items: T[], index: number, other: number) => {
  if (index < 0 || other < 0 || other >= items.length) return items;
  const next = [...items];
  [next[index], next[other]] = [next[other], next[index]];
  return next;
};

/**
 * Apply one edit. A prerequisite between two whole documents is written as a
 * `depends-on` relation on the dependent document, so other views see it too;
 * otherwise it is kept on the roadmap. Loops are refused with the loop named.
 */
export function applyRoadmapChange(state: AppState, roadmapId: string, change: RoadmapChange, updatedAt: string): RoadmapChangeResult {
  const conversation = state.conversations[roadmapId];
  if (!conversation) return { state };
  const roadmap = getRoadmap(conversation);
  const nodes = (update: (node: RoadmapNode) => RoadmapNode | null) => withRoadmap(state, roadmapId, (current) => ({
    ...current, nodes: current.nodes.flatMap((node) => { const next = update(node); return next ? [next] : []; }),
  }), updatedAt);
  switch (change.kind) {
    case "status":
      return { state: nodes((node) => {
        if (node.id !== change.nodeId) return node;
        const { status: _status, ...rest } = node;
        return change.status === "not-started" ? rest : { ...rest, status: change.status };
      }) };
    case "proof":
      return { state: nodes((node) => node.id !== change.nodeId ? node : (({ proof: _proof, ...rest }) => change.proof.trim() ? { ...rest, proof: change.proof } : rest)(node)) };
    case "rename-node":
      return { state: nodes((node) => node.id !== change.nodeId ? node : (({ title: _title, ...rest }) => change.title.trim() ? { ...rest, title: change.title } : rest)(node)) };
    case "relink":
      return { state: nodes((node) => node.id === change.nodeId ? { ...node, target: change.target } : node) };
    case "remove-node":
      return { state: withRoadmap(state, roadmapId, (current) => ({ ...current, nodes: current.nodes
        .filter((node) => node.id !== change.nodeId)
        .map((node) => node.dependsOn?.includes(change.nodeId) ? { ...node, dependsOn: node.dependsOn.filter((id) => id !== change.nodeId) } : node) }), updatedAt) };
    case "add-node": {
      const stageId = roadmap.stages.some((stage) => stage.id === change.stageId) ? change.stageId : roadmap.stages[0]?.id;
      const withStage = stageId ? roadmap : { ...roadmap, stages: [{ id: newRoadmapId("stage"), title: "Stage 1" }] };
      const stage = stageId ?? withStage.stages[0].id;
      const order = Math.max(-1, ...roadmap.nodes.filter((node) => node.stage === stage).map((node) => node.order)) + 1;
      const node: RoadmapNode = { id: change.nodeId ?? newRoadmapId("node"), target: change.target, stage, order };
      return { state: withRoadmap(state, roadmapId, () => ({ ...withStage, nodes: [...withStage.nodes, node] }), updatedAt) };
    }
    case "move-node": {
      const moving = roadmap.nodes.find((node) => node.id === change.nodeId);
      if (!moving) return { state };
      if (change.stageId !== undefined) {
        const order = Math.max(-1, ...roadmap.nodes.filter((node) => node.stage === change.stageId).map((node) => node.order)) + 1;
        return { state: nodes((node) => node.id === moving.id ? { ...node, stage: change.stageId!, order } : node) };
      }
      // Earlier or later within the node's row: rows are set by prerequisites.
      const graph = buildRoadmapGraph(roadmap, state.conversations);
      const row = graph.stages.flatMap((stage) => stage.rows).find((item) => item.nodeIds.includes(moving.id));
      const index = row?.nodeIds.indexOf(moving.id) ?? -1;
      const neighbor = row?.nodeIds[index + (change.direction ?? 1)];
      if (!row || !neighbor) return { state };
      // Renumber the row so equal or sparse orders still swap cleanly.
      const reordered = swap(row.nodeIds, index, index + (change.direction ?? 1));
      const base = Math.min(...row.nodeIds.map((id) => graph.nodesById.get(id)!.order));
      const orders = new Map(reordered.map((id, position) => [id, base + position]));
      return { state: nodes((node) => orders.has(node.id) ? { ...node, order: orders.get(node.id)! } : node) };
    }
    case "add-stage":
      return { state: withRoadmap(state, roadmapId, (current) => ({ ...current,
        stages: [...current.stages, { id: change.stageId ?? newRoadmapId("stage"), title: change.title.trim() || `Stage ${current.stages.length + 1}` }] }), updatedAt) };
    case "rename-stage":
      return { state: withRoadmap(state, roadmapId, (current) => ({ ...current,
        stages: current.stages.map((stage) => stage.id === change.stageId ? { ...stage, title: change.title.trim() || stage.title } : stage) }), updatedAt) };
    case "move-stage": {
      const index = roadmap.stages.findIndex((stage) => stage.id === change.stageId);
      return { state: withRoadmap(state, roadmapId, (current) => ({ ...current, stages: swap(current.stages, index, index + change.direction) }), updatedAt) };
    }
    case "remove-stage":
      if (roadmap.nodes.some((node) => node.stage === change.stageId)) return { state, error: "Move or remove this stage's nodes first." };
      return { state: withRoadmap(state, roadmapId, (current) => ({ ...current, stages: current.stages.filter((stage) => stage.id !== change.stageId) }), updatedAt) };
    case "add-prerequisite": {
      const node = roadmap.nodes.find((item) => item.id === change.nodeId);
      const prerequisite = roadmap.nodes.find((item) => item.id === change.prerequisiteId);
      if (!node || !prerequisite) return { state };
      const edges = roadmapEdges(roadmap, state.conversations);
      if (edges.some((edge) => edge.from === node.id && edge.to === prerequisite.id)) return { state };
      const cycle = findRoadmapCycle(edges, node.id, prerequisite.id);
      if (cycle) {
        const names = [node.id, ...cycle].map((id) => `“${roadmapNodeTitle(roadmap.nodes.find((item) => item.id === id)!, state.conversations)}”`);
        return { state, error: `That would make a loop: ${names.join(" needs ")}. A roadmap can't loop back on itself.` };
      }
      const sourceId = node.target.docId;
      const targetId = prerequisite.target.docId;
      if (!node.target.blockId && !prerequisite.target.blockId && sourceId !== targetId
        && state.conversations[sourceId] && state.conversations[targetId]) {
        const next = setDocumentRelation(state, { sourceId, targetId, type: "depends-on", updatedAt });
        if (next !== state) return { state: next };
      }
      return { state: nodes((item) => item.id === node.id ? { ...item, dependsOn: [...(item.dependsOn ?? []), prerequisite.id] } : item) };
    }
    case "remove-prerequisite": {
      const node = roadmap.nodes.find((item) => item.id === change.nodeId);
      const prerequisite = roadmap.nodes.find((item) => item.id === change.prerequisiteId);
      if (!node || !prerequisite) return { state };
      let next = nodes((item) => item.id === node.id && item.dependsOn ? (({ dependsOn, ...rest }) => {
        const kept = dependsOn!.filter((id) => id !== prerequisite.id);
        return kept.length ? { ...rest, dependsOn: kept } : rest;
      })(item) : item);
      const relation = roadmapEdges(roadmap, state.conversations).some((edge) => edge.from === node.id && edge.to === prerequisite.id && edge.source === "relation");
      if (relation) next = setDocumentRelation(next, { sourceId: node.target.docId, targetId: prerequisite.target.docId, type: null, previousType: "depends-on", remove: true, updatedAt });
      return { state: next };
    }
  }
}

/** Mark a document as a roadmap, keeping any stages it had before. */
export function makeRoadmapDocument(conversation: Conversation, updatedAt: string): Conversation {
  return { ...conversation, nodeType: ROADMAP_NODE_TYPE, roadmap: normalizeRoadmap(conversation.roadmap) ?? createEmptyRoadmap(newRoadmapId("stage")), updatedAt };
}

/** Stop drawing a roadmap; its stages and statuses stay saved in case it is turned back on. */
export function unmakeRoadmapDocument(conversation: Conversation, updatedAt: string): Conversation {
  const { nodeType: _nodeType, ...rest } = conversation;
  return { ...rest, updatedAt };
}

export interface RoadmapDraftIds { stages: string[]; nodes: Record<string, string> }

/** IDs made once per approval, so the state update gives the same roadmap however often it runs. */
export function roadmapDraftIds(proposal: AgentRoadmapProposal): RoadmapDraftIds {
  return { stages: proposal.stages.map(() => newRoadmapId("stage")),
    nodes: Object.fromEntries(proposal.stages.flatMap((stage) => stage.steps).map((step) => [step.key, newRoadmapId("node")])) };
}

/**
 * Add an approved AI draft to a roadmap: its stages after any already there, its steps, then its
 * prerequisites (written as `depends-on` like any other). Steps citing a document this vault doesn't
 * have are left out, and so is any prerequisite that would loop with what the roadmap already has.
 */
export function applyRoadmapDraft(state: AppState, proposal: AgentRoadmapProposal, ids: RoadmapDraftIds,
  options: { updatedAt: string; known?: (id: string) => boolean }): { state: AppState; added: number; skipped: number } | null {
  const conversation = state.conversations[proposal.roadmapId];
  if (!conversation) return null;
  const { updatedAt } = options;
  const known = (id: string) => Boolean(state.conversations[id]) || (options.known?.(id) ?? false);
  let next: AppState = conversation.nodeType === ROADMAP_NODE_TYPE ? state
    : { ...state, conversations: { ...state.conversations, [conversation.id]: makeRoadmapDocument(conversation, updatedAt) } };
  // A roadmap made just now has one empty placeholder stage, which the draft's stages replace.
  const current = getRoadmap(next.conversations[conversation.id]);
  const placeholder = current.nodes.length === 0 ? current.stages.map((stage) => stage.id) : [];
  const keyed = new Map<string, string>();
  let skipped = 0;
  proposal.stages.forEach((stage, index) => {
    const steps = stage.steps.filter((step) => {
      if (known(step.documentId) && step.documentId !== conversation.id) return true;
      skipped += 1;
      return false;
    });
    if (!steps.length) return;
    next = applyRoadmapChange(next, conversation.id, { kind: "add-stage", title: stage.title, stageId: ids.stages[index] }, updatedAt).state;
    for (const step of steps) {
      const nodeId = ids.nodes[step.key];
      next = applyRoadmapChange(next, conversation.id, { kind: "add-node", stageId: ids.stages[index], target: { docId: step.documentId }, nodeId }, updatedAt).state;
      if (step.title) next = applyRoadmapChange(next, conversation.id, { kind: "rename-node", nodeId, title: step.title }, updatedAt).state;
      keyed.set(step.key, nodeId);
    }
  });
  if (keyed.size) for (const stageId of placeholder) next = applyRoadmapChange(next, conversation.id, { kind: "remove-stage", stageId }, updatedAt).state;
  for (const step of proposal.stages.flatMap((stage) => stage.steps)) {
    const nodeId = keyed.get(step.key);
    if (!nodeId) continue;
    for (const need of step.needs) {
      const prerequisiteId = keyed.get(need);
      if (prerequisiteId) next = applyRoadmapChange(next, conversation.id, { kind: "add-prerequisite", nodeId, prerequisiteId }, updatedAt).state;
    }
  }
  return { state: next, added: keyed.size, skipped };
}
