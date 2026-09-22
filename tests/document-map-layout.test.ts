import { expect, test } from "bun:test";
import { getDocumentNodeFootprint, layoutDocumentMap } from "../client/src/lib/documentMapLayout";

const node = (id: number, x: number, y: number) => ({ conversationId: String(id), x, y, width: 260, height: 120, depth: 0 });
function expectNonOverlapping(nodes: ReturnType<typeof node>[]) {
  nodes.forEach((a, index) => nodes.slice(index + 1).forEach((b) => {
    expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
  }));
}

test("document layout preserves uncrowded authored centers and fits proportional cards", () => {
  const nodes = [node(0, -120, 0), node(1, 200, 0), node(2, 200, 200)];
  const result = layoutDocumentMap(nodes, { width: 1000, height: 700 });
  expect(result.arranged).toBe(false);
  result.nodes.forEach((placement, index) => {
    expect(placement.x + placement.width / 2).toBe(nodes[index].x + nodes[index].width / 2);
    expect(placement.y + placement.height / 2).toBe(nodes[index].y + nodes[index].height / 2);
  });
  expectNonOverlapping(result.nodes);
});

test("interleaved and outlying saved documents get a deterministic readable grid without writes", () => {
  const nodes = Array.from({ length: 34 }, (_, index) => node(index, index % 2 * 20, index === 33 ? 24000 : index % 3 * 15));
  const before = structuredClone(nodes);
  for (const canvas of [{ width: 841, height: 564 }, { width: 390, height: 500 }]) {
    const result = layoutDocumentMap(nodes, canvas);
    expect(result.arranged).toBe(true);
    expect(result.viewport.scale).toBeGreaterThanOrEqual(0.5);
    expect(result).toEqual(layoutDocumentMap(nodes, canvas));
    expectNonOverlapping(result.nodes);
    result.nodes.forEach((placement) => {
      const left = placement.x * result.viewport.scale + result.viewport.x;
      expect(left).toBeGreaterThanOrEqual(23.99);
      expect(left + placement.width * result.viewport.scale).toBeLessThanOrEqual(canvas.width - 23.99);
    });
    if (canvas.width > 500) result.nodes.forEach((placement) => {
      const top = placement.y * result.viewport.scale + result.viewport.y;
      expect(top).toBeGreaterThanOrEqual(23.99);
      expect(top + placement.height * result.viewport.scale).toBeLessThanOrEqual(canvas.height - 23.99);
    });
    else expect(result.nodes.at(-1)!.y * result.viewport.scale + result.viewport.y).toBeGreaterThan(canvas.height);
  }
  expect(nodes).toEqual(before);
});

test("coincident positions arrange even when their authored extent would fit at large scale", () => {
  const result = layoutDocumentMap([node(0, 100, 200), node(1, 100, 200)], { width: 1200, height: 800 });
  expect(result.arranged).toBe(true);
  expectNonOverlapping(result.nodes);
});

test("document cards scale continuously and titles remain until their font falls below 8px", () => {
  for (const scale of [0.0349, 0.3, 0.399, 0.4, 0.5, 0.65, 0.9, 1.5]) {
    const footprint = getDocumentNodeFootprint(scale);
    expect(footprint.width).toBeCloseTo(180 * scale);
    expect(footprint.height).toBeCloseTo(96 * scale);
    expect(footprint.titleLines > 0).toBe(scale >= 0.4);
    if (scale >= 0.4) expect(footprint.titleFontSize).toBeGreaterThanOrEqual(8);
  }
  const empty = layoutDocumentMap([], { width: 0, height: 0 });
  expect(Object.values(empty.viewport).every(Number.isFinite)).toBe(true);
});

const edge = (sourceId: number, targetId: number) => ({ sourceId: String(sourceId), targetId: String(targetId) });

test("left-to-right and top-down trees follow directed connections including shared children and shortcuts", () => {
  const nodes = Array.from({ length: 9 }, (_, index) => node(index, index % 2 * 20, index === 8 ? 24000 : 0));
  const connections = [edge(0, 1), edge(0, 2), edge(1, 3), edge(2, 3), edge(2, 4), edge(4, 5), edge(0, 5), edge(6, 7)];
  const before = structuredClone({ nodes, connections });
  for (const mode of ["tree-right", "tree-down"] as const) {
    const result = layoutDocumentMap(nodes, { width: 1000, height: 700 }, { mode, connections });
    expect(result.arranged).toBe(true);
    expect(result.centerNodeId).toBeNull();
    expect(result.nodes.map((node) => node.conversationId)).toEqual(nodes.map((node) => node.conversationId));
    const byId = new Map(result.nodes.map((node) => [node.conversationId, node]));
    for (const { sourceId, targetId } of connections) {
      const source = byId.get(sourceId)!, target = byId.get(targetId)!;
      expect(mode === "tree-right" ? target.x > source.x + source.width : target.y > source.y + source.height).toBe(true);
    }
    expectNonOverlapping(result.nodes);
    expect(result).toEqual(layoutDocumentMap(nodes, { width: 1000, height: 700 }, { mode, connections: [...connections].reverse() }));
  }
  expect({ nodes, connections }).toEqual(before);
});

