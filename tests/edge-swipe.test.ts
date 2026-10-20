import { describe, expect, test } from "bun:test";
import {
  edgeSwipeCandidates,
  lockEdgeSwipe,
  settleSidebarOpen,
  sidebarDragOffset,
  syncPullDistance,
  syncPullTriggers,
} from "../client/src/lib/edgeSwipe";

describe("phone edge swipes", () => {
  test("a touch at the left edge can open the sidebar, and one on a document at its top can pull a sync", () => {
    expect(edgeSwipeCandidates({ x: 8, sidebarOpen: false, canPullSync: false })).toEqual(["open-sidebar"]);
    expect(edgeSwipeCandidates({ x: 200, sidebarOpen: false, canPullSync: true })).toEqual(["pull-sync"]);
    expect(edgeSwipeCandidates({ x: 8, sidebarOpen: false, canPullSync: true })).toEqual(["open-sidebar", "pull-sync"]);
    expect(edgeSwipeCandidates({ x: 200, sidebarOpen: false, canPullSync: false })).toEqual([]);
  });

  test("while the sidebar is open, any touch can swipe it closed, and one at its top can also pull a sync", () => {
    expect(edgeSwipeCandidates({ x: 200, sidebarOpen: true, canPullSync: false })).toEqual(["close-sidebar"]);
    expect(edgeSwipeCandidates({ x: 8, sidebarOpen: true, canPullSync: true })).toEqual(["close-sidebar", "pull-sync"]);
    const open = edgeSwipeCandidates({ x: 200, sidebarOpen: true, canPullSync: true });
    expect(lockEdgeSwipe(open, -30, 4)).toBe("close-sidebar");
    expect(lockEdgeSwipe(open, 2, 30)).toBe("pull-sync");
    expect(lockEdgeSwipe(open, 2, -30)).toBe("none");
  });

  test("the gesture locks to the direction the finger moves, and hands other directions back", () => {
    const both = edgeSwipeCandidates({ x: 8, sidebarOpen: false, canPullSync: true });
    expect(lockEdgeSwipe(both, 4, 3)).toBe("pending");
    expect(lockEdgeSwipe(both, 24, 4)).toBe("open-sidebar");
    expect(lockEdgeSwipe(both, 3, 24)).toBe("pull-sync");
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

  test("the sync pull eases toward its limit and triggers past the threshold", () => {
    expect(syncPullDistance(-10)).toBe(0);
    expect(syncPullDistance(40)).toBeLessThan(40);
    expect(syncPullDistance(1000)).toBeLessThan(112);
    expect(syncPullTriggers(60)).toBe(false);
    expect(syncPullTriggers(80)).toBe(true);
  });
});
