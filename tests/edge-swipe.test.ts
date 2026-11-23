import { describe, expect, test } from "bun:test";
import {
  edgeSwipeCandidates,
  lockEdgeSwipe,
  RIGHT_SWIPE_LEAN_PX,
  RIGHT_SWIPE_TRIGGER_PX,
  rightSwipeLean,
  settleOpenRight,
  settleSidebarOpen,
  sidebarDragOffset,
  syncPullDistance,
  syncPullTriggers,
} from "../client/src/lib/edgeSwipe";
import { htmlEdgeZones, readHtmlFrameMessage } from "../client/src/lib/htmlDocuments";

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

describe("right-edge swipes on HTML pages", () => {
  test("a touch at the right edge of something with notes beside it can open them; elsewhere it can't", () => {
    expect(edgeSwipeCandidates({ x: 380, sidebarOpen: false, canPullSync: false, canOpenRight: true, viewportWidth: 390 })).toEqual(["open-right"]);
    expect(edgeSwipeCandidates({ x: 300, sidebarOpen: false, canPullSync: false, canOpenRight: true, viewportWidth: 390 })).toEqual([]);
    expect(edgeSwipeCandidates({ x: 380, sidebarOpen: false, canPullSync: false, canOpenRight: false, viewportWidth: 390 })).toEqual([]);
    // With the sidebar out, a leftward swipe closes it instead.
    expect(edgeSwipeCandidates({ x: 380, sidebarOpen: true, canPullSync: false, canOpenRight: true, viewportWidth: 390 })).toEqual(["close-sidebar"]);
  });

  test("only a leftward swipe opens what's on the right", () => {
    expect(lockEdgeSwipe(["open-right"], -30, 4)).toBe("open-right");
    expect(lockEdgeSwipe(["open-right"], 30, 4)).toBe("none");
    expect(lockEdgeSwipe(["open-right"], -6, 30)).toBe("none");
  });

  test("letting go far enough or with a fling opens it; a short slow swipe doesn't", () => {
    expect(settleOpenRight(-RIGHT_SWIPE_TRIGGER_PX, 0)).toBe(true);
    expect(settleOpenRight(-20, -1)).toBe(true);
    expect(settleOpenRight(-20, 0)).toBe(false);
    expect(settleOpenRight(-80, 1)).toBe(false);
  });

  test("the page leans a little with the finger, never past its limit", () => {
    expect(rightSwipeLean(20)).toBe(0);
    expect(rightSwipeLean(-30)).toBeLessThan(0);
    expect(rightSwipeLean(-10_000)).toBeGreaterThanOrEqual(-RIGHT_SWIPE_LEAN_PX);
  });
});

describe("edge strips inside an HTML page's frame", () => {
  test("a frame spanning the screen gets both strips; an inset frame gets only what reaches the edge", () => {
    expect(htmlEdgeZones({ left: 0, right: 390 }, 390, 32)).toMatchObject({ type: "edges", left: 32, right: 32 });
    expect(htmlEdgeZones({ left: 12, right: 378 }, 390, 32)).toMatchObject({ left: 20, right: 20 });
    expect(htmlEdgeZones({ left: 40, right: 350 }, 390, 32)).toMatchObject({ left: 0, right: 0 });
  });

  test("the app reads a frame's edge touches and nothing malformed", () => {
    expect(readHtmlFrameMessage({ marginHtml: 1, type: "edge-touch", phase: "move", x: 4, y: 100, t: 12 }))
      .toEqual({ marginHtml: 1, type: "edge-touch", phase: "move", x: 4, y: 100, t: 12 });
    expect(readHtmlFrameMessage({ marginHtml: 1, type: "edge-touch", phase: "tap", x: 4, y: 100, t: 12 })).toBeNull();
    expect(readHtmlFrameMessage({ marginHtml: 1, type: "edge-touch", phase: "end", x: "4", y: 100, t: 12 })).toBeNull();
  });
});
