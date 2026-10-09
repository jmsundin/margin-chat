import { describe, expect, test } from "bun:test";
import { CLUSTER_GROUPING_THRESHOLD, findGravityClusters, formatClusterPeriod, layoutGravityClusters, UNLINKED_CLUSTER_ID } from "../client/src/lib/gravityClusters";
import { clusterDisplayLevel, labelClusterGroups } from "../client/src/components/GraphClusterLayer";
import { buildSyntheticVault } from "./helpers/syntheticVault";

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

  test("small maps keep one level of clusters and one unlinked island", () => {
    const connections = [...star("a", ["a1", "a2", "a3"]), link("b", "b1")];
    const ids = ["a", "a1", "a2", "a3", "b", "b1", ...Array.from({ length: 60 }, (_, index) => `u${index}`)];
    const layout = layoutGravityClusters(ids.map(node), { width: 1200, height: 800 }, connections, { createdAt: () => 0 });
    expect(layout.levels).toEqual([]);
    expect(layout.clusters.filter((cluster) => cluster.hubId === null).map((cluster) => cluster.id)).toEqual([UNLINKED_CLUSTER_ID]);
  });

  describe("large vaults", () => {
    const vault = buildSyntheticVault(6_000);
    const layout = layoutGravityClusters(vault.ids.map(node), { width: 1400, height: 900 }, vault.connections,
      { createdAt: (id) => vault.createdAt.get(id) });
    const circles = new Map<string, { center: { x: number; y: number }; radius: number }>([
      ...layout.clusters.map((cluster) => [cluster.id, cluster] as const),
      ...layout.levels.flatMap((level) => level.groups.map((group) => [group.id, group] as const)),
    ]);

    test("group clusters into regions until about a dozen remain", () => {
      expect(layout.clusters.length).toBeGreaterThan(CLUSTER_GROUPING_THRESHOLD);
      expect(layout.levels.length).toBeGreaterThanOrEqual(2);
      layout.levels.forEach((level, index) => {
        expect(level.level).toBe(index + 1);
        const below = index === 0 ? layout.clusters.length : layout.levels[index - 1].groups.length;
        expect(level.groups.length).toBeLessThan(below);
        // Every member of the level below belongs to exactly one group.
        expect(level.groups.flatMap((group) => group.childIds).sort())
          .toEqual((index === 0 ? layout.clusters : layout.levels[index - 1].groups).map((item) => item.id).sort());
      });
      expect(layout.levels.at(-1)!.groups.length).toBeLessThanOrEqual(30);
    });

    test("each group's circle holds its members, and siblings never overlap", () => {
      for (const level of layout.levels) for (const group of level.groups) {
        const children = group.childIds.map((id) => circles.get(id)!);
        for (const child of children) {
          expect(Math.hypot(child.center.x - group.center.x, child.center.y - group.center.y) + child.radius).toBeLessThanOrEqual(group.radius + 1);
        }
        for (let i = 0; i < children.length; i++) for (let j = i + 1; j < children.length; j++) {
          const a = children[i], b = children[j];
          expect(Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y)).toBeGreaterThanOrEqual(a.radius + b.radius - 1);
        }
      }
      const top = layout.levels.at(-1)!.groups;
      for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++) {
        expect(Math.hypot(top[i].center.x - top[j].center.x, top[i].center.y - top[j].center.y)).toBeGreaterThanOrEqual(top[i].radius + top[j].radius - 1);
      }
    });

    test("unlinked documents are split into date runs instead of one giant island", () => {
      const runs = layout.clusters.filter((cluster) => cluster.hubId === null);
      expect(runs.length).toBeGreaterThan(10);
      for (const run of runs) {
        expect(run.memberIds.length).toBeLessThanOrEqual(80);
        expect(run.period!.start).toBeLessThanOrEqual(run.period!.end);
      }
    });

    test("zooming out swaps clusters for larger groups, and labels fall back to names inside", () => {
      expect(clusterDisplayLevel(layout.clusters, layout.levels, 1)).toBe(0);
      expect(clusterDisplayLevel(layout.clusters, layout.levels, 0.0001)).toBe(layout.levels.at(-1)!.level);
      const levelsSeen = new Set([1, 0.1, 0.03, 0.01, 0.003, 0.001].map((scale) => clusterDisplayLevel(layout.clusters, layout.levels, scale)));
      expect(levelsSeen.size).toBeGreaterThanOrEqual(3);
      const labels = labelClusterGroups(Object.fromEntries(layout.clusters.map((cluster) => [cluster.id, { label: `Topic ${cluster.id}`, generated: false }])),
        layout.clusters, layout.levels);
      for (const level of layout.levels) for (const group of level.groups) expect(labels[group.id]?.label).toBeTruthy();
      const run = layout.clusters.find((cluster) => cluster.period)!;
      expect(labels[run.id].label).toBe(`Unlinked · ${formatClusterPeriod(run.period!)}`);
    });

    test("is deterministic", () => {
      const again = layoutGravityClusters(vault.ids.map(node), { width: 1400, height: 900 }, vault.connections,
        { createdAt: (id) => vault.createdAt.get(id) });
      expect(again.nodes.slice(0, 200)).toEqual(layout.nodes.slice(0, 200));
      expect(again.levels.map((level) => level.groups.map((group) => group.center))).toEqual(layout.levels.map((level) => level.groups.map((group) => group.center)));
    });
  });

  test("lays out 50,000 documents within the performance budget", () => {
    const vault = buildSyntheticVault(50_000);
    const started = performance.now();
    const layout = layoutGravityClusters(vault.ids.map(node), { width: 1400, height: 900 }, vault.connections,
      { createdAt: (id) => vault.createdAt.get(id) });
    expect(performance.now() - started).toBeLessThan(6000);
    expect(layout.levels.length).toBeGreaterThanOrEqual(3);
  });
});

