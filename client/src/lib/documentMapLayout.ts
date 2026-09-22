import type { ConversationGraphNodePlacement } from "./conversationGraph";
import type { GraphViewport } from "./graphInteractions";
import { mapLabelsOverlap } from "./graphPresentation";

const CARD = { width: 180, height: 96 };
const GAP = 36;
const MIN_INITIAL_SCALE = 0.5;
const MAX_INITIAL_SCALE = 0.9;

export type DocumentLayoutMode = "auto" | "tree-right" | "tree-down" | "connections";
type DocumentConnection = { sourceId: string; targetId: string };

function nodeBounds(nodes: ConversationGraphNodePlacement[]) {
  const x = Math.min(...nodes.map((node) => node.x));
  const y = Math.min(...nodes.map((node) => node.y));
  return { x, y, width: Math.max(...nodes.map((node) => node.x + node.width)) - x,
    height: Math.max(...nodes.map((node) => node.y + node.height)) - y };
}

function connectionGraph(nodes: ConversationGraphNodePlacement[], connections: DocumentConnection[]) {
  const order = new Map(nodes.map((node, index) => [node.conversationId, index]));
  const directed = new Map(nodes.map((node) => [node.conversationId, new Set<string>()]));
  const neighbors = new Map(nodes.map((node) => [node.conversationId, new Set<string>()]));
  for (const { sourceId, targetId } of connections) {
    if (sourceId === targetId || !order.has(sourceId) || !order.has(targetId)) continue;
    directed.get(sourceId)!.add(targetId);
    neighbors.get(sourceId)!.add(targetId);
    neighbors.get(targetId)!.add(sourceId);
  }
  const ordered = (edges: Map<string, Set<string>>) => new Map([...edges].map(([id, targets]) => [id,
    [...targets].sort((a, b) => order.get(a)! - order.get(b)!)]));
  return { directed: ordered(directed), neighbors: ordered(neighbors) };
}

function treeNodes(nodes: ConversationGraphNodePlacement[], directed: Map<string, string[]>, down: boolean) {
  const incoming = new Set([...directed.values()].flat());
  const rootsFirst = [...nodes.filter((node) => !incoming.has(node.conversationId)), ...nodes.filter((node) => incoming.has(node.conversationId))];
  const state = new Map<string, number>(), postorder: string[] = [];
  const forward = new Map(nodes.map((node) => [node.conversationId, [] as string[]]));
  // Remove only DFS back edges. The remaining directed graph has a topological
  // order, so shortcuts/shared children still point forward in either tree.
  for (const root of rootsFirst) {
    if (state.has(root.conversationId)) continue;
    const stack = [{ id: root.conversationId, next: 0 }];
    state.set(root.conversationId, 1);
    while (stack.length) {
      const frame = stack.at(-1)!;
      const target = directed.get(frame.id)![frame.next++];
      if (target === undefined) { state.set(frame.id, 2); postorder.push(frame.id); stack.pop(); continue; }
      if (state.get(target) === 1) continue;
      forward.get(frame.id)!.push(target);
      if (!state.has(target)) { state.set(target, 1); stack.push({ id: target, next: 0 }); }
    }
  }
  const depth = new Map(nodes.map((node) => [node.conversationId, 0]));
  const parent = new Map<string, string>();
  for (const id of [...postorder].reverse()) for (const child of forward.get(id)!) {
    if (depth.get(child)! > depth.get(id)!) continue;
    depth.set(child, depth.get(id)! + 1);
    parent.set(child, id);
  }
  const children = new Map(nodes.map((node) => [node.conversationId, [] as string[]]));
  nodes.forEach((node) => { const id = parent.get(node.conversationId); if (id) children.get(id)!.push(node.conversationId); });
  const span = new Map<string, number>();
  [...nodes].sort((a, b) => depth.get(b.conversationId)! - depth.get(a.conversationId)!).forEach((node) => {
    span.set(node.conversationId, Math.max(1, children.get(node.conversationId)!.reduce((sum, id) => sum + span.get(id)!, 0)));
  });
  const cross = new Map<string, number>();
  let cursor = 0;
  for (const root of nodes.filter((node) => !parent.has(node.conversationId))) {
    const stack = [{ id: root.conversationId, start: cursor }];
    while (stack.length) {
      const { id, start } = stack.pop()!;
      cross.set(id, start + (span.get(id)! - 1) / 2);
      let childStart = start;
      for (const child of children.get(id)!) { stack.push({ id: child, start: childStart }); childStart += span.get(child)!; }
    }
    cursor += span.get(root.conversationId)! + 1;
  }
  return nodes.map((node) => ({ ...node,
    x: down ? cross.get(node.conversationId)! * (CARD.width + GAP) : depth.get(node.conversationId)! * (CARD.width + GAP * 2),
    y: down ? depth.get(node.conversationId)! * (CARD.height + GAP * 2) : cross.get(node.conversationId)! * (CARD.height + GAP) }));
}

