import type { PublicExpansion, PublicTopic } from "./publicKnowledge";
import type { PrivateAnswer } from "./publicMapApi";
import {
  addExplored, capExploration, emptyExploration, expansionItems, layoutPreviews, parseExploration, publicTopicFromAnswer, PREVIEW_CARD, topicItem,
  type ExploredBatch, type ExploredItem, type MapExploration, type PreviewBox,
} from "./mapExploration";

/**
 * Explore mode: a scratch map of Wikipedia topics, separate from the vault.
 * It uses the same items as map previews, so a node can be kept with the
 * same code that keeps previews, but it is stored apart and never shown on
 * the person's own map.
 */

export type ExplorerSource = "wikipedia" | "ai";

/** How far a node has been expanded from each source, kept in `expansions` beside Wikipedia's own offset. */
export const expansionKey = (source: ExplorerSource, id: string) => `${source === "wikipedia" ? "item" : "ai"}:${id}`;

/** Starting topics for an empty explorer. Plain Wikipedia article titles. */
export const SUGGESTED_TOPICS = [
  "Aging", "Cellular senescence", "Regenerative medicine", "Organoid", "CRISPR gene editing", "Stem cell",
  "Neuroscience", "Immunology", "Protein folding", "Machine learning", "Quantum computing", "Philosophy of mind",
];

export const explorerStorageKey = (workspaceKey: string) => `margin-topic-explorer:${workspaceKey}`;

export function readExplorer(storage: Pick<Storage, "getItem"> | undefined, workspaceKey: string): MapExploration {
  try { return parseExploration(JSON.parse(storage?.getItem(explorerStorageKey(workspaceKey)) ?? "null")) ?? emptyExploration(); }
  catch { return emptyExploration(); }
}

/** A topic the person searched for or picked: a new starting node. */
export function addRoot(state: MapExploration, topic: PublicTopic, batch: ExploredBatch): MapExploration {
  if (state.items[`topic:${topic.id}`]) return state;
  return addExplored(state, batch, [topicItem(topic, { parent: null, batchId: batch.id, exploredAt: batch.createdAt }, { via: "Wikipedia" })]);
}

/**
 * One page of Wikipedia connections as children of `parentId`. Broader topics
 * are left out, since a subgraph goes deeper, and so are topics already in
 * the explorer, which stay where they are.
 */
export function wikipediaChildren(state: MapExploration, parentId: string, expansion: PublicExpansion, batch: ExploredBatch, exploredAt: string): ExploredItem[] {
  return expansionItems(expansion, { parent: { kind: "item", id: parentId }, batchId: batch.id, exploredAt })
    .filter((item) => item.connection?.kind !== "broader" && !state.items[item.id]);
}

/** The topics an AI answer names, as children of `parentId`. */
export function aiChildren(state: MapExploration, parentId: string, answer: PrivateAnswer, batch: ExploredBatch, exploredAt: string): ExploredItem[] {
  return answer.related.flatMap((topic) => {
    const item = topicItem(publicTopicFromAnswer(topic, exploredAt), { parent: { kind: "item", id: parentId }, batchId: batch.id, exploredAt },
      { via: `AI · ${topic.relation}`, connection: { kind: "related", label: topic.relation } });
    return state.items[item.id] ? [] : [item];
  });
}

/** What to ask AI for a node's subtopics, with the person's own focus first; later asks name what is already there. */
export function aiSubtopicQuestion(label: string, existing: string[], focus = "") {
  const wanted = focus.replace(/\s+/g, " ").trim().slice(0, 200);
  const base = `What are the main subtopics, parts and branches of ${label}?${wanted ? ` Focus on: ${wanted}.` : ""} Give a short overview and name the most important subtopics to explore next.`;
  return (existing.length ? `${base} Leave out ${existing.slice(0, 12).join(", ")}, which I have already explored.` : base).slice(0, 500);
}

/**
 * Where a node sits in the exploration, for AI: the path of parents that led
 * to it, its siblings and the branches it already has, so the subtopics it
 * names fit the direction the person is exploring.
 */
