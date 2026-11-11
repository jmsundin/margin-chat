import { describe, expect, test } from "bun:test";
import { clampSplitSize, getDocumentMapSplitBox, getDocumentMapSplitEdge, nextDocumentMapPanel } from "../client/src/lib/documentMapPanel";

describe("the map around a document", () => {
  test("the header button opens the map, then puts it away to its pill, then brings it back", () => {
    expect(nextDocumentMapPanel("closed")).toBe("open");
    expect(nextDocumentMapPanel("open")).toBe("minimized");
    expect(nextDocumentMapPanel("minimized")).toBe("open");
  });

  test("split stacks the map on top on an upright phone and puts it on the left otherwise", () => {
    expect(getDocumentMapSplitEdge(true, 390, 844)).toBe("top");
    expect(getDocumentMapSplitEdge(true, 844, 390)).toBe("left");
    expect(getDocumentMapSplitEdge(false, 1280, 800)).toBe("left");
    expect(getDocumentMapSplitEdge(false, 700, 1000)).toBe("left");
  });

  test("the split keeps both halves usable", () => {
    expect(clampSplitSize(0.05)).toBe(0.2);
    expect(clampSplitSize(0.95)).toBe(0.8);
    expect(clampSplitSize(Number.NaN)).toBe(0.45);
    expect(getDocumentMapSplitBox("top", 0.5, 390, 700)).toEqual({ left: 0, top: 0, width: 390, height: 350 });
    expect(getDocumentMapSplitBox("left", 0.4, 1000, 700)).toEqual({ left: 0, top: 0, width: 400, height: 700 });
  });
});