function packedTreeNodes(nodes: ConversationGraphNodePlacement[], graph: ReturnType<typeof connectionGraph>, down: boolean,
  availableWidth: number, availableHeight: number) {
  const visited = new Set<string>();
  const components: Array<{ nodes: ConversationGraphNodePlacement[]; bounds: ReturnType<typeof nodeBounds> }> = [];
  for (const node of nodes) {
    if (visited.has(node.conversationId)) continue;
    const members = new Set([node.conversationId]), queue = [node.conversationId];
    visited.add(node.conversationId);
    for (let index = 0; index < queue.length; index++) for (const neighbor of graph.neighbors.get(queue[index])!) {
      if (visited.has(neighbor)) continue;
      visited.add(neighbor); members.add(neighbor); queue.push(neighbor);
    }
    const placed = treeNodes(nodes.filter((candidate) => members.has(candidate.conversationId)), graph.directed, down);
    components.push({ nodes: placed, bounds: nodeBounds(placed) });
  }
  if (components.length === 1) return components[0].nodes;
  // Connected trees keep their own structure. Pack their independent rectangles
  // against a skyline so notes fill the spaces beside taller branch trees.
  components.sort((a, b) => b.bounds.height - a.bounds.height || b.bounds.width - a.bounds.width);
  const widest = Math.max(...components.map(({ bounds }) => bounds.width));
  const area = components.reduce((sum, { bounds }) => sum + (bounds.width + GAP) * (bounds.height + GAP), 0);
  const targetWidth = Math.sqrt(area * availableWidth / availableHeight);
  const candidates = new Set([widest, targetWidth * 0.75, targetWidth, targetWidth * 1.25, availableWidth / MIN_INITIAL_SCALE]
    .map((width) => Math.max(widest, width)));
  let best: { nodes: ConversationGraphNodePlacement[]; scale: number; area: number } | null = null;
  for (const width of candidates) {
    let skyline = [{ x: 0, y: 0, width: width + GAP }];
    const placed: ConversationGraphNodePlacement[] = [];
    for (const component of components) {
      const paddedWidth = component.bounds.width + GAP;
      let position: { x: number; y: number } | null = null;
      for (const segment of skyline) {
        const end = segment.x + paddedWidth;
        if (end > width + GAP) continue;
        const y = Math.max(...skyline.filter((part) => part.x < end && part.x + part.width > segment.x).map((part) => part.y));
        if (!position || y < position.y) position = { x: segment.x, y };
      }
      const { x, y } = position!;
      placed.push(...component.nodes.map((node) => ({ ...node, x: node.x - component.bounds.x + x, y: node.y - component.bounds.y + y })));
      const end = x + paddedWidth;
      skyline = skyline.flatMap((segment) => {
        const right = segment.x + segment.width;
        if (right <= x || segment.x >= end) return [segment];
        return [...(segment.x < x ? [{ ...segment, width: x - segment.x }] : []),
          ...(right > end ? [{ ...segment, x: end, width: right - end }] : [])];
      });
      skyline.push({ x, y: y + component.bounds.height + GAP, width: paddedWidth });
      skyline.sort((a, b) => a.x - b.x);
    }
    const bounds = nodeBounds(placed);
    const scale = Math.min(MAX_INITIAL_SCALE, availableWidth / bounds.width, availableHeight / bounds.height);
    const area = bounds.width * bounds.height;
    if (!best || scale > best.scale || (scale === best.scale && area < best.area)) best = { nodes: placed, scale, area };
  }
  const byId = new Map(best!.nodes.map((node) => [node.conversationId, node]));
  return nodes.map((node) => byId.get(node.conversationId)!);
}

