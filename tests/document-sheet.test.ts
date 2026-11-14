import { describe, expect, test } from "bun:test";
import { fitDocumentSheet, getDefaultDocumentSheet, getDocumentSheetEdge, loadLastDocumentSheet, getDocumentSheetMapBox, getDocumentSheetStops, settleDocumentSheet } from "../client/src/lib/documentSheet";

describe("the document as a sheet on the map", () => {
  test("an upright phone slides the sheet up from the bottom; anything else drags its left edge", () => {
    expect(getDocumentSheetEdge(true, 390, 844)).toBe("top");
    expect(getDocumentSheetEdge(true, 844, 390)).toBe("left");
    expect(getDocumentSheetEdge(false, 1280, 800)).toBe("left");
  });

  test("a wide window stops at the margin and at half; the map opens as an even split", () => {
    expect(getDocumentSheetStops("left", 1280, 800)).toEqual([300, 640]);
    expect(getDocumentSheetStops("left", 900, 800)).toEqual([450]);
    expect(getDefaultDocumentSheet("left", 1280, 800)).toEqual({ mode: "docked", size: 640 });
    expect(getDefaultDocumentSheet("left", 900, 800)).toEqual({ mode: "docked", size: 450 });
    expect(getDefaultDocumentSheet("top", 390, 700)).toEqual({ mode: "docked", size: 322 });
  });

  test("a dragged divider snaps to a near stop, stays put between stops, never floats the document, then puts it away", () => {
    expect(settleDocumentSheet("left", 20, 1280, 800)).toEqual({ mode: "page", size: 0 });
    expect(settleDocumentSheet("left", 330, 1280, 800)).toEqual({ mode: "docked", size: 300 });
    expect(settleDocumentSheet("left", 470, 1280, 800)).toEqual({ mode: "docked", size: 470 });
    expect(settleDocumentSheet("left", 610, 1280, 800)).toEqual({ mode: "docked", size: 640 });
    expect(settleDocumentSheet("left", 900, 1280, 800)).toEqual({ mode: "docked", size: 900 });
    // The document keeps at least 360px to read in.
    expect(settleDocumentSheet("left", 1060, 1280, 800)).toEqual({ mode: "docked", size: 920 });
    expect(settleDocumentSheet("left", 1200, 1280, 800)).toEqual({ mode: "map", size: 0 });
  });

  test("on a phone the sheet always lands on full, half or the peek, and a flick carries it on", () => {
    expect(getDocumentSheetStops("top", 390, 700)).toEqual([322, 616]);
    expect(settleDocumentSheet("top", 100, 390, 700)).toEqual({ mode: "page", size: 0 });
    expect(settleDocumentSheet("top", 250, 390, 700)).toEqual({ mode: "docked", size: 322 });
    expect(settleDocumentSheet("top", 560, 390, 700)).toEqual({ mode: "docked", size: 616 });
    expect(settleDocumentSheet("top", 330, 390, 700, 20)).toEqual({ mode: "docked", size: 616 });
    expect(settleDocumentSheet("top", 330, 390, 700, -25)).toEqual({ mode: "page", size: 0 });
  });

  test("a remembered sheet is made to fit the window it comes back to", () => {
    expect(fitDocumentSheet({ mode: "docked", size: 1200 }, "left", 1000, 700)).toEqual({ mode: "docked", size: 640 });
    expect(fitDocumentSheet({ mode: "docked", size: 1200 }, "left", 600, 700)).toEqual({ mode: "docked", size: 300 });
    expect(fitDocumentSheet({ mode: "map", size: 0 }, "top", 390, 700)).toEqual({ mode: "docked", size: 616 });
  });

  test("a floating card remembered by an earlier version comes back as the split", () => {
    const store = new Map<string, string>();
    const previous = (globalThis as { localStorage?: unknown }).localStorage;
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value) };
    try {
      store.set("margin-chat:document-sheet", JSON.stringify({ mode: "card", size: 0 }));
      expect(loadLastDocumentSheet()).toBeNull();
      store.set("margin-chat:document-sheet", JSON.stringify({ mode: "docked", size: 520 }));
      expect(loadLastDocumentSheet()).toEqual({ mode: "docked", size: 520 });
    } finally {
      (globalThis as { localStorage?: unknown }).localStorage = previous;
    }
  });

  test("the map shows beside a docked sheet and everywhere once the document is put away", () => {
    expect(getDocumentSheetMapBox({ mode: "page", size: 0 }, "left", 1000, 700)).toBeNull();
    expect(getDocumentSheetMapBox({ mode: "docked", size: 300 }, "left", 1000, 700)).toEqual({ left: 0, top: 0, width: 300, height: 700 });
    expect(getDocumentSheetMapBox({ mode: "docked", size: 322 }, "top", 390, 700)).toEqual({ left: 0, top: 0, width: 390, height: 322 });
    expect(getDocumentSheetMapBox({ mode: "map", size: 0 }, "left", 1000, 700)).toEqual({ left: 0, top: 0, width: 1000, height: 700 });
  });
});
