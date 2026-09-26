import { describe, expect, test } from "bun:test";
import { buildConnectorCurve, buildConnectorOcclusions, buildDocumentConnector, groupConnectorContinuations, intersectConnectorRects, type DocumentConnectorEndpoint } from "../client/src/lib/documentConnectors";

const workspace = { left: 0, top: 48, right: 1000, bottom: 800 };
const left = { left: 8, top: 60, right: 328, bottom: 780 };
const right = { left: 360, top: 60, right: 960, bottom: 780 };
function endpoint(id: string, panel = left, anchor = { left: panel.left + 20, top: 150, right: panel.left + 180, bottom: 174 }): DocumentConnectorEndpoint {
  return { target: { conversationId: id }, title: `${id} document`, panel, viewport: intersectConnectorRects(panel, workspace), anchor };
}
function connect(source = endpoint("source"), target = endpoint("target", right)) {
  return buildDocumentConnector({ id: "edge", active: true, source, target });
}

describe("document edge visibility", () => {
  test("both visible passages connect facing edges without crossing document content", () => {
    const connection = connect()!;
    expect(connection.continuation).toBeUndefined();
    expect(connection.start).toEqual({ x: 328, y: 162 });
    expect(connection.end).toEqual({ x: 360, y: 162 });
    const reversed = connect(endpoint("source", right), endpoint("target", left))!;
    expect(reversed.start.x).toBe(360);
    expect(reversed.end.x).toBe(328);
    expect(buildConnectorCurve(reversed)).toContain(" C ");
  });

  test("a passage clipped by its own scroller becomes a named source continuation", () => {
    const source = endpoint("source", left, { left: 28, right: 200, top: 100, bottom: 124 });
    source.viewport = { ...left, top: 140 };
    source.target.anchorId = "selected-passage";
    const connection = connect(source)!;
    expect(connection.continuation).toMatchObject({ title: "source document", direction: "up", relation: "source", target: { conversationId: "source", anchorId: "selected-passage" } });
    expect(connection.start).toEqual(connection.end);
    expect(connection.continuation!.top).toBeGreaterThanOrEqual(right.top);
    expect(connection.continuation!.left).toBeGreaterThanOrEqual(right.left);
  });

  test("offscreen horizontal documents show direction and preserve block destinations", () => {
    const target = endpoint("target", { ...right, left: 1080, right: 1680 });
    target.target.blockId = "target-block";
    const connection = connect(endpoint("source"), target)!;
    expect(connection.continuation).toMatchObject({ direction: "right", relation: "target", target: { conversationId: "target", blockId: "target-block" } });
  });

  test("hidden or unrelated target documents can be opened from a visible source", () => {
    const connection = connect(endpoint("source"), { title: "Other topic", panel: null, viewport: null, anchor: null, target: { conversationId: "elsewhere" } });
    expect(connection?.continuation).toMatchObject({ title: "Other topic", direction: "open", relation: "target", target: { conversationId: "elsewhere" } });
  });

  test("both out-of-scope passages produce no stray lines or labels", () => {
    const source = endpoint("source", left, { left: 20, right: 200, top: -600, bottom: -580 });
    const target = endpoint("target", right, { left: 400, right: 600, top: 1600, bottom: 1620 });
    expect(connect(source, target)).toBeNull();
    expect(connect({ ...source, panel: null, anchor: null }, { ...target, panel: null, anchor: null })).toBeNull();
  });

  test("a partially visible selection stays connected while clipped continuation labels stay within the pane", () => {
    const source = endpoint("source", left, { left: 20, right: 200, top: 48, bottom: 74 });
    expect(connect(source)?.continuation).toBeUndefined();
    const hidden = { ...endpoint("target", right), anchor: null };
    const label = connect(source, hidden)!.continuation!;
    expect(label.top).toBeGreaterThanOrEqual(left.top);
    expect(label.left + label.width).toBeLessThanOrEqual(left.right);
  });

  test("same-document links avoid curves over text but retain offscreen navigation", () => {
    expect(connect(endpoint("same"), endpoint("same"))).toBeNull();
    expect(connect(endpoint("same"), endpoint("same", left, { left: 20, right: 200, top: 900, bottom: 925 }))?.continuation?.direction).toBe("down");
  });

  test("stacked pinned panels connect top/bottom edges", () => {
    const topPanel = { left: 8, right: 960, top: 60, bottom: 350 };
    const bottomPanel = { left: 8, right: 960, top: 375, bottom: 780 };
    const connection = connect(endpoint("top", topPanel), endpoint("bottom", bottomPanel, { left: 28, right: 180, top: 420, bottom: 444 }))!;
    expect(connection.start.y).toBe(350);
    expect(connection.end.y).toBe(375);
  });

  test("toolbar, sidebars and the full pinned dock are masked in each orientation", () => {
    const insetWorkspace = { left: 200, top: 48, right: 900, bottom: 780 };
    const docks = [
      { ...insetWorkspace, right: 470 },
      { ...insetWorkspace, left: 640 },
      { ...insetWorkspace, bottom: 350 },
      { ...insetWorkspace, top: 500 },
    ];
    for (const dock of docks) {
      const masks = buildConnectorOcclusions(insetWorkspace, [dock], 1000, 800);
      expect(masks.find((mask) => mask.id === "pinned-dock-0")).toEqual({ id: "pinned-dock-0", x: dock.left, y: dock.top, width: dock.right - dock.left, height: dock.bottom - dock.top });
      expect(masks.map((mask) => mask.id)).toEqual(expect.arrayContaining(["workspace-top", "workspace-left", "workspace-right", "workspace-bottom"]));
    }
  });

  test("colliding relationship labels share a compact picker without losing destinations", () => {
    const source = endpoint("source");
    const hidden = { ...endpoint("target", right), anchor: null };
    const first = connect(source, hidden)!;
    const second = { ...connect(source, { ...hidden, title: "Second target", target: { conversationId: "second" } })!, id: "second-link" };
    const groups = groupConnectorContinuations([first, second]);
    expect(groups).toHaveLength(1);
    expect(groups[0].connections.map((item) => item.continuation?.target.conversationId)).toEqual(["target", "second"]);
    const distant = { ...second, id: "third-link", continuation: { ...second.continuation!, top: second.continuation!.top + 100 } };
    expect(groupConnectorContinuations([first, second, distant])).toHaveLength(2);
  });
});