function connectedNodes(nodes: ConversationGraphNodePlacement[], neighbors: Map<string, string[]>, centerNodeId?: string) {
  const hub = nodes.find((node) => node.conversationId === centerNodeId)
    ?? nodes.reduce((best, node) => neighbors.get(node.conversationId)!.length > neighbors.get(best.conversationId)!.length ? node : best);
  const levels: string[][] = [[hub.conversationId]];
  const visited = new Set(levels[0]);
  for (let level = 0; level < levels.length; level++) {
    const next: string[] = [];
    for (const id of levels[level]) for (const neighbor of neighbors.get(id)!) {
      if (visited.has(neighbor)) continue;
      visited.add(neighbor); next.push(neighbor);
    }
    if (next.length) levels.push(next);
  }
  // Disconnected components remain visible/reachable outside the hub's rings.
  const disconnected = nodes.filter((node) => !visited.has(node.conversationId)).map((node) => node.conversationId);
  if (disconnected.length) levels.push(disconnected);
  const positions = new Map([[hub.conversationId, { x: -CARD.width / 2, y: -CARD.height / 2 }]]);
  const clearance = Math.hypot(CARD.width, CARD.height) + GAP;
  let rings = levels.slice(1);
  if (hub.conversationId === centerNodeId) {
    // A focused neighborhood is a compact cluster. Breadth-first order keeps
    // nearby connections first without spending a whole ring on each chain link.
    const ordered = rings.flat();
    rings = [];
    for (let offset = 0, ring = 1; offset < ordered.length; ring++) {
      const capacity = 6 * ring;
      rings.push(ordered.slice(offset, offset + capacity));
      offset += capacity;
    }
  }
  let radius = 0;
  for (const level of rings) {
    radius = Math.max(radius + clearance, level.length > 1 ? clearance / (2 * Math.sin(Math.PI / level.length)) : clearance);
    level.forEach((id, index) => {
      const angle = -Math.PI / 2 + index / level.length * Math.PI * 2;
      positions.set(id, { x: Math.cos(angle) * radius - CARD.width / 2, y: Math.sin(angle) * radius - CARD.height / 2 });
    });
  }
  return { nodes: nodes.map((node) => ({ ...node, ...positions.get(node.conversationId)! })), centerNodeId: hub.conversationId };
}

