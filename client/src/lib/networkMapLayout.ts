import type { ConversationGraphNodePlacement } from "./conversationGraph";
import { getDocumentNodeFootprint } from "./documentMapLayout";
import type { GraphViewport } from "./graphInteractions";

const CARD = getDocumentNodeFootprint(1);
const PAIRWISE_LIMIT = 256;
const REPULSION_SAMPLES = 24;
const COLLISION_CANDIDATES = 64;
const GAP = 24;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

type Connection = { sourceId: string; targetId: string };
type Point = { x: number; y: number };

function hash(value: string) {
  let result = 2166136261;
  for (let index = 0; index < value.length; index++) result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  result = Math.imul(result ^ (result >>> 16), 0x85ebca6b);
  result = Math.imul(result ^ (result >>> 13), 0xc2b2ae35);
  result ^= result >>> 16;
  return result >>> 0;
}

function fit(nodes: ConversationGraphNodePlacement[], canvas: { width: number; height: number }): GraphViewport {
  const width = Number.isFinite(canvas.width) ? Math.max(1, canvas.width) : 1;
  const height = Number.isFinite(canvas.height) ? Math.max(1, canvas.height) : 1;
  if (!nodes.length) return { x: width / 2, y: height / 2, scale: 0.9 };
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const node of nodes) {
    left = Math.min(left, node.x); top = Math.min(top, node.y);
    right = Math.max(right, node.x + node.width); bottom = Math.max(bottom, node.y + node.height);
  }
  const padding = Math.min(24, width / 10, height / 10);
  const bottomPadding = Math.min(64, height / 4);
  const availableWidth = width - padding * 2, availableHeight = height - padding - bottomPadding;
  const scale = Math.min(0.9, availableWidth / (right - left), availableHeight / (bottom - top));
  return { scale, x: (width - (right - left) * scale) / 2 - left * scale,
    y: padding + (availableHeight - (bottom - top) * scale) / 2 - top * scale };
}

/**
 * A frozen, deterministic force layout. Changing iteration selects a new starting
 * arrangement; viewport changes and saved Canvas positions never move the graph.
 * Pins are top-left coordinates in this layout's 180 × 96 document-card space.
 */
