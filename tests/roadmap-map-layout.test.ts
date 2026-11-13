import { describe, expect, test } from "bun:test";
import { layoutRoadmapMap, mapEdgePath, mapStepKey, mapSubKey, MAP_STAGE_WIDTH, type MapLayoutRoadmap } from "../client/src/lib/roadmapMapLayout";

const roadmap = (id: string, stages: [string, string[]][], subs: Record<string, MapLayoutRoadmap> = {}): MapLayoutRoadmap => ({
  id, stages: stages.map(([stageId, nodeIds]) => ({ id: stageId, title: stageId, nodeIds })), sub: (nodeId) => subs[nodeId] ?? null,
});

describe("roadmap map layout", () => {
  test("stages run left to right and wrap to a new row when too wide", () => {
    const { items } = layoutRoadmapMap(roadmap("r", [["a", ["1", "2"]], ["b", ["3"]], ["c", ["4"]]]), MAP_STAGE_WIDTH * 2 + 64);
    const stage = (id: string) => items.find((item) => item.key === `stage:r/${id}`)!;
    expect(stage("a").y).toBe(0);
    expect(stage("b").y).toBe(0);
    expect(stage("b").x).toBeGreaterThan(stage("a").x + stage("a").w);
    expect(stage("c").x).toBe(0);
    expect(stage("c").y).toBeGreaterThan(stage("a").y + stage("a").h);
  });

  test("an open sub-roadmap sits beside its step and pushes later stages aside", () => {
    const closed = layoutRoadmapMap(roadmap("r", [["a", ["1", "2"]], ["b", ["3"]]]), 5000).items;
    const sub = roadmap("s", [["x", ["9", "10"]], ["y", ["11"]]]);
    const opened = layoutRoadmapMap(roadmap("r", [["a", ["1", "2"]], ["b", ["3"]]], { "2": sub }), 5000).items;
    const find = (items: typeof opened, key: string) => items.find((item) => item.key === key)!;
    const step = find(opened, mapStepKey("r", "2")), box = find(opened, mapSubKey("r", "2"));
    expect(box.kind).toBe("sub");
    expect(box.roadmapId).toBe("s");
    expect(box.x).toBeGreaterThan(step.x + step.w);
    expect(box.y).toBeLessThanOrEqual(step.y);
    expect(find(opened, mapStepKey("s", "9")).x).toBeGreaterThan(box.x);
    expect(find(opened, "stage:r/b").x).toBeGreaterThan(box.x + box.w);
    expect(find(opened, "stage:r/b").x).toBeGreaterThan(find(closed, "stage:r/b").x);
    expect(find(opened, mapStepKey("s", "11")).depth).toBe(1);
  });

  test("sub-roadmaps nest inside sub-roadmaps", () => {
    const inner = roadmap("t", [["z", ["20"]]]);
    const sub = roadmap("s", [["x", ["9"]]], { "9": inner });
    const { items } = layoutRoadmapMap(roadmap("r", [["a", ["1"]]], { "1": sub }), 5000);
    const outer = items.find((item) => item.key === mapSubKey("r", "1"))!, nested = items.find((item) => item.key === mapSubKey("s", "9"))!;
    expect(nested.depth).toBe(2);
    expect(nested.x).toBeGreaterThan(outer.x);
    expect(nested.x + nested.w).toBeLessThanOrEqual(outer.x + outer.w);
    expect(nested.y + nested.h).toBeLessThanOrEqual(outer.y + outer.h);
  });

  test("lines between neighbours in a stage are short and straight", () => {
    const a = { x: 0, y: 0, w: 100, h: 30 }, b = { x: 0, y: 40, w: 100, h: 30 };
    expect(mapEdgePath(a, b, true, true)).toBe("M50,30L50,40");
    expect(mapEdgePath(a, { x: 300, y: 0, w: 100, h: 30 }, false, false)).toStartWith("M100,15C");
  });
});
