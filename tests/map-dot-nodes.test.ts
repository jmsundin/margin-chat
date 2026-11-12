import { describe, expect, test } from "bun:test";
import { fitMapDotTitles, mapDotDiameter, mapDotTitleLines, type MapDotTitle } from "../client/src/lib/mapDotNodes";

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
    const quiet = widths.get("quiet")!.width;
    expect(160 - quiet / 2).toBeGreaterThanOrEqual(100 + 6);
  });

  test("a title stops before a neighbor's circle", () => {
    // neighbor circle sits in the title's row, 90px to the right
    const widths = fitMapDotTitles([node("a", 0, 0, 300, 2), { ...node("b", 90, 26, 40, 1) }]);
    expect(widths.get("a")?.width).toBe(2 * (90 - 10 - 6));
  });

  test("titles on different rows do not limit each other", () => {
    expect(fitMapDotTitles([node("a", 0, 0, 300), node("b", 50, 200, 300)]).size).toBe(0);
  });

  test("open cards count as neighbors, and a title without room for a few letters hides", () => {
    expect(fitMapDotTitles([node("a", 0, 0, 300)], [{ x0: 40, y0: 10, x1: 200, y1: 60 }]).get("a")?.width).toBe(2 * (40 - 6));
    expect(fitMapDotTitles([node("a", 0, 0, 300)], [{ x0: 12, y0: 10, x1: 200, y1: 60 }]).get("a")?.width).toBe(0);
  });

  test("a circle right below a title hides it rather than drawing over it", () => {
    const widths = fitMapDotTitles([node("top", 0, 0, 120, 2), node("below", 0, 30, 120, 1)]);
    expect(widths.get("top")?.width).toBe(0);
    expect(widths.has("below")).toBe(false);
  });

  test("a short title that fits is never hidden", () => {
    expect(fitMapDotTitles([node("a", 0, 0, 30), node("b", 50, 26, 30)]).size).toBe(0);
  });
  test("the selected or hovered title goes first and is never cut, even beside a busier neighbor", () => {
    const widths = fitMapDotTitles([node("busy", 0, 0, 200, 5), { ...node("picked", 160, 0, 200, 0), keep: true }],
      [{ x0: 200, y0: 0, x1: 400, y1: 60 }]);
    expect(widths.has("picked")).toBe(false);
    // the busy title now stops before the kept one (60) instead
    expect(widths.get("busy")!.width / 2).toBeLessThanOrEqual(60 - 6);
  });

  // Words 40px wide with 4px spaces: "aaaa bbbb cccc dddd" is 172px on one line.
  const wrapping = (id: string, x: number, y: number, extra: Partial<MapDotTitle> = {}): MapDotTitle =>
    ({ ...node(id, x, y, 172), words: [40, 40, 40, 40], space: 4, maxWidth: 120, maxLines: 2, ...extra });

  test("lines wrap between words, and a word wider than the line breaks inside it", () => {
    expect(mapDotTitleLines([40, 40, 40, 40], 4, 172)).toBe(1);
    expect(mapDotTitleLines([40, 40, 40, 40], 4, 90)).toBe(2);
    expect(mapDotTitleLines([40, 40, 40, 40], 4, 50)).toBe(4);
    expect(mapDotTitleLines([250], 4, 100)).toBe(3);
  });

  test("a title wider than its limit wraps onto two lines, as narrow as two lines allow", () => {
    const fit = fitMapDotTitles([wrapping("a", 0, 0)]).get("a")!;
    expect(fit.lines).toBe(2);
    // two words a line: 84px, plus a pixel of slack
    expect(fit.width).toBeGreaterThanOrEqual(84);
    expect(fit.width).toBeLessThanOrEqual(86);
  });

  test("a title takes a fair share of its row, so the neighbor's title has room too", () => {
    const fits = fitMapDotTitles([wrapping("busy", 0, 0, { priority: 5, maxWidth: 400 }), wrapping("quiet", 100, 0, { priority: 1, maxWidth: 400 })]);
    // one line (172px) would reach past the neighbor's circle; each wraps within the 94px between them
    for (const id of ["busy", "quiet"]) {
      expect(fits.get(id)?.lines).toBe(2);
      expect(fits.get(id)!.width).toBeLessThanOrEqual(94);
    }
  });

  test("a second line is only used when it clears the circle below", () => {
    // the circle below sits 55px down: room for one line, not two
    const fits = fitMapDotTitles([wrapping("top", 0, 0, { priority: 2 }), node("below", 0, 55, 30, 1)]);
    expect(fits.get("top")?.lines).toBe(1);
    expect(fits.get("top")?.width).toBe(120);
  });

  test("a word that fits a title's full width is never split to make a second line", () => {
    // 60px words can't fit the 56px between neighbors: the title is cut on one line, not split mid-word onto two
    const title = { ...wrapping("a", 0, 0, { priority: 2 }), titleWidth: 188, words: [60, 60, 60] };
    const fits = fitMapDotTitles([title, node("left", -44, 26, 10, 1), node("right", 44, 26, 10, 1)]);
    expect(fits.get("a")).toEqual({ width: 56, lines: 1 });
  });

  test("the selected title wraps onto as many lines as it needs and is never cut", () => {
    const fits = fitMapDotTitles([{ ...wrapping("picked", 0, 0, { maxWidth: 50 }), keep: true }, node("below", 0, 30, 30, 9)]);
    expect(fits.get("picked")?.lines).toBe(4);
    expect(fits.get("picked")!.width).toBeLessThanOrEqual(50);
  });
});