test("tree layouts handle cycles, repeated edges, and disconnected components without duplicating documents", () => {
  const nodes = Array.from({ length: 8 }, (_, index) => node(index, 0, 0));
  const connections = [edge(0, 1), edge(1, 2), edge(2, 0), edge(0, 3), edge(2, 3), edge(4, 5), edge(5, 4), edge(4, 5), edge(6, 6), edge(6, 99)];
  for (const mode of ["tree-right", "tree-down", "connections"] as const) {
    const result = layoutDocumentMap(nodes, { width: 390, height: 500 }, { mode, connections });
    expect(new Set(result.nodes.map((node) => node.conversationId)).size).toBe(nodes.length);
    expect(result.nodes).toHaveLength(nodes.length);
    expect(result.nodes.flatMap((node) => [node.x, node.y]).every(Number.isFinite)).toBe(true);
    expect(Object.values(result.viewport).every(Number.isFinite)).toBe(true);
    expect(result.viewport.scale).toBeGreaterThanOrEqual(0.5);
    expectNonOverlapping(result.nodes);
    expect(result).toEqual(layoutDocumentMap(nodes, { width: 390, height: 500 }, { mode, connections }));
  }
});

test("connection layout centers the highest distinct-neighbor degree and counts links in both directions", () => {
  const nodes = Array.from({ length: 8 }, (_, index) => node(index, index * 20, 0));
  const connections = [edge(0, 1), edge(0, 2), edge(4, 0), edge(4, 1), edge(5, 4), edge(4, 6),
    ...Array.from({ length: 30 }, () => edge(0, 1)), edge(1, 0), edge(4, 4), edge(0, 99), edge(99, 0)];
  for (const canvas of [{ width: 1000, height: 700 }, { width: 390, height: 500 }]) {
    const result = layoutDocumentMap(nodes, canvas, { mode: "connections", connections });
    expect(result.centerNodeId).toBe("4");
    const hub = result.nodes.find((node) => node.conversationId === result.centerNodeId)!;
    expect(result.viewport.x + (hub.x + hub.width / 2) * result.viewport.scale).toBeCloseTo(canvas.width / 2);
    expect(result.viewport.y + (hub.y + hub.height / 2) * result.viewport.scale).toBeCloseTo((24 + canvas.height - 64) / 2);
    const distance = (id: string) => { const placement = result.nodes.find((node) => node.conversationId === id)!;
      return Math.hypot(placement.x + placement.width / 2, placement.y + placement.height / 2); };
    expect(distance("0")).toBeCloseTo(distance("1"));
    expect(distance("0")).toBeCloseTo(distance("5"));
    expect(distance("2")).toBeGreaterThan(distance("0"));
    expect(distance("7")).toBeGreaterThan(distance("2"));
    expectNonOverlapping(result.nodes);
    expect(result).toEqual(layoutDocumentMap(nodes, canvas, { mode: "connections", connections: [...connections].reverse() }));
  }
});

test("connection ties follow stable document order, and explicit layouts keep isolated documents reachable", () => {
  const nodes = [node(3, 100, 100), node(2, 100, 100), node(1, 100, 100), node(0, 100, 100)];
  expect(layoutDocumentMap(nodes, { width: 1000, height: 700 }, { mode: "connections", connections: [edge(0, 1), edge(2, 3)] }).centerNodeId).toBe("3");
  for (const mode of ["auto", "tree-right", "tree-down", "connections"] as const) {
    const result = layoutDocumentMap(nodes, { width: 390, height: 500 }, { mode });
    expect(result.nodes).toHaveLength(4);
    expectNonOverlapping(result.nodes);
    expect(result.centerNodeId).toBe(mode === "connections" ? "3" : null);
    const empty = layoutDocumentMap([], { width: 0, height: 0 }, { mode });
    expect(empty.centerNodeId).toBeNull();
    expect(Object.values(empty.viewport).every(Number.isFinite)).toBe(true);
  }
  expect(layoutDocumentMap(nodes, { width: 390, height: 500 }, { mode: "auto", connections: [edge(0, 1)] }))
    .toEqual(layoutDocumentMap(nodes, { width: 390, height: 500 }));
});

