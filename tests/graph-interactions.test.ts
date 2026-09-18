import { describe, expect, test } from "bun:test";
import {
  createGraphInteractionController,
  getGraphNodesInSelectionBounds,
  type GraphInteractionCallbacks,
  type GraphNodeMove,
  type GraphPointer,
  type GraphSelectionBounds,
} from "../client/src/lib/graphInteractions";

const point = (clientX: number, clientY: number, pointerId = 1): GraphPointer => ({ clientX, clientY, pointerId });

function harness(scale = 2) {
  let nextFrame = 0;
  const frames = new Map<number, () => void>();
  const previews: (GraphNodeMove | null)[] = [];
  const commits: GraphNodeMove[] = [];
  const pans: boolean[] = [];
  const viewportUpdates: { scale: number; x: number; y: number }[] = [];
  const marquee: (GraphSelectionBounds | null)[] = [];
  const selections: Set<string>[] = [];
  let selectionQueries = 0;
  let viewport = { scale, x: 20, y: 40 };
  const callbacks: GraphInteractionCallbacks = {
    getViewport: () => viewport,
    toWorld: (value) => ({ x: (value.clientX - viewport.x) / viewport.scale, y: (value.clientY - viewport.y) / viewport.scale }),
    getSelection: (bounds) => {
      selectionQueries += 1;
      return getGraphNodesInSelectionBounds([
        { conversationId: "near", depth: 0, x: 10, y: 10, width: 20, height: 20 },
        { conversationId: "far", depth: 0, x: 100, y: 100, width: 20, height: 20 },
      ], bounds);
    },
    onViewport: (value) => { viewport = value; viewportUpdates.push(value); },
    onPanning: (value) => pans.push(value),
    onNodePreview: (value) => previews.push(value),
    onNodeCommit: (value) => commits.push(value),
    onMarquee: (value) => marquee.push(value),
    onSelection: (value) => selections.push(value),
  };
  const controller = createGraphInteractionController(() => callbacks, {
    request: (callback) => { frames.set(++nextFrame, callback); return nextFrame; },
    cancel: (id) => { frames.delete(id); },
  });
  return {
    controller, previews, commits, pans, viewportUpdates, marquee, selections,
    pendingFrames: () => frames.size,
    selectionQueries: () => selectionQueries,
    flush() {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback();
    },
  };
}

describe("graph gesture controller", () => {
  test("coalesces pointer bursts and translates a rigid selection using graph scale", () => {
    const app = harness();
    app.controller.startNode(point(100, 200), "one", ["one", "two"]);
    for (let i = 1; i <= 100; i += 1) app.controller.move(point(100 + i, 200 + i * 2));
    expect(app.pendingFrames()).toBe(1);
    expect(app.previews).toHaveLength(1);
    app.flush();
    expect(app.previews).toHaveLength(2);
    expect(app.previews.at(-1)).toEqual({ conversationId: "one", conversationIds: ["one", "two"], deltaX: 50, deltaY: 100 });
    expect(app.commits).toHaveLength(0);
  });

  test("release commits final coordinates even when its preview frame has not run", () => {
    const app = harness(0.5);
    app.controller.startNode(point(10, 20), "one", ["one"]);
    app.controller.move(point(20, 30));
    expect(app.controller.end(point(25, 40))).toBe(true);
    expect(app.commits).toEqual([{ conversationId: "one", conversationIds: ["one"], deltaX: 30, deltaY: 40 }]);
    expect(app.previews.at(-1)).toBeNull();
    expect(app.pendingFrames()).toBe(0);
    app.flush();
    expect(app.commits).toHaveLength(1);
    expect(app.controller.end(point(30, 50))).toBe(false);
  });

  test("cancelling a node drag discards queued work without committing", () => {
    const app = harness();
    app.controller.startNode(point(0, 0), "one", ["one", "two"]);
    expect(app.controller.move(point(100, 100, 99))).toBe(false);
    app.controller.move(point(100, 100));
    expect(app.controller.end(point(100, 100, 99))).toBe(false);
    expect(app.controller.cancel()).toBe(true);
    app.flush();
    expect(app.previews).toHaveLength(2);
    expect(app.previews.at(-1)).toBeNull();
    expect(app.commits).toEqual([]);
    expect(app.controller.isActive()).toBe(false);
  });

  test("panning is frame-coalesced in screen pixels and flushes on release", () => {
    const app = harness();
    app.controller.startPan(point(100, 200));
    app.controller.move(point(110, 220));
    app.controller.move(point(120, 230));
    expect(app.viewportUpdates).toHaveLength(0);
    app.flush();
    expect(app.viewportUpdates).toEqual([{ scale: 2, x: 40, y: 70 }]);
    app.controller.move(point(140, 250));
    app.controller.end(point(150, 260));
    expect(app.viewportUpdates.at(-1)).toEqual({ scale: 2, x: 70, y: 100 });
    expect(app.pans).toEqual([true, false]);
    expect(app.pendingFrames()).toBe(0);
  });

  test("marquee selection respects transformed coordinates, additive selection, and cancellation", () => {
    const app = harness();
    app.controller.startMarquee(point(20, 40), true, ["existing"]);
    for (let i = 1; i <= 50; i += 1) app.controller.move(point(20 + i, 40 + i));
    expect(app.selectionQueries()).toBe(0);
    app.flush();
    expect(app.selectionQueries()).toBe(1);
    expect(app.marquee.at(-1)).toEqual({ x: 0, y: 0, width: 25, height: 25 });
    expect([...app.selections.at(-1)!]).toEqual(["existing", "near"]);
    app.controller.move(point(260, 280));
    app.controller.end(point(260, 280), false);
    app.flush();
    expect([...app.selections.at(-1)!]).toEqual(["existing"]);
    expect(app.marquee.at(-1)).toBeNull();
    expect(app.selectionQueries()).toBe(1);
  });

  test("marquee release consumes the latest bounds and disposal prevents stale previews", () => {
    const app = harness();
    app.controller.startMarquee(point(20, 40), false, ["old"]);
    app.controller.move(point(40, 60));
    app.controller.end(point(260, 280));
    expect([...app.selections.at(-1)!]).toEqual(["near", "far"]);
    expect(app.pendingFrames()).toBe(0);
    app.controller.startNode(point(0, 0), "one", ["one"]);
    app.controller.move(point(100, 100));
    const count = app.previews.length;
    app.controller.dispose();
    app.flush();
    expect(app.previews).toHaveLength(count);
    expect(app.commits).toHaveLength(0);
  });
});