export function aiSubgraphContext(state: MapExploration, id: string): string {
  const item = state.items[id];
  if (!item) return "";
  const path: ExploredItem[] = [];
  const seen = new Set<string>();
  for (let current: ExploredItem | undefined = item; current && !seen.has(current.id); ) {
    seen.add(current.id); path.unshift(current);
    current = current.parent?.kind === "item" ? state.items[current.parent.id] : undefined;
  }
  const { childrenOf } = childrenIndex(state);
  const describe = (node: ExploredItem) => node.detail ? `${node.label} (${node.detail.slice(0, 120)})` : node.label;
  const parentId = item.parent?.kind === "item" && state.items[item.parent.id] ? item.parent.id : null;
  const siblings = parentId ? childrenOf(parentId).filter((other) => other !== id).map((other) => state.items[other].label) : [];
  const children = childrenOf(id).map((child) => state.items[child].label);
  const lines = [
    "The person is exploring a map of topics and wants subtopics of the last topic in this path.",
    `Path from the starting topic: ${path.map(describe).join(" → ")}`,
    item.connection?.label ? `How ${item.label} joins its parent: ${item.connection.label}` : "",
    siblings.length ? `Other branches beside it: ${siblings.slice(0, 20).join(", ")}` : "",
    children.length ? `Branches it already has: ${children.slice(0, 30).join(", ")}` : "",
    path.length > 1 ? `Prefer subtopics that are about ${item.label} in the sense this path implies, not the other topics in the path.` : "",
  ];
  return lines.filter(Boolean).join("\n").slice(0, 6000);
}

export function childrenIndex(state: MapExploration) {
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  const byTime = Object.values(state.items).sort((a, b) => a.exploredAt.localeCompare(b.exploredAt) || a.label.localeCompare(b.label));
  for (const item of byTime) {
    const parent = item.parent?.kind === "item" && state.items[item.parent.id] ? item.parent.id : null;
    if (parent) children.set(parent, [...children.get(parent) ?? [], item.id]);
    else roots.push(item.id);
  }
  return { roots, childrenOf: (id: string) => children.get(id) ?? [] };
}

/** A node and everything that branched off it. */
export function descendants(state: MapExploration, id: string): string[] {
  const { childrenOf } = childrenIndex(state);
  const found: string[] = [];
  const seen = new Set<string>();
  const visit = (current: string) => {
    if (seen.has(current)) return;
    seen.add(current); found.push(current);
    childrenOf(current).forEach(visit);
  };
  visit(id);
  return found;
}

/** Removes a node with its branches. */
export function removeBranch(state: MapExploration, id: string): MapExploration {
  const removed = new Set(descendants(state, id));
  const items = Object.fromEntries(Object.entries(state.items).filter(([key]) => !removed.has(key)));
  const expansions = Object.fromEntries(Object.entries(state.expansions).filter(([key]) => !removed.has(key.slice(key.indexOf(":") + 1))));
  const batchIds = new Set(Object.values(items).map((item) => item.batchId));
  return capExploration({ ...state, items, expansions, batches: Object.fromEntries(Object.entries(state.batches).filter(([key]) => batchIds.has(key))) });
}

/** A line from a node to a branch. Tree lines leave from a side; the other layouts join card centers. */
export interface ExplorerEdge { from: string; to: string; side?: "left" | "right" }
export interface ExplorerLayout { boxes: Map<string, PreviewBox>; edges: ExplorerEdge[] }
const TREE_GAP = 80;

/**
 * A mind map per starting topic: its branches alternate right and left of
 * it, each laid out as a tidy tree so cards never overlap. Starting topics
 * stack downward.
 */