/** A temporary document view: saved positions are input, never mutated. */
export function layoutDocumentMap(nodes: ConversationGraphNodePlacement[], canvas: { width: number; height: number },
  options: { mode?: DocumentLayoutMode; connections?: DocumentConnection[]; centerNodeId?: string } = {}) {
  const width = Math.max(1, canvas.width);
  const height = Math.max(1, canvas.height);
  const padding = Math.min(24, width / 10, height / 10);
  const bottomPadding = Math.min(64, height / 4);
  const availableWidth = width - padding * 2;
  const availableHeight = height - padding - bottomPadding;
  const authored = nodes.map((node) => ({ ...node, ...CARD,
    x: node.x + (node.width - CARD.width) / 2, y: node.y + (node.height - CARD.height) / 2 }));
  if (!authored.length) return { nodes: authored, viewport: { x: width / 2, y: height / 2, scale: MAX_INITIAL_SCALE }, arranged: false, centerNodeId: null };
  const mode = options.mode ?? "auto";
  if (mode !== "auto") {
    const graph = connectionGraph(authored, options.connections ?? []);
    const layout = mode === "connections" ? connectedNodes(authored, graph.neighbors, options.centerNodeId)
      : { nodes: packedTreeNodes(authored, graph, mode === "tree-down", availableWidth, availableHeight), centerNodeId: null };
    const extent = nodeBounds(layout.nodes);
    const fitWidth = layout.centerNodeId ? Math.max(Math.abs(extent.x), Math.abs(extent.x + extent.width)) * 2 : extent.width;
    const fitHeight = layout.centerNodeId ? Math.max(Math.abs(extent.y), Math.abs(extent.y + extent.height)) * 2 : extent.height;
    // Focused clusters can use the full title-readable range (8px at 40%) to
    // frame their neighbors, before very large subgraphs require panning.
    const minimumScale = options.centerNodeId === layout.centerNodeId ? 0.4 : MIN_INITIAL_SCALE;
    const scale = Math.max(minimumScale, Math.min(MAX_INITIAL_SCALE, availableWidth / fitWidth, availableHeight / fitHeight));
    const viewport: GraphViewport = layout.centerNodeId ? { scale, x: width / 2, y: padding + availableHeight / 2 }
      : { scale, x: padding + Math.max(0, (availableWidth - extent.width * scale) / 2) - extent.x * scale,
        y: padding + Math.max(0, (availableHeight - extent.height * scale) / 2) - extent.y * scale };
    return { ...layout, viewport, arranged: true };
  }
  const authoredBounds = nodeBounds(authored);
  const authoredScale = Math.min(MAX_INITIAL_SCALE, availableWidth / authoredBounds.width, availableHeight / authoredBounds.height);
  const arranged = authoredScale < MIN_INITIAL_SCALE || mapLabelsOverlap(authored, 1, CARD);
  let placements = authored;
  if (arranged) {
    // Keep input branch order, but limit columns so the first frame has readable
    // cards even on a phone. A tall collection remains reachable by panning.
    const idealColumns = Math.ceil(Math.sqrt(nodes.length * availableWidth / availableHeight * (CARD.height + GAP) / (CARD.width + GAP)));
    const fittingColumns = Math.max(1, Math.floor((availableWidth / MIN_INITIAL_SCALE + GAP) / (CARD.width + GAP)));
    const columns = Math.max(1, Math.min(nodes.length, idealColumns, fittingColumns));
    placements = authored.map((node, index) => ({ ...node,
      x: (index % columns) * (CARD.width + GAP), y: Math.floor(index / columns) * (CARD.height + GAP) }));
  }
  const extent = nodeBounds(placements);
  const scale = arranged ? Math.max(MIN_INITIAL_SCALE,
    Math.min(MAX_INITIAL_SCALE, availableWidth / extent.width, availableHeight / extent.height)) : authoredScale;
  const viewport: GraphViewport = { scale,
    x: (width - extent.width * scale) / 2 - extent.x * scale,
    y: padding + Math.max(0, (availableHeight - extent.height * scale) / 2) - extent.y * scale };
  return { nodes: placements, viewport, arranged, centerNodeId: null };
}

/** Cards shrink with the camera; labels stop rendering once below 8px. */
export function getDocumentNodeFootprint(scale: number) {
  const titleFontSize = Math.min(13, 20 * scale);
  const height = CARD.height * scale;
  return { width: CARD.width * scale, height, titleFontSize,
    titleLines: titleFontSize < 8 ? 0 : Math.max(1, Math.min(4, Math.floor((height - titleFontSize * 0.8 - 2) / (titleFontSize * 1.3)))) };
}
