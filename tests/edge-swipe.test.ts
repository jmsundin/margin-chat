import { describe, expect, test } from "bun:test";
import {
  edgeSwipeCandidates,
  lockEdgeSwipe,
  searchPullDistance,
  searchPullTriggers,
  settleSidebarOpen,
  sidebarDragOffset,
} from "../client/src/lib/edgeSwipe";

describe("phone edge swipes", () => {
  test("a touch at the left edge can open the sidebar, and one on a document at its top can pull search", () => {
    expect(edgeSwipeCandidates({ x: 8, sidebarOpen: false, atDocumentTop: false })).toEqual(["open-sidebar"]);
    expect(edgeSwipeCandidates({ x: 200, sidebarOpen: false, atDocumentTop: true })).toEqual(["pull-search"]);
    expect(edgeSwipeCandidates({ x: 8, sidebarOpen: false, atDocumentTop: true })).toEqual(["open-sidebar", "pull-search"]);
    expect(edgeSwipeCandidates({ x: 200, sidebarOpen: false, atDocumentTop: false })).toEqual([]);
  });

  test("while the sidebar is open, any touch can swipe it closed", () => {
    expect(edgeSwipeCandidates({ x: 200, sidebarOpen: true, atDocumentTop: true })).toEqual(["close-sidebar"]);
  });

  test("the gesture locks to the direction the finger moves, and hands other directions back", () => {
    const both = edgeSwipeCandidates({ x: 8, sidebarOpen: false, atDocumentTop: true });
    expect(lockEdgeSwipe(both, 4, 3)).toBe("pending");
    expect(lockEdgeSwipe(both, 24, 4)).toBe("open-sidebar");
    expect(lockEdgeSwipe(both, 3, 24)).toBe("pull-search");
    expect(lockEdgeSwipe(both, 3, -24)).toBe("none");
    expect(lockEdgeSwipe(["open-sidebar"], 14, 12)).toBe("none");
    expect(lockEdgeSwipe(["close-sidebar"], -30, 5)).toBe("close-sidebar");
    expect(lockEdgeSwipe(["close-sidebar"], 30, 5)).toBe("none");
  });

  test("the sidebar follows the finger and settles by position or fling", () => {
    expect(sidebarDragOffset("open-sidebar", 100, 300)).toBe(-200);
    expect(sidebarDragOffset("open-sidebar", 400, 300)).toBe(0);
    expect(sidebarDragOffset("close-sidebar", -120, 300)).toBe(-120);
    expect(sidebarDragOffset("close-sidebar", 40, 300)).toBe(0);
    expect(settleSidebarOpen(-100, 300, 0)).toBe(true);
    expect(settleSidebarOpen(-200, 300, 0)).toBe(false);
    expect(settleSidebarOpen(-250, 300, 1)).toBe(true);
    expect(settleSidebarOpen(-20, 300, -1)).toBe(false);
  });

  test("the search pull eases toward its limit and triggers past the threshold", () => {
    expect(searchPullDistance(-10)).toBe(0);
    expect(searchPullDistance(40)).toBeLessThan(40);
    expect(searchPullDistance(1000)).toBeLessThan(112);
    expect(searchPullTriggers(60)).toBe(false);
    expect(searchPullTriggers(80)).toBe(true);
  });
});