export function layoutExplorer(state: MapExploration): ExplorerLayout {
  const { roots, childrenOf } = childrenIndex(state);
  const boxes = new Map<string, PreviewBox>();
  const edges: ExplorerEdge[] = [];
  let top = 0;
  for (const root of roots) {
    const rootBox: PreviewBox = { x: -PREVIEW_CARD.width / 2, y: 0, ...PREVIEW_CARD };
    const branches = childrenOf(root);
    const right = layoutPreviews([{ anchor: rootBox, rootIds: branches.filter((_, index) => index % 2 === 0) }], childrenOf);
    const left = layoutPreviews([{ anchor: rootBox, rootIds: branches.filter((_, index) => index % 2 === 1) }], childrenOf);
    const tree = new Map<string, PreviewBox>([[root, rootBox]]);
    const sides = new Map<string, "left" | "right">();
    for (const [id, box] of right) { tree.set(id, box); sides.set(id, "right"); }
    for (const [id, box] of left) { if (!tree.has(id)) { tree.set(id, { ...box, x: -box.x - box.width }); sides.set(id, "left"); } }
    const minY = Math.min(...[...tree.values()].map((box) => box.y));
    const maxY = Math.max(...[...tree.values()].map((box) => box.y + box.height));
    for (const [id, box] of tree) boxes.set(id, { ...box, y: box.y - minY + top });
    for (const [id, side] of sides) {
      const parent = state.items[id]?.parent;
      if (parent?.kind === "item" && tree.has(parent.id)) edges.push({ from: parent.id, to: id, side });
    }
    top += maxY - minY + TREE_GAP;
  }
  return { boxes, edges };
}

export type ExplorerArrangement = "tree" | "radial" | "network" | "grid" | "brain" | "canvas";
export const ARRANGEMENTS: Array<{ id: ExplorerArrangement; label: string; hint: string }> = [
  { id: "tree", label: "Tree", hint: "Branches spread right and left of each starting topic" },
  { id: "radial", label: "Radial", hint: "Each branch is a cluster around its starting topic" },
  { id: "network", label: "Network", hint: "Connected topics pull together, like a force-directed graph" },
  { id: "grid", label: "Grid", hint: "Every topic in tidy rows, in the order they branch" },
  { id: "brain", label: "Focus", hint: "One topic in the middle: its parent above, branches below, siblings beside" },
  { id: "canvas", label: "Canvas", hint: "Drag topics wherever you like" },
];
export const isArrangement = (value: unknown): value is ExplorerArrangement => ARRANGEMENTS.some((item) => item.id === value);

const centerBox = (x: number, y: number): PreviewBox => ({ x: x - PREVIEW_CARD.width / 2, y: y - PREVIEW_CARD.height / 2, ...PREVIEW_CARD });
const center = (box: PreviewBox) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

/** Every parent link between two nodes in `boxes`. */
function parentEdges(state: MapExploration, boxes: Map<string, PreviewBox>): ExplorerEdge[] {
  return [...boxes.keys()].flatMap((id) => {
    const parent = state.items[id]?.parent;
    return parent?.kind === "item" && boxes.has(parent.id) ? [{ from: parent.id, to: id }] : [];
  });
}

/** Nodes in branch order: each starting topic, then its branches depth first. */
function branchOrder(state: MapExploration) {
  const { roots, childrenOf } = childrenIndex(state);
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => { if (seen.has(id)) return; seen.add(id); order.push(id); childrenOf(id).forEach(visit); };
  roots.forEach(visit);
  return { order, roots, childrenOf };
}

/**
 * A radial tree per starting topic: depth rings, each branch given an arc in
 * proportion to how many leaves it holds, so every branch reads as a cluster.
 * Rings grow when a level has too many cards to fit. Trees sit side by side.
 */
