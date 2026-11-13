import { describe, expect, test } from "bun:test";
import { fitDocumentSheet, getDefaultDocumentSheet, getDocumentSheetCardBox, getDocumentSheetEdge, getDocumentSheetMapBox, getDocumentSheetStops, settleDocumentSheet } from "../client/src/lib/documentSheet";

describe("the document as a sheet on the map", () => {
  test("an upright phone slides the sheet up from the bottom; anything else drags its left edge", () => {
    expect(getDocumentSheetEdge(true, 390, 844)).toBe("top");
    expect(getDocumentSheetEdge(true, 844, 390)).toBe("left");
    expect(getDocumentSheetEdge(false, 1280, 800)).toBe("left");
  });

  test("a wide window stops at the margin and at half; a narrow one only at half", () => {
    expect(getDocumentSheetStops("left", 1280, 800)).toEqual([300, 640]);
    expect(getDocumentSheetStops("left", 900, 800)).toEqual([450]);
    expect(getDefaultDocumentSheet("left", 1280, 800)).toEqual({ mode: "docked", size: 300 });
    expect(getDefaultDocumentSheet("left", 900, 800)).toEqual({ mode: "docked", size: 450 });
  });

  test("a dragged edge snaps to a near stop, stays put between stops, lifts off as a card, then is put away", () => {
    expect(settleDocumentSheet("left", 20, 1280, 800)).toEqual({ mode: "page", size: 0 });
    expect(settleDocumentSheet("left", 330, 1280, 800)).toEqual({ mode: "docked", size: 300 });
    expect(settleDocumentSheet("left", 470, 1280, 800)).toEqual({ mode: "docked", size: 470 });
    expect(settleDocumentSheet("left", 610, 1280, 800)).toEqual({ mode: "docked", size: 640 });
    expect(settleDocumentSheet("left", 900, 1280, 800)).toEqual({ mode: "card", size: 0 });
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
    expect(fitDocumentSheet({ mode: "docked", size: 1200 }, "left", 1000, 700)).toEqual({ mode: "docked", size: 660 });
    expect(fitDocumentSheet({ mode: "card", size: 0 }, "top", 390, 700)).toEqual({ mode: "docked", size: 616 });
    expect(fitDocumentSheet({ mode: "card", size: 0 }, "left", 1280, 800)).toEqual({ mode: "card", size: 0 });
  });

  test("the map shows beside a docked sheet and everywhere under a card or a sheet put away", () => {
    expect(getDocumentSheetMapBox({ mode: "page", size: 0 }, "left", 1000, 700)).toBeNull();
    expect(getDocumentSheetMapBox({ mode: "docked", size: 300 }, "left", 1000, 700)).toEqual({ left: 0, top: 0, width: 300, height: 700 });
    expect(getDocumentSheetMapBox({ mode: "docked", size: 322 }, "top", 390, 700)).toEqual({ left: 0, top: 0, width: 390, height: 322 });
    expect(getDocumentSheetMapBox({ mode: "card", size: 0 }, "left", 1000, 700)).toEqual({ left: 0, top: 0, width: 1000, height: 700 });
    expect(getDocumentSheetMapBox({ mode: "map", size: 0 }, "left", 1000, 700)).toEqual({ left: 0, top: 0, width: 1000, height: 700 });
  });

  test("the card sits right of the middle and stays reachable when moved", () => {
    expect(getDocumentSheetCardBox(1280, 800)).toEqual({ left: 700, top: 100, width: 460, height: 600 });
    const moved = getDocumentSheetCardBox(1280, 800, { left: 5000, top: -40 });
    expect(moved.left).toBe(1200);
    expect(moved.top).toBe(0);
  });
});
