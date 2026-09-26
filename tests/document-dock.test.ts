import { describe, expect, test } from "bun:test";
import type { DocumentDockNode } from "../client/src/types";
import { addPinnedDocument, filterDocumentDock, getDocumentDockDropEdge, listPinnedDocumentIds, movePinnedDocument, removePinnedDocument, resizeDocumentDockSplit } from "../client/src/lib/documentDock";

const pane = (documentId: string, scope?: "family" | "workspace"): DocumentDockNode => ({ type: "pane", documentId, ...(scope ? { scope } : {}) });
function fixture(): DocumentDockNode {
  return { type: "split", id: "outer", direction: "vertical", ratio: 0.65, first: pane("a", "family"), second: {
    type: "split", id: "inner", direction: "horizontal", ratio: 0.35, first: pane("b"), second: pane("c"),
  } };
}

describe("pinned document grid", () => {
  test("new pins stack in the grid and repeated pinning cannot duplicate a document", () => {
    const first = addPinnedDocument(null, "a");
    expect(first).toEqual(pane("a"));
    const second = addPinnedDocument(first, "b");
    expect(second).toMatchObject({ type: "split", direction: "vertical", ratio: 0.5, first, second: pane("b") });
    expect(addPinnedDocument(second, "a")).toBe(second);
    expect(listPinnedDocumentIds(second)).toEqual(["a", "b"]);
  });

  test.each([
    ["left", "horizontal", ["a", "b", "c"]],
    ["right", "horizontal", ["b", "a", "c"]],
    ["top", "vertical", ["a", "b", "c"]],
    ["bottom", "vertical", ["b", "a", "c"]],
  ] as const)("moving a pane to the %s makes the requested split and retains its visibility scope", (edge, direction, order) => {
    const original = fixture();
    const moved = movePinnedDocument(original, "a", "b", edge)!;
    expect(listPinnedDocumentIds(moved)).toEqual([...order]);
    expect(moved).toMatchObject({ type: "split", id: "inner", ratio: 0.35, first: { type: "split", direction, ratio: 0.5 }, second: pane("c") });
    expect(filterDocumentDock(moved, (id) => id === "a")).toBe(original.type === "split" ? original.first : null);
    expect(listPinnedDocumentIds(original)).toEqual(["a", "b", "c"]);
  });

  test("unpinning collapses empty splits without losing the remaining grid sizes", () => {
    const original = fixture();
    const removed = removePinnedDocument(original, "a");
    expect(removed).toBe(original.type === "split" ? original.second : null);
    expect(removePinnedDocument(removed, "c")).toEqual(pane("b"));
    expect(removePinnedDocument(pane("b"), "b")).toBeNull();
    expect(removePinnedDocument(original, "absent")).toBe(original);
  });

  test("resizing changes only its split, clamps usable sizes, and rejects invalid ratios", () => {
    const original = fixture();
    const resized = resizeDocumentDockSplit(original, "inner", 0.6)!;
    expect(resized).toMatchObject({ id: "outer", ratio: 0.65, second: { id: "inner", ratio: 0.6 } });
    expect(resized.type === "split" && original.type === "split" && resized.first === original.first).toBe(true);
    expect(resizeDocumentDockSplit(original, "outer", -10)).toMatchObject({ ratio: 0.2 });
    expect(resizeDocumentDockSplit(original, "outer", 10)).toMatchObject({ ratio: 0.8 });
    expect(resizeDocumentDockSplit(original, "outer", NaN)).toBe(original);
    expect(resizeDocumentDockSplit(original, "missing", 0.5)).toBe(original);
  });

  test("temporarily hidden family pins retain their original positions and dimensions", () => {
    const original = fixture();
    const hidden = filterDocumentDock(original, (id) => id !== "a");
    expect(hidden).toBe(original.type === "split" ? original.second : null);
    expect(filterDocumentDock(original, () => true)).toBe(original);
    expect(filterDocumentDock(original, () => false)).toBeNull();
    const resized = resizeDocumentDockSplit(original, "inner", 0.7)!;
    expect(resized).toMatchObject({ id: "outer", ratio: 0.65, first: pane("a", "family"), second: { id: "inner", ratio: 0.7 } });
  });

  test("invalid moves cannot remove a pane or create duplicates", () => {
    const original = fixture();
    expect(movePinnedDocument(original, "a", "a", "left")).toBe(original);
    expect(movePinnedDocument(original, "a", "missing", "left")).toBe(original);
    expect(movePinnedDocument(original, "missing", "b", "left")).toBe(original);
    expect(movePinnedDocument(null, "a", "b", "left")).toBeNull();
  });

  test("drop placement uses the nearest proportional edge on wide and tall panes", () => {
    const wide = { left: 50, top: 100, width: 1000, height: 200 };
    expect(getDocumentDockDropEdge(wide, 70, 200)).toBe("left");
    expect(getDocumentDockDropEdge(wide, 1030, 200)).toBe("right");
    expect(getDocumentDockDropEdge(wide, 550, 110)).toBe("top");
    expect(getDocumentDockDropEdge(wide, 550, 290)).toBe("bottom");
    expect(getDocumentDockDropEdge({ left: 0, top: 0, width: 200, height: 1000 }, 195, 500)).toBe("right");
  });
});