export function layoutRadial(state: MapExploration): ExplorerLayout {
  const { roots, childrenOf } = childrenIndex(state);
  const boxes = new Map<string, PreviewBox>();
  let left = 0;
  for (const root of roots) {
    const leaves = new Map<string, number>();
    const depthCount = new Map<number, number>();
    const count = (id: string, depth: number, seen: Set<string>): number => {
      seen.add(id);
      depthCount.set(depth, (depthCount.get(depth) ?? 0) + 1);
      const kids = childrenOf(id).filter((kid) => !seen.has(kid));
      const total = kids.length ? kids.reduce((sum, kid) => sum + count(kid, depth + 1, seen), 0) : 1;
      leaves.set(id, total);
      return total;
    };
    count(root, 0, new Set());
    const radii = [0];
    for (let depth = 1; depthCount.has(depth); depth += 1) {
      radii[depth] = Math.max(radii[depth - 1] + 230, (depthCount.get(depth)! * (PREVIEW_CARD.width * 0.75)) / (2 * Math.PI));
    }
    const positions = new Map<string, { x: number; y: number }>();
    const place = (id: string, depth: number, start: number, end: number) => {
      const angle = (start + end) / 2;
      positions.set(id, depth ? { x: Math.cos(angle) * radii[depth], y: Math.sin(angle) * radii[depth] * 0.72 } : { x: 0, y: 0 });
      let cursor = start;
      for (const kid of childrenOf(id)) {
        if (positions.has(kid)) continue;
        const span = ((end - start) * (leaves.get(kid) ?? 1)) / (leaves.get(id) ?? 1);
        place(kid, depth + 1, cursor, cursor + span);
        cursor += span;
      }
    };
    place(root, 0, -Math.PI / 2, Math.PI * 1.5);
    const minX = Math.min(...[...positions.values()].map((point) => point.x));
    const maxX = Math.max(...[...positions.values()].map((point) => point.x));
    for (const [id, point] of positions) boxes.set(id, centerBox(point.x - minX + left, point.y));
    left += maxX - minX + PREVIEW_CARD.width + TREE_GAP * 2;
  }
  return separate({ boxes, edges: parentEdges(state, boxes) });
}

/** Pushes overlapping cards apart, a few passes, keeping the layout's shape. */
function separate(layout: ExplorerLayout, gap = 12): ExplorerLayout {
  const ids = [...layout.boxes.keys()];
  if (ids.length > 500) return layout;
  const points = new Map(ids.map((id) => [id, center(layout.boxes.get(id)!)]));
  const minX = PREVIEW_CARD.width + gap, minY = PREVIEW_CARD.height + gap;
  for (let pass = 0; pass < 40; pass += 1) {
    let moved = false;
    for (let i = 0; i < ids.length; i += 1) for (let j = i + 1; j < ids.length; j += 1) {
      const a = points.get(ids[i])!, b = points.get(ids[j])!;
      const dx = b.x - a.x, dy = b.y - a.y;
      const overlapX = minX - Math.abs(dx), overlapY = minY - Math.abs(dy);
      if (overlapX <= 0 || overlapY <= 0) continue;
      moved = true;
      // Move apart along the shorter way out.
      if (overlapY / minY < overlapX / minX) { const push = (overlapY / 2) * (dy < 0 ? -1 : 1) || overlapY / 2; a.y -= push; b.y += push; }
      else { const push = (overlapX / 2) * (dx < 0 ? -1 : 1) || overlapX / 2; a.x -= push; b.x += push; }
    }
    if (!moved) break;
  }
  return { ...layout, boxes: new Map(ids.map((id) => [id, centerBox(points.get(id)!.x, points.get(id)!.y)])) };
}

/**
 * A force-directed network, like vis-network: linked topics pull together,
 * all topics push apart, so each node sits inside its own small cloud of
 * neighbours. Starts from the radial layout, so it is the same every time.
 */
