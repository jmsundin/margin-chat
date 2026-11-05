import { describe, expect, test } from "bun:test";
import { convexHull, groupHulls } from "../client/src/lib/mapHulls";

describe("map hulls", () => {
  test("the hull keeps only the outer corners, counter-clockwise", () => {
    const hull = convexHull([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 5, y: 5 }, { x: 5, y: 0 }]);
    expect(hull).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]);
  });

  test("each group with three members gets an outline; small groups and ungrouped points get none", () => {
    const points = [
      ...[[0, 0], [100, 0], [50, 80]].map(([x, y]) => ({ x, y, group: 0, hue: 120 })),
      ...[[500, 500], [520, 500]].map(([x, y]) => ({ x, y, group: 1, hue: 200 })),
      { x: 9, y: 9, group: -1, hue: null },
    ];
    const hulls = groupHulls(points);
    expect(hulls.map((hull) => hull.group)).toEqual([0]);
    expect(hulls[0].hue).toBe(120);
    expect(hulls[0].path).toBe("M0 0L100 0L50 80Z");
  });

  test("a stray member far from its group is left outside the outline", () => {
    const core = Array.from({ length: 19 }, (_, at) => ({ x: Math.cos(at) * 50, y: Math.sin(at) * 50, group: 2, hue: 10 }));
    const hull = groupHulls([...core, { x: 5000, y: 5000, group: 2, hue: 10 }])[0];
    expect(Math.max(...hull.points.map((point) => point.x))).toBeLessThanOrEqual(50);
  });
});
