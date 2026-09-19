import type { ConversationGraphNodePlacement } from "./conversationGraph";
import { GRAPH_REFLOW_GAP_X, GRAPH_REFLOW_GAP_Y, hasGraphNodeSpacing } from "./graphAutoLayout";

const CELL_SIZE = 512;
const MAX_CELLS_PER_RECT = 256;
const SEPARATION_EPSILON = 0.5;

interface CellRange { left: number; right: number; top: number; bottom: number }

function validPlacement(node: ConversationGraphNodePlacement) {
  return [node.x, node.y, node.width, node.height, node.x + node.width, node.y + node.height].every(Number.isFinite)
    && node.width >= 0 && node.height >= 0;
}

function cellRange(node: ConversationGraphNodePlacement, gapX = 0, gapY = 0): CellRange | null {
  const range = {
    left: Math.floor((node.x - gapX) / CELL_SIZE), right: Math.floor((node.x + node.width + gapX) / CELL_SIZE),
    top: Math.floor((node.y - gapY) / CELL_SIZE), bottom: Math.floor((node.y + node.height + gapY) / CELL_SIZE),
  };
  if (!Object.values(range).every(Number.isSafeInteger) ||
    (range.right - range.left + 1) * (range.bottom - range.top + 1) > MAX_CELLS_PER_RECT) return null;
  return range;
}

/** A mutable index belongs only to this derivation; authored placements are never changed. */
function createPlacementIndex(nodes: ConversationGraphNodePlacement[]) {
  const cells = new Map<string, Set<number>>();
  const keysByIndex = new Map<number, string[]>();
  const oversized = new Set<number>();
  const validIndices = nodes.flatMap((node, index) => validPlacement(node) ? [index] : []);
  const update = (index: number) => {
    for (const key of keysByIndex.get(index) ?? []) {
      const cell = cells.get(key);
      cell?.delete(index);
      if (!cell?.size) cells.delete(key);
    }
    oversized.delete(index);
    const range = cellRange(nodes[index]);
    if (!range) {
      keysByIndex.delete(index);
      oversized.add(index);
      return;
    }
    const keys: string[] = [];
    for (let x = range.left; x <= range.right; x += 1) {
      for (let y = range.top; y <= range.bottom; y += 1) {
        const key = `${x}:${y}`;
        const cell = cells.get(key) ?? new Set<number>();
        cell.add(index);
        cells.set(key, cell);
        keys.push(key);
      }
    }
    keysByIndex.set(index, keys);
  };
  for (const index of validIndices) update(index);
  return {
    update,
    query(node: ConversationGraphNodePlacement, gapX: number, gapY: number) {
      const range = cellRange(node, gapX, gapY);
      // A very large reader must inspect all nearby content, without walking billions of empty cells.
      if (!range) return validIndices;
      const result = new Set(oversized);
      for (let x = range.left; x <= range.right; x += 1) {
        for (let y = range.top; y <= range.bottom; y += 1) {
          for (const index of cells.get(`${x}:${y}`) ?? []) result.add(index);
        }
      }
      return [...result];
    },
  };
}

export interface GraphFocusLayoutWork {
  pairChecks: number;
  movedNodes: number;
}

/**
 * Make temporary room for an expanded selection without moving its top-left anchor.
 * Only collisions reached from that selection activate nodes. A stable distance order
 * settles nearer nodes first; every move travels monotonically away from the anchor,
 * so escaping a blocking rectangle cannot oscillate back into it.
 */
export function resolveGraphFocusLayout(args: {
  placements: ConversationGraphNodePlacement[];
  selectedConversationId: string;
  gapX?: number;
  gapY?: number;
  work?: GraphFocusLayoutWork;
}): ConversationGraphNodePlacement[] {
  if (args.work) { args.work.pairChecks = 0; args.work.movedNodes = 0; }
  const nodes = args.placements.map((placement) => ({ ...placement }));
  const anchorIndex = nodes.findIndex((node) => node.conversationId === args.selectedConversationId);
  if (anchorIndex < 0 || !validPlacement(nodes[anchorIndex])) return nodes;
  const anchor = nodes[anchorIndex];
  const anchorCenter = { x: anchor.x + anchor.width / 2, y: anchor.y + anchor.height / 2 };
  const gapX = args.gapX !== undefined && Number.isFinite(args.gapX) ? Math.max(0, args.gapX) : GRAPH_REFLOW_GAP_X;
  const gapY = args.gapY !== undefined && Number.isFinite(args.gapY) ? Math.max(0, args.gapY) : GRAPH_REFLOW_GAP_Y;
  const geometry = nodes.map((node) => {
    const deltaX = node.x + node.width / 2 - anchorCenter.x;
    const deltaY = node.y + node.height / 2 - anchorCenter.y;
    return { distance: Math.hypot(deltaX, deltaY), signX: deltaX < 0 ? -1 : 1, signY: deltaY < 0 ? -1 : 1 };
  });
  const orderedIndices = nodes.flatMap((node, index) => validPlacement(node) ? [index] : []).sort((left, right) => {
    if (left === right) return 0;
    if (left === anchorIndex) return -1;
    if (right === anchorIndex) return 1;
    const distance = geometry[left].distance - geometry[right].distance;
    if (distance) return distance;
    const leftId = nodes[left].conversationId, rightId = nodes[right].conversationId;
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
  const rank = new Map(orderedIndices.map((index, position) => [index, position]));
  const spatial = createPlacementIndex(nodes);
  const activated = new Set([anchorIndex]);
  const overlaps = (leftIndex: number, rightIndex: number) => {
    if (args.work) args.work.pairChecks += 1;
    return !hasGraphNodeSpacing(nodes[leftIndex], nodes[rightIndex], gapX, gapY);
  };

  for (const currentIndex of orderedIndices) {
    if (!activated.has(currentIndex)) continue;
    const current = nodes[currentIndex];
    const currentRank = rank.get(currentIndex)!;
    let moved = false;
    if (currentIndex !== anchorIndex) {
      // Later nodes cannot move earlier nodes, including earlier nodes that were never activated.
      while (true) {
        const blockerIndex = spatial.query(current, gapX, gapY)
          .filter((index) => rank.get(index)! < currentRank)
          .sort((left, right) => rank.get(left)! - rank.get(right)!)
          .find((index) => overlaps(currentIndex, index));
        if (blockerIndex === undefined) break;
        const blocker = nodes[blockerIndex];
        const x = geometry[currentIndex].signX > 0
          ? blocker.x + blocker.width + gapX + SEPARATION_EPSILON
          : blocker.x - current.width - gapX - SEPARATION_EPSILON;
        const y = geometry[currentIndex].signY > 0
          ? blocker.y + blocker.height + gapY + SEPARATION_EPSILON
          : blocker.y - current.height - gapY - SEPARATION_EPSILON;
        // Full edge-to-edge translation also resolves a small card entirely inside the reader.
        if (Math.abs(x - current.x) < Math.abs(y - current.y)) current.x = x;
        else current.y = y;
        moved = true;
        spatial.update(currentIndex);
      }
    }
    if (moved && args.work) args.work.movedNodes += 1;
    for (const otherIndex of spatial.query(current, gapX, gapY)) {
      if (rank.get(otherIndex)! > currentRank && overlaps(currentIndex, otherIndex)) activated.add(otherIndex);
    }
  }
  return nodes;
}