export function layoutNetwork(state: MapExploration): ExplorerLayout {
  const start = layoutRadial(state);
  const ids = [...start.boxes.keys()];
  const index = new Map(ids.map((id, i) => [id, i]));
  const x = ids.map((id) => center(start.boxes.get(id)!).x * 0.6), y = ids.map((id) => center(start.boxes.get(id)!).y * 0.6);
  const links = start.edges.map((edge) => [index.get(edge.from)!, index.get(edge.to)!] as const);
  const n = ids.length;
  const ideal = 120;
  const iterations = n > 250 ? 60 : n > 100 ? 120 : 220;
  for (let step = 0; step < iterations; step += 1) {
    const fx = new Float64Array(n), fy = new Float64Array(n);
    for (let i = 0; i < n; i += 1) for (let j = i + 1; j < n; j += 1) {
      // Cards are wide, so sideways neighbours count as closer and push harder.
      let dx = (x[i] - x[j]) / 1.7, dy = y[i] - y[j];
      let distance = Math.hypot(dx, dy);
      if (distance < 1) { dx = (i - j) || 1; dy = 1; distance = Math.hypot(dx, dy); }
      const force = (ideal * ideal) / distance;
      fx[i] += (dx / distance) * force; fy[i] += (dy / distance) * force;
      fx[j] -= (dx / distance) * force; fy[j] -= (dy / distance) * force;
    }
    for (const [a, b] of links) {
      const dx = x[a] - x[b], dy = y[a] - y[b];
      const distance = Math.max(1, Math.hypot(dx, dy));
      const force = (distance * distance) / ideal;
      fx[a] -= (dx / distance) * force; fy[a] -= (dy / distance) * force;
      fx[b] += (dx / distance) * force; fy[b] += (dy / distance) * force;
    }
    const limit = 60 * (1 - step / iterations) + 2;
    for (let i = 0; i < n; i += 1) {
      // A light pull to the middle keeps separate trees from drifting away.
      fx[i] -= x[i] * 0.02; fy[i] -= y[i] * 0.02;
      const length = Math.hypot(fx[i], fy[i]);
      if (!length) continue;
      const move = Math.min(limit, length);
      x[i] += (fx[i] / length) * move; y[i] += (fy[i] / length) * move;
    }
  }
  const boxes = new Map(ids.map((id, i) => [id, centerBox(x[i], y[i])]));
  return separate({ boxes, edges: start.edges });
}

const GRID_CELL = { width: PREVIEW_CARD.width + 24, height: PREVIEW_CARD.height + 22 };

/** Every topic in rows, in branch order, about as wide as it is tall on screen. */
export function layoutGrid(state: MapExploration): ExplorerLayout {
  const { order } = branchOrder(state);
  const columns = Math.max(1, Math.ceil(Math.sqrt(order.length * 2.2)));
  const boxes = new Map(order.map((id, i) => [id, { x: (i % columns) * GRID_CELL.width, y: Math.floor(i / columns) * GRID_CELL.height, ...PREVIEW_CARD }]));
  return { boxes, edges: parentEdges(state, boxes) };
}

/**
 * Like TheBrain: one topic in the middle, its parent above, its branches in
 * rows below and its siblings to the right. Only that neighbourhood shows;
 * choosing another topic moves it to the middle.
 */
export function layoutBrain(state: MapExploration, focusId: string | null): ExplorerLayout {
  const { roots, childrenOf } = childrenIndex(state);
  const focus = focusId && state.items[focusId] ? focusId : roots[0];
  const boxes = new Map<string, PreviewBox>();
  if (!focus) return { boxes, edges: [] };
  boxes.set(focus, centerBox(0, 0));
  const parent = state.items[focus].parent;
  const parentId = parent?.kind === "item" && state.items[parent.id] ? parent.id : null;
  const edges: ExplorerEdge[] = [];
  // Siblings stand to the right of the widest row of branches.
  const besideX = GRID_CELL.width * (Math.max(1, Math.min(4, childrenOf(focus).length)) / 2 + 0.7);
  const row = (ids: string[], top: number, perRow: number, left = 0) => ids.forEach((id, i) => {
    const inRow = Math.min(perRow, ids.length - Math.floor(i / perRow) * perRow);
    boxes.set(id, centerBox(left + ((i % perRow) - (inRow - 1) / 2) * GRID_CELL.width, top + Math.floor(i / perRow) * GRID_CELL.height));
  });
  if (parentId) {
    boxes.set(parentId, centerBox(0, -170));
    edges.push({ from: parentId, to: focus });
    const siblings = childrenOf(parentId).filter((id) => id !== focus);
    siblings.slice(0, 16).forEach((id, i) => {
      boxes.set(id, centerBox(besideX + Math.floor(i / 8) * GRID_CELL.width, -40 + (i % 8) * GRID_CELL.height * 0.86));
      edges.push({ from: parentId, to: id });
    });
  } else {
    // Other starting topics stand in for siblings.
    roots.filter((id) => id !== focus).slice(0, 16).forEach((id, i) => boxes.set(id, centerBox(besideX + Math.floor(i / 8) * GRID_CELL.width, -40 + (i % 8) * GRID_CELL.height * 0.86)));
  }
  const children = childrenOf(focus);
  row(children, 170, 4);
  for (const id of children) edges.push({ from: focus, to: id });
  return { boxes, edges };
}

