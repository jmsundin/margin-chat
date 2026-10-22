import { describe, expect, test } from "bun:test";
import { fitMapDotTitles, mapDotDiameter, type MapDotTitle } from "../client/src/lib/mapDotNodes";

const node = (id: string, x: number, y: number, titleWidth: number, priority = 0): MapDotTitle =>
  ({ id, x, y, radius: 10, gap: 5, titleWidth, titleHeight: 17, priority });

describe("map dot nodes", () => {
  test("the most connected document draws the largest circle", () => {
    expect(mapDotDiameter(0, 10)).toBe(14);
    expect(mapDotDiameter(10, 10)).toBe(36);
    expect(mapDotDiameter(3, 10)).toBeGreaterThan(14);
    expect(mapDotDiameter(3, 10)).toBeLessThan(mapDotDiameter(6, 10));
    expect(mapDotDiameter(5, 0)).toBe(14);
  });

  test("a title with room keeps its full width", () => {
    expect(fitMapDotTitles([node("a", 0, 0, 120), node("b", 400, 0, 120)]).size).toBe(0);
  });

  test("titles side by side are cut so they never overlap, and the busier document keeps more", () => {
    const widths = fitMapDotTitles([node("busy", 0, 0, 200, 5), node("quiet", 160, 0, 200, 1)]);
    expect(widths.has("busy")).toBe(false);
    // the quiet title starts after the busy one ends (100) plus the margin
    const quiet = widths.get("quiet")!;
    expect(160 - quiet / 2).toBeGreaterThanOrEqual(100 + 6);
  });

  test("a title stops before a neighbor's circle", () => {
    // neighbor circle sits in the title's row, 90px to the right
    const widths = fitMapDotTitles([node("a", 0, 0, 300, 2), { ...node("b", 90, 26, 40, 1) }]);
    expect(widths.get("a")).toBe(2 * (90 - 10 - 6));
  });

  test("titles on different rows do not limit each other", () => {
    expect(fitMapDotTitles([node("a", 0, 0, 300), node("b", 50, 200, 300)]).size).toBe(0);
  });

  test("open cards count as neighbors, and a title without room for a few letters hides", () => {
    expect(fitMapDotTitles([node("a", 0, 0, 300)], [{ x0: 40, y0: 10, x1: 200, y1: 60 }]).get("a")).toBe(2 * (40 - 6));
    expect(fitMapDotTitles([node("a", 0, 0, 300)], [{ x0: 12, y0: 10, x1: 200, y1: 60 }]).get("a")).toBe(0);
  });

  test("a circle right below a title hides it rather than drawing over it", () => {
    const widths = fitMapDotTitles([node("top", 0, 0, 120, 2), node("below", 0, 30, 120, 1)]);
    expect(widths.get("top")).toBe(0);
    expect(widths.has("below")).toBe(false);
  });

  test("a short title that fits is never hidden", () => {
    expect(fitMapDotTitles([node("a", 0, 0, 30), node("b", 50, 26, 30)]).size).toBe(0);
  });
});
