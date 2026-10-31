import { describe, expect, test } from "bun:test";
import { layoutDocumentMap } from "../client/src/lib/documentMapLayout";
import { focusMeaningRing } from "../client/src/lib/focusMeaningRing";

const docs = Object.fromEntries(["focus", "linked", "a", "b", "c", "far"].map((id) => [id, { id }]));

describe("Focus ring by meaning", () => {
  test("keeps the closest documents the links do not already show", () => {
    const ring = focusMeaningRing("focus", [
      { id: "b", similarity: 0.6 }, { id: "linked", similarity: 0.9 }, { id: "a", similarity: 0.8 },
      { id: "far", similarity: 0.1 }, { id: "gone", similarity: 0.95 }, { id: "focus", similarity: 1 },
    ], new Set(["focus", "linked"]), docs);
    expect(ring.map((item) => item.id)).toEqual(["a", "b"]);
  });

  test("is empty without neighbours from the server", () => {
    expect(focusMeaningRing("focus", undefined, new Set(), docs)).toEqual([]);
  });

  test("the meaning ring sits outside every linked document", () => {
    const card = (id: string) => ({ conversationId: id, x: 0, y: 0, width: 180, height: 96, depth: 0 });
    const ids = ["focus", "l1", "l2", "l3", "m1", "m2"];
    const result = layoutDocumentMap(ids.map(card), { width: 1200, height: 800 }, {
      mode: "connections", centerNodeId: "focus", outerRingIds: ["m1", "m2"],
      connections: [{ sourceId: "focus", targetId: "l1" }, { sourceId: "focus", targetId: "l2" }, { sourceId: "l2", targetId: "l3" }],
    });
    const distance = (id: string) => { const placed = result.nodes.find((node) => node.conversationId === id)!; return Math.hypot(placed.x + 90, placed.y + 48); };
    expect(distance("focus")).toBe(0);
    const linked = Math.max(distance("l1"), distance("l2"), distance("l3"));
    expect(Math.min(distance("m1"), distance("m2"))).toBeGreaterThan(linked);
  });
});