export function layoutNetworkMap(
  nodes: ConversationGraphNodePlacement[],
  canvas: { width: number; height: number },
  connections: Connection[],
  options: { iteration?: number; pinned?: Record<string, Point> } = {},
): { nodes: ConversationGraphNodePlacement[]; viewport: GraphViewport } {
  if (!nodes.length) return { nodes: [], viewport: fit([], canvas) };
  const ordered = [...nodes].sort((a, b) => a.conversationId < b.conversationId ? -1 : a.conversationId > b.conversationId ? 1 : 0);
  const indexes = new Map(ordered.map((node, index) => [node.conversationId, index]));
  const count = ordered.length;
  const iteration = Number.isFinite(options.iteration) ? Math.trunc(options.iteration!) : 0;
  const rotation = hash(`network:${iteration}`) / 0x100000000 * Math.PI * 2;
  const x = new Float64Array(count), y = new Float64Array(count);
  const dx = new Float64Array(count), dy = new Float64Array(count);
  const pinned = new Uint8Array(count);
  let pinX = 0, pinY = 0, pinCount = 0;
  ordered.forEach((node, index) => {
    const pin = options.pinned?.[node.conversationId];
    if (pin && Number.isFinite(pin.x) && Number.isFinite(pin.y)) {
      pinned[index] = 1; x[index] = pin.x + CARD.width / 2; y[index] = pin.y + CARD.height / 2;
      pinX += x[index]; pinY += y[index]; pinCount++;
    }
  });
  const centerX = pinCount ? pinX / pinCount : 0, centerY = pinCount ? pinY / pinCount : 0;
  ordered.forEach((node, index) => {
    if (pinned[index]) return;
    const angle = index * GOLDEN_ANGLE + rotation + hash(node.conversationId) / 0x100000000 * 0.2;
    const radius = count === 1 ? 0 : Math.sqrt(index + 0.5) * 132;
    x[index] = centerX + Math.cos(angle) * radius;
    y[index] = centerY + Math.sin(angle) * radius * CARD.height / CARD.width;
  });
  const pairs = new Set<string>();
  for (const connection of connections) {
    const a = indexes.get(connection.sourceId), b = indexes.get(connection.targetId);
    if (a === undefined || b === undefined || a === b) continue;
    pairs.add(a < b ? `${a}:${b}` : `${b}:${a}`);
  }
  const edges = [...pairs].map((pair) => pair.split(":").map(Number) as [number, number])
    .sort(([a, b], [c, d]) => a - c || b - d);
  // A bounded number of rounds keeps this synchronous layout usable for entire
  // workspaces. Dense graphs also reduce their spring rounds to cap total work.
  const rounds = Math.max(12, Math.min(count > 1000 ? 32 : 64, Math.floor(2_000_000 / Math.max(1, count + edges.length))));

  function repel(a: number, b: number, weight = 1) {
    let vx = x[a] - x[b], vy = y[a] - y[b];
    if (vx === 0 && vy === 0) { vx = a < b ? -1 : 1; vy = (a + b) % 2 ? 1 : -1; }
    const force = Math.min(8, 400 / Math.max(64, vx * vx + vy * vy)) * weight;
    dx[a] += vx * force; dy[a] += vy * force;
    dx[b] -= vx * force; dy[b] -= vy * force;
  }

  function separate(strength: number) {
    const cellWidth = CARD.width + GAP, cellHeight = CARD.height + GAP;
    const cells = new Map<string, number[]>();
    for (let a = 0; a < count; a++) {
      const column = Math.floor(x[a] / cellWidth), row = Math.floor(y[a] / cellHeight);
      let candidates = 0;
      for (let cx = column - 1; cx <= column + 1; cx++) for (let cy = row - 1; cy <= row + 1; cy++) {
        for (const b of cells.get(`${cx}:${cy}`) ?? []) {
          if (candidates++ >= COLLISION_CANDIDATES) break;
          if (pinned[a] && pinned[b]) continue;
          const vx = x[a] - x[b], vy = y[a] - y[b];
          const overlapX = cellWidth - Math.abs(vx), overlapY = cellHeight - Math.abs(vy);
          if (overlapX <= 0 || overlapY <= 0) continue;
          const share = pinned[a] || pinned[b] ? 1 : 0.5;
          const horizontal = overlapX / cellWidth < overlapY / cellHeight;
          const moveX = horizontal ? Math.sign(vx || (a - b)) * overlapX * strength * share : 0;
          const moveY = horizontal ? 0 : Math.sign(vy || (a - b)) * overlapY * strength * share;
          if (!pinned[a]) { x[a] += moveX; y[a] += moveY; }
          if (!pinned[b]) { x[b] -= moveX; y[b] -= moveY; }
        }
      }
      const key = `${Math.floor(x[a] / cellWidth)}:${Math.floor(y[a] / cellHeight)}`;
      const bucket = cells.get(key);
      if (bucket) bucket.push(a); else cells.set(key, [a]);
    }
  }

  for (let round = 0; round < rounds; round++) {
    dx.fill(0); dy.fill(0);
    if (count <= PAIRWISE_LIMIT) {
      for (let a = 0; a < count; a++) for (let b = a + 1; b < count; b++) repel(a, b);
    } else {
      // Deterministic stratified samples approximate far-field repulsion without
      // allocating or visiting all N² node pairs. Local overlap is handled below.
      const stride = (count - 1) / REPULSION_SAMPLES;
      const weight = (count - 1) / (REPULSION_SAMPLES * 2);
      for (let a = 0; a < count; a++) for (let sample = 0; sample < REPULSION_SAMPLES; sample++) {
        const offset = 1 + Math.floor((sample + (round % 7) / 7) * stride);
        repel(a, (a + offset) % count, weight);
      }
    }
    for (const [a, b] of edges) {
      const vx = x[b] - x[a], vy = y[b] - y[a], distance = Math.max(1, Math.hypot(vx, vy));
      const force = (distance - 270) / distance * 0.075;
      dx[a] += vx * force; dy[a] += vy * force;
      dx[b] -= vx * force; dy[b] -= vy * force;
    }
    const temperature = 32 * (1 - round / rounds) + 2;
    for (let index = 0; index < count; index++) {
      if (pinned[index]) continue;
      // Document cards are wider than they are tall. A stronger vertical pull
      // keeps small networks compact and readable instead of filling a circle
      // with whitespace; rectangle collisions still reserve each card's space.
      const vx = dx[index] + (centerX - x[index]) * 0.04, vy = dy[index] + (centerY - y[index]) * 0.12;
      const speed = Math.hypot(vx, vy);
      const step = speed > temperature ? temperature / speed : 1;
      x[index] += vx * step; y[index] += vy * step;
    }
    separate(0.8);
  }
  // Finish without springs pulling cards back into each other. Conflicting pins
  // remain exactly where the user placed them, including overlapping pins.
  for (let round = 0; round < (count <= PAIRWISE_LIMIT ? 160 : 24); round++) separate(1);
  const placed = nodes.map((node) => {
    const index = indexes.get(node.conversationId)!;
    return { ...node, x: pinned[index] ? options.pinned![node.conversationId].x : x[index] - CARD.width / 2,
      y: pinned[index] ? options.pinned![node.conversationId].y : y[index] - CARD.height / 2,
      width: CARD.width, height: CARD.height };
  });
  return { nodes: placed, viewport: fit(placed, canvas) };
}
