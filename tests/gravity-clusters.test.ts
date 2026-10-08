import { describe, expect, test } from "bun:test";
import { findGravityClusters, layoutGravityClusters, UNLINKED_CLUSTER_ID } from "../client/src/lib/gravityClusters";

const link = (sourceId: string, targetId: string) => ({ sourceId, targetId });
const node = (conversationId: string) => ({ conversationId, depth: 0, x: 0, y: 0, width: 180, height: 96 });

function star(hub: string, leaves: string[]) {
  return leaves.map((leaf) => link(hub, leaf));
}

describe("gravity clusters", () => {
  test("gathers each hub's exclusive neighbors and keeps linked hubs apart", () => {
    const connections = [
      ...star("a", ["a1", "a2", "a3", "a4"]),
      ...star("b", ["b1", "b2", "b3"]),
      link("a", "b"),
      link("c1", "c2"),
    ];
    const ids = ["a", "a1", "a2", "a3", "a4", "b", "b1", "b2", "b3", "c1", "c2", "lonely"];
    const { clusters } = findGravityClusters(ids, connections);
    expect(clusters.map((cluster) => cluster.memberIds)).toEqual([
      ["a", "a1", "a2", "a3", "a4"],
      ["b", "b1", "b2", "b3"],
      ["c1", "c2"],
      ["lonely"],
    ]);
    expect(clusters.at(-1)!.hubId).toBeNull();
  });

  test("a document between two hubs joins the more connected one", () => {
    const connections = [...star("a", ["a1", "a2", "a3", "x"]), ...star("b", ["b1", "b2", "x"])];
    const { clusters } = findGravityClusters(["a", "a1", "a2", "a3", "b", "b1", "b2", "x"], connections);
    expect(clusters.find((cluster) => cluster.hubId === "a")!.memberIds).toContain("x");
  });

  test("members sit closer to each other than to another cluster, without overlapping", () => {
    const connections = [...star("a", ["a1", "a2", "a3", "a4", "a5"]), ...star("b", ["b1", "b2", "b3", "b4"]), link("a", "b")];
    const ids = ["a", "a1", "a2", "a3", "a4", "a5", "b", "b1", "b2", "b3", "b4", "u1", "u2"];
    const layout = layoutGravityClusters(ids.map(node), { width: 1200, height: 800 }, connections);
    const center = new Map(layout.nodes.map((placed) => [placed.conversationId, { x: placed.x + 90, y: placed.y + 48 }]));
    const distance = (p: string, q: string) => Math.hypot(center.get(p)!.x - center.get(q)!.x, center.get(p)!.y - center.get(q)!.y);
    const aMembers = ["a", "a1", "a2", "a3", "a4", "a5"], bMembers = ["b", "b1", "b2", "b3", "b4"];
    let farthestInside = 0, nearestAcross = Infinity;
    for (const p of aMembers) for (const q of aMembers) if (p !== q) farthestInside = Math.max(farthestInside, distance(p, q));
    for (const p of aMembers) for (const q of bMembers) nearestAcross = Math.min(nearestAcross, distance(p, q));
    expect(nearestAcross).toBeGreaterThan(200);
    expect(layout.clusterByDocumentId.get("u1")).toBe(UNLINKED_CLUSTER_ID);
    for (const p of layout.nodes) for (const q of layout.nodes) {
      if (p === q) continue;
      const overlap = Math.abs(p.x - q.x) < p.width && Math.abs(p.y - q.y) < p.height;
      expect(overlap).toBe(false);
    }
    expect(farthestInside).toBeLessThan(800);
  });

  test("stays fast and deterministic for large vaults", () => {
    const ids = Array.from({ length: 20_000 }, (_, index) => `d${index}`);
    const connections = ids.slice(1).map((id, index) => link(id, `d${Math.floor(index / 8) * 9 % 20_000}`));
    const started = performance.now();
    const first = layoutGravityClusters(ids.map(node), { width: 1200, height: 800 }, connections);
    expect(performance.now() - started).toBeLessThan(3000);
    const second = layoutGravityClusters(ids.map(node), { width: 1200, height: 800 }, connections);
    expect(second.nodes.slice(0, 50)).toEqual(first.nodes.slice(0, 50));
    expect(first.clusters.length).toBeGreaterThan(10);
  });
});