test("disconnected trees fill the desktop canvas while each connected tree retains its geometry", () => {
  const nodes = Array.from({ length: 34 }, (_, index) => node(index, index % 2 * 20, index === 33 ? 24000 : 0));
  const connections = [edge(0, 1), edge(0, 2), edge(2, 3), edge(4, 5), edge(5, 4)];
  const before = structuredClone(nodes);
  for (const mode of ["tree-right", "tree-down"] as const) for (const canvas of [{ width: 841, height: 564 }, { width: 753, height: 623 }]) {
    const result = layoutDocumentMap(nodes, canvas, { mode, connections });
    expect(result.nodes).toHaveLength(nodes.length);
    expectNonOverlapping(result.nodes);
    expect(new Set(result.nodes.map((node) => node.x)).size).toBeGreaterThan(2);
    expect(new Set(result.nodes.map((node) => node.y)).size).toBeGreaterThan(2);
    for (const placement of result.nodes) {
      expect(placement.x * result.viewport.scale + result.viewport.x).toBeGreaterThanOrEqual(23.99);
      expect((placement.x + placement.width) * result.viewport.scale + result.viewport.x).toBeLessThanOrEqual(canvas.width - 23.99);
      expect(placement.y * result.viewport.scale + result.viewport.y).toBeGreaterThanOrEqual(23.99);
      expect((placement.y + placement.height) * result.viewport.scale + result.viewport.y).toBeLessThanOrEqual(canvas.height - 63.99);
    }
    const component = layoutDocumentMap(nodes.slice(0, 4), canvas, { mode, connections });
    const packedById = new Map(result.nodes.map((node) => [node.conversationId, node]));
    for (const placement of component.nodes) {
      const packed = packedById.get(placement.conversationId)!;
      expect(packed.x - packedById.get("0")!.x).toBe(placement.x - component.nodes[0].x);
      expect(packed.y - packedById.get("0")!.y).toBe(placement.y - component.nodes[0].y);
    }
    expect(result).toEqual(layoutDocumentMap(nodes, canvas, { mode, connections }));
  }
  expect(nodes).toEqual(before);
});

test("an explicit radial center overrides highest degree and can focus an isolated document", () => {
  const nodes = Array.from({ length: 6 }, (_, index) => node(index, index * 200, 100));
  const connections = [edge(0, 1), edge(0, 2), edge(0, 3), edge(3, 4)];
  const before = structuredClone({ nodes, connections });
  const canvas = { width: 390, height: 500 };
  for (const centerNodeId of ["4", "5"]) {
    const result = layoutDocumentMap(nodes, canvas, { mode: "connections", connections, centerNodeId });
    expect(result.centerNodeId).toBe(centerNodeId);
    const center = result.nodes.find((node) => node.conversationId === centerNodeId)!;
    expect(result.viewport.x + (center.x + center.width / 2) * result.viewport.scale).toBeCloseTo(195);
    expect(result.viewport.y + (center.y + center.height / 2) * result.viewport.scale).toBeCloseTo(230);
    expectNonOverlapping(result.nodes);
    expect(result.nodes).toHaveLength(nodes.length);
  }
  expect(layoutDocumentMap(nodes, canvas, { mode: "connections", connections, centerNodeId: "missing" }))
    .toEqual(layoutDocumentMap(nodes, canvas, { mode: "connections", connections }));
  for (const mode of ["auto", "tree-right", "tree-down"] as const) {
    expect(layoutDocumentMap(nodes, canvas, { mode, connections, centerNodeId: "4" }))
      .toEqual(layoutDocumentMap(nodes, canvas, { mode, connections }));
  }
  expect({ nodes, connections }).toEqual(before);
});

test("focused neighborhoods fit eleven titled cards in a short desktop canvas", () => {
  const nodes = Array.from({ length: 11 }, (_, index) => node(index, index * 200, 100));
  const connections = nodes.slice(1).map((_, index) => edge(0, index + 1));
  const canvas = { width: 1024, height: 560 };
  const result = layoutDocumentMap(nodes, canvas, { mode: "connections", connections, centerNodeId: "0" });
  expectNonOverlapping(result.nodes);
  expect(getDocumentNodeFootprint(result.viewport.scale).titleLines).toBeGreaterThan(0);
  for (const node of result.nodes) {
    expect(result.viewport.x + node.x * result.viewport.scale).toBeGreaterThanOrEqual(0);
    expect(result.viewport.x + (node.x + node.width) * result.viewport.scale).toBeLessThanOrEqual(canvas.width);
    expect(result.viewport.y + node.y * result.viewport.scale).toBeGreaterThanOrEqual(0);
    expect(result.viewport.y + (node.y + node.height) * result.viewport.scale).toBeLessThanOrEqual(canvas.height);
  }
});
