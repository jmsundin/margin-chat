import { describe, expect, test } from "bun:test";
import type { ConversationGraphNodePlacement } from "../client/src/lib/conversationGraph";
import { buildGraphDragPreviewIndex, GRAPH_PREVIEW_LIMITS, resolveGraphDragPreview } from "../client/src/lib/graphDragPreview";
import { hasGraphNodeSpacing, resolveGraphSelectionReflow } from "../client/src/lib/graphAutoLayout";
import type { GraphNodeMove } from "../client/src/lib/graphInteractions";

const placement = (conversationId: string, x: number, y: number): ConversationGraphNodePlacement => ({ conversationId, x, y, width: 200, height: 96, depth: 0 });
const move: GraphNodeMove = { conversationId: "anchor", conversationIds: ["anchor"], deltaX: 220, deltaY: 0 };
function preview(placements: ConversationGraphNodePlacement[], nextMove = move) {
  return resolveGraphDragPreview({
    move: nextMove,
    ...buildGraphDragPreviewIndex(placements),
  });
}

describe("bounded graph drag previews", () => {
  test("local preview work is unchanged by ten thousand distant nodes", () => {
    const local = [placement("anchor", 0, 0), placement("neighbor", 250, 0)];
    const nearby = preview(local);
    const large = preview([...local, ...Array.from({ length: 10_000 }, (_, index) => placement(`far-${index}`, 10_000 + index * 800, 10_000))]);
    expect(large.work).toEqual(nearby.work);
    expect(large.placements).toEqual(nearby.placements);
    expect(large.placements.size).toBe(2);
    expect(hasGraphNodeSpacing(large.placements.get("anchor")!, large.placements.get("neighbor")!)).toBe(true);
    expect(local[0]).toMatchObject({ x: 0, y: 0 });
    expect(local[1]).toMatchObject({ x: 250, y: 0 });
  });

  test("dense scenes have deterministic work limits and preserve every selected position", () => {
    const nodes = Array.from({ length: 10_000 }, (_, index) => placement(`node-${index}`, index % 3, index % 5));
    const selected = ["node-0", "node-9999"];
    const result = preview(nodes, { conversationId: selected[0], conversationIds: selected, deltaX: 10, deltaY: 20 });
    expect(result.work.indexEntries).toBeLessThanOrEqual(GRAPH_PREVIEW_LIMITS.indexEntries);
    expect(result.work.indexCells).toBeLessThanOrEqual(GRAPH_PREVIEW_LIMITS.indexCells);
    expect(result.work.candidateNodes).toBeLessThanOrEqual(GRAPH_PREVIEW_LIMITS.candidateNodes);
    expect(result.work.pairChecks).toBeLessThanOrEqual(GRAPH_PREVIEW_LIMITS.pairChecks);
    expect(result.work.iterations).toBeLessThanOrEqual(GRAPH_PREVIEW_LIMITS.iterations);
    expect(result.placements.size).toBeLessThanOrEqual(selected.length + GRAPH_PREVIEW_LIMITS.candidateNodes);
    for (const id of selected) {
      const original = nodes.find((node) => node.conversationId === id)!;
      expect(result.placements.get(id)).toMatchObject({ x: original.x + 10, y: original.y + 20 });
    }
  });

  test("widely separated multi-selection members keep their relative positions", () => {
    const nodes = [placement("one", -10_000, -5_000), placement("two", 10_000, 5_000), placement("near-one", -9_800, -5_000)];
    const result = preview(nodes, { conversationId: "one", conversationIds: ["one", "two"], deltaX: 250, deltaY: 40 });
    expect(result.placements.get("one")).toMatchObject({ x: -9_750, y: -4_960 });
    expect(result.placements.get("two")).toMatchObject({ x: 10_250, y: 5_040 });
    expect(hasGraphNodeSpacing(result.placements.get("one")!, result.placements.get("near-one")!)).toBe(true);
  });

  test("committed reflow still settles collisions outside the bounded preview", () => {
    const nodes = [placement("anchor", 0, 0), placement("neighbor", 250, 0), placement("far-a", 10_000, 10_000), placement("far-b", 10_010, 10_010)];
    const result = preview(nodes);
    expect(result.placements.has("far-a")).toBe(false);
    const committed = resolveGraphSelectionReflow({ placements: nodes, conversationIds: move.conversationIds, deltaX: move.deltaX, deltaY: move.deltaY });
    expect(committed[0]).toMatchObject({ x: 220, y: 0 });
    for (let left = 0; left < committed.length; left += 1) {
      for (let right = left + 1; right < committed.length; right += 1) {
        expect(hasGraphNodeSpacing(committed[left], committed[right])).toBe(true);
      }
    }
  });

  test("preview uses committed tie-breaking when a moved node exactly covers a neighbor", () => {
    const nodes = [placement("neighbor", 220, 0), placement("anchor", 0, 0)];
    const result = preview(nodes);
    const committed = resolveGraphSelectionReflow({ placements: nodes, conversationIds: move.conversationIds, deltaX: move.deltaX, deltaY: move.deltaY });
    expect(result.placements.get("neighbor")).toEqual(committed[0]);
    expect(result.placements.get("anchor")).toEqual(committed[1]);
  });
});
