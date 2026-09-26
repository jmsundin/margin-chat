import { expect, test } from "bun:test";
import { getDocumentNodeFootprint } from "../client/src/lib/documentMapLayout";
import { layoutNetworkMap } from "../client/src/lib/networkMapLayout";

const node = (id: number) => ({ conversationId: String(id), x: id * 900, y: id * -100, width: 260, height: 120, depth: id % 3 });
const edge = (source: number, target: number) => ({ sourceId: String(source), targetId: String(target) });
const canvas = { width: 1000, height: 700 };

test("network layout is deterministic, independent of input ordering and saved Canvas coordinates", () => {
  const nodes = Array.from({ length: 16 }, (_, index) => node(index));
  const edges = Array.from({ length: 12 }, (_, index) => edge(index, index + 1));
  const result = layoutNetworkMap(nodes, canvas, edges);
  expect(layoutNetworkMap(nodes, canvas, edges)).toEqual(result);
  const reversed = layoutNetworkMap([...nodes].reverse(), canvas, [...edges].reverse()).nodes.reverse();
  expect(reversed).toEqual(result.nodes);
  const movedCanvas = nodes.map((item) => ({ ...item, x: 100, y: -90000 }));
  expect(layoutNetworkMap(movedCanvas, canvas, edges).nodes).toEqual(result.nodes);
  expect(layoutNetworkMap(nodes, { width: 400, height: 500 }, edges).nodes).toEqual(result.nodes);
  expect(layoutNetworkMap(nodes, canvas, edges, { iteration: 1 }).nodes).not.toEqual(result.nodes);
});

test("network layout preserves pins exactly, uses document footprints, and never mutates callers", () => {
  const nodes = Array.from({ length: 12 }, (_, index) => node(index));
  const connections = nodes.slice(1).map((_, index) => edge(0, index + 1));
  const options = { pinned: { "0": { x: 401.125, y: -200.75 }, "3": { x: -32, y: 800 }, missing: { x: 999, y: 999 } } };
  const before = structuredClone({ nodes, connections, options });
  const result = layoutNetworkMap(nodes, canvas, connections, options);
  expect({ nodes, connections, options }).toEqual(before);
  const footprint = getDocumentNodeFootprint(1);
  result.nodes.forEach((placed, index) => {
    expect(placed).not.toBe(nodes[index]);
    expect(placed.depth).toBe(nodes[index].depth);
    expect(placed.width).toBe(footprint.width);
    expect(placed.height).toBe(footprint.height);
  });
  for (const iteration of [0, 1, 2]) {
    const pinnedResult = layoutNetworkMap(nodes, canvas, connections, { ...options, iteration });
    for (const id of ["0", "3"] as const) {
      const placed = pinnedResult.nodes.find((item) => item.conversationId === id)!;
      expect({ x: placed.x, y: placed.y }).toEqual(options.pinned[id]);
    }
  }
});

test("empty, isolated, cyclic and duplicate edges produce finite layouts with every document retained", () => {
  expect(layoutNetworkMap([], { width: 0, height: 0 }, [])).toEqual({ nodes: [], viewport: { x: 0.5, y: 0.5, scale: 0.9 } });
  for (const nodes of [[node(0)], Array.from({ length: 20 }, (_, index) => node(index))]) {
    const connections = [edge(0, 1), edge(1, 2), edge(2, 0), edge(0, 1), edge(1, 0), edge(4, 4), edge(0, 999)];
    const result = layoutNetworkMap(nodes, canvas, connections);
    expect(result.nodes.map((item) => item.conversationId)).toEqual(nodes.map((item) => item.conversationId));
    expect(result.nodes.flatMap((item) => [item.x, item.y, item.width, item.height]).every(Number.isFinite)).toBe(true);
    expect(Object.values(result.viewport).every(Number.isFinite)).toBe(true);
    const deduplicated = layoutNetworkMap(nodes, canvas, [edge(0, 1), edge(1, 2), edge(2, 0)]);
    expect(result).toEqual(deduplicated);
  }
});

test("force layout separates crowded connected cards while retaining overlapping authored pins", () => {
  const nodes = Array.from({ length: 120 }, (_, index) => ({ ...node(index), x: 0, y: 0 }));
  const connections = nodes.slice(1).map((_, index) => edge(Math.floor(index / 4), index + 1));
  const result = layoutNetworkMap(nodes, canvas, connections);
  result.nodes.forEach((a, index) => result.nodes.slice(index + 1).forEach((b) => {
    expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
  }));
  const pins = { "0": { x: 123, y: -456 }, "1": { x: 123, y: -456 } };
  const pinned = layoutNetworkMap(nodes.slice(0, 5), canvas, connections, { pinned: pins });
  expect(pinned.nodes.slice(0, 2).map(({ x, y }) => ({ x, y }))).toEqual([pins["0"], pins["1"]]);
});

test("small mixed networks fit all documents at a readable scale without overlapping cards", () => {
  const nodes = Array.from({ length: 14 }, (_, index) => node(index));
  const connections = [[0, 1], [0, 2], [1, 3], [2, 4], [5, 6], [6, 7], [8, 9]].map(([a, b]) => edge(a, b));
  const shortCanvas = { width: 1000, height: 530 };
  for (const iteration of [0, 1, 2]) {
    const result = layoutNetworkMap(nodes, shortCanvas, connections, { iteration });
    expect(result.viewport.scale).toBeGreaterThanOrEqual(0.5);
    expect(getDocumentNodeFootprint(result.viewport.scale).titleFontSize).toBeGreaterThanOrEqual(8);
    result.nodes.forEach((a, index) => {
      const left = a.x * result.viewport.scale + result.viewport.x;
      const top = a.y * result.viewport.scale + result.viewport.y;
      expect(left).toBeGreaterThanOrEqual(23.99);
      expect(top).toBeGreaterThanOrEqual(23.99);
      expect(left + a.width * result.viewport.scale).toBeLessThanOrEqual(shortCanvas.width - 23.99);
      expect(top + a.height * result.viewport.scale).toBeLessThanOrEqual(shortCanvas.height - 63.99);
      result.nodes.slice(index + 1).forEach((b) => {
        expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
      });
    });
  }
});

test("large full-workspace graphs remain deterministic and fit within the viewport", () => {
  const nodes = Array.from({ length: 1600 }, (_, index) => node(index));
  const connections = nodes.slice(1).map((_, index) => edge(index, index + 1));
  const result = layoutNetworkMap(nodes, canvas, connections);
  expect(layoutNetworkMap(nodes, canvas, connections)).toEqual(result);
  expect(result.nodes).toHaveLength(nodes.length);
  expect(result.viewport.scale).toBeGreaterThan(0);
  for (const placed of result.nodes) {
    expect([placed.x, placed.y].every(Number.isFinite)).toBe(true);
    const left = placed.x * result.viewport.scale + result.viewport.x;
    const top = placed.y * result.viewport.scale + result.viewport.y;
    expect(left).toBeGreaterThanOrEqual(23.99);
    expect(top).toBeGreaterThanOrEqual(23.99);
    expect(left + placed.width * result.viewport.scale).toBeLessThanOrEqual(canvas.width - 23.99);
    expect(top + placed.height * result.viewport.scale).toBeLessThanOrEqual(canvas.height - 63.99);
  }
});