/**
 * Free placement: saved spots where the person dragged a card, and for the
 * rest the spot `fallback` gives, nudged beside its parent's saved spot.
 */
export function layoutCanvas(state: MapExploration, positions: Record<string, { x: number; y: number }>, fallback: ExplorerLayout): ExplorerLayout {
  const boxes = new Map<string, PreviewBox>();
  const { order } = branchOrder(state);
  const used: PreviewBox[] = [];
  const free = (box: PreviewBox) => !used.some((other) => box.x < other.x + other.width + 8 && other.x < box.x + box.width + 8 && box.y < other.y + other.height + 8 && other.y < box.y + box.height + 8);
  for (const id of order) {
    const saved = positions[id];
    if (saved) { const box = { ...saved, ...PREVIEW_CARD }; boxes.set(id, box); used.push(box); }
  }
  for (const id of order) {
    if (boxes.has(id)) continue;
    const parent = state.items[id].parent;
    const parentBox = parent?.kind === "item" ? boxes.get(parent.id) : undefined;
    let box = fallback.boxes.get(id) ?? centerBox(0, 0);
    if (parentBox && parent?.kind === "item" && positions[parent.id]) box = { x: parentBox.x + parentBox.width + 48, y: parentBox.y, ...PREVIEW_CARD };
    for (let tries = 0; tries < 80 && !free(box); tries += 1) box = { ...box, y: box.y + PREVIEW_CARD.height + 10 };
    boxes.set(id, box); used.push(box);
  }
  return { boxes, edges: parentEdges(state, boxes) };
}

export function arrange(state: MapExploration, arrangement: ExplorerArrangement, options: { focusId?: string | null; positions?: Record<string, { x: number; y: number }> } = {}): ExplorerLayout {
  if (arrangement === "radial") return layoutRadial(state);
  if (arrangement === "network") return layoutNetwork(state);
  if (arrangement === "grid") return layoutGrid(state);
  if (arrangement === "brain") return layoutBrain(state, options.focusId ?? null);
  if (arrangement === "canvas") return layoutCanvas(state, options.positions ?? {}, layoutExplorer(state));
  return layoutExplorer(state);
}

export function boundsOf(boxes: Iterable<PreviewBox>): PreviewBox | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const box of boxes) {
    minX = Math.min(minX, box.x); minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width); maxY = Math.max(maxY, box.y + box.height);
  }
  return Number.isFinite(minX) ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : null;
}

export interface ExplorerView { x: number; y: number; scale: number }
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 2;
export const clampScale = (scale: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

/** The view that shows `bounds` inside a `width` × `height` canvas, never zooming in past 1. */
export function fitView(bounds: PreviewBox, width: number, height: number, padding = 48): ExplorerView {
  const scale = clampScale(Math.min(1, (width - padding * 2) / Math.max(1, bounds.width), (height - padding * 2) / Math.max(1, bounds.height)));
  return { scale, x: width / 2 - (bounds.x + bounds.width / 2) * scale, y: height / 2 - (bounds.y + bounds.height / 2) * scale };
}
