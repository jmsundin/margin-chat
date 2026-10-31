import { describe, expect, test } from "bun:test";
import { buildLandscapeScene, landscapeRegionHue } from "../client/src/lib/landscapeScene";

describe("landscape scene", () => {
  const positions = [
    { id: "a", x: 0, y: 0, region: 0 }, { id: "b", x: 100, y: 0, region: 0 }, { id: "c", x: 50, y: 10, region: 0 },
    { id: "d", x: 2000, y: 2000, region: 1 }, { id: "lone", x: 900, y: 900, region: -1 }, { id: "gone", x: 5, y: 5, region: 0 },
  ];

  test("centres a card on each point and leaves out documents no longer shown", () => {
    const scene = buildLandscapeScene(["a", "b", "c", "d", "lone"], positions);
    const a = scene.nodes.find((node) => node.conversationId === "a")!;
    expect(a.x + a.width / 2).toBe(0);
    expect(a.y + a.height / 2).toBe(0);
    expect(scene.nodes.some((node) => node.conversationId === "gone")).toBe(false);
  });

  test("regions know their middle, and the member nearest it names them", () => {
    const scene = buildLandscapeScene(["a", "b", "c", "d", "lone"], positions);
    expect(scene.regions.map((region) => region.index)).toEqual([0, 1]);
    expect(scene.regions[0].hubId).toBe("c");
    expect(scene.regions[0].memberIds.sort()).toEqual(["a", "b", "c"]);
    expect(scene.regions[0].center.x).toBeCloseTo(50, 6);
    expect(scene.regionOf.has("lone")).toBe(false);
  });

  test("documents without a place sit in a row below everything else", () => {
    const scene = buildLandscapeScene(["a", "d", "new-1", "new-2"], positions);
    expect(scene.unplacedIds).toEqual(["new-1", "new-2"]);
    const lowest = Math.max(...scene.nodes.filter((node) => !scene.unplacedIds.includes(node.conversationId)).map((node) => node.y + node.height));
    for (const id of scene.unplacedIds) expect(scene.nodes.find((node) => node.conversationId === id)!.y).toBeGreaterThan(lowest);
  });

  test("region hues differ from one region to the next", () => {
    expect(landscapeRegionHue(-1)).toBeNull();
    expect(landscapeRegionHue(0)).not.toBe(landscapeRegionHue(1));
  });
});
