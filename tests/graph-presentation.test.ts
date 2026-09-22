import { expect, test } from "bun:test";
import { buildMapTerritories, centerNodeInCanvas, fitFocusedMapTerritory, fitMapTerritories, fitMapTerritory, fitMapTerritoryOverview, getMapTerritoryBounds, getMapTerritoryScreenBounds, layoutFocusedMapTerritory, layoutMapTerritoryOverview, mapLabelsOverlap, mapTerritoryHeadingWidth, OVERVIEW_NODE_FOOTPRINT, placeMapTerritories, placeMapTerritoryHeadings, readableNodeSize, territoryConnections, type MapTerritory } from "../client/src/lib/graphPresentation";
import type { ConversationGraphScene } from "../client/src/lib/conversationGraph";

test("focus centers in the remaining canvas beside a sidebar and dock", () => {
  const node = { x: -500, y: 200, width: 330, height: 240 };
  for (const rect of [{ left: 286, top: 104, width: 994, height: 616 }, { left: 286, top: 104, width: 360, height: 616 }, { left: 0, top: 160, width: 390, height: 310 }]) {
    const viewport = centerNodeInCanvas(node, rect, 0.9);
    expect(viewport.x + (node.x + node.width / 2) * viewport.scale).toBeCloseTo(rect.width / 2);
    expect(viewport.y + (node.y + node.height / 2) * viewport.scale).toBeCloseTo(rect.height / 2);
    expect(viewport.scale).toBe(0.9);
  }
});

test("title text stays readable and selected previews keep their on-screen size", () => {
  for (const scale of [0.02, 0.4, 0.7, 0.85, 1, 1.5, 2.2]) {
    expect(16 * scale * readableNodeSize(scale)).toBeGreaterThanOrEqual(14.39);
    expect(16 * scale * readableNodeSize(scale)).toBeLessThanOrEqual(18);
    expect(330 * scale * readableNodeSize(scale, true)).toBeCloseTo(330);
  }
});

test("group skeleton counts cover each visible source once without changing geometry", () => {
  const node = (id: string, x: number) => ({ conversationId: id, x, y: 0, width: 200, height: 96, depth: 0 });
  const scene: ConversationGraphScene = { nodes: [node("a", -200), node("b", 100), node("c", 500)], groups: [], edges: [], width: 700, height: 96 };
  const before = structuredClone(scene);
  const territories = buildMapTerritories(scene, {
    research: { id: "research", name: "Research", color: "#888", collapsed: false, conversationIds: ["a", "b", "b", "removed"] },
    overlap: { id: "overlap", name: "Overlap", color: "#777", collapsed: false, conversationIds: ["b"] },
  });
  expect(territories.map((territory) => [territory.label, territory.nodes.length])).toEqual([["Research", 2], ["Ungrouped", 1]]);
  expect(scene).toEqual(before);
  expect(territoryConnections(territories, { a: { parentId: null, linkedConversationIds: ["c"] }, b: { parentId: "a" }, c: { parentId: null, linkedConversationIds: ["a"] } })).toHaveLength(1);
});

test("extreme zoom keeps group labels apart and panning moves them together", () => {
  const territories = Array.from({ length: 50 }, (_, i) => ({ id: String(i), label: String(i), color: "#888", nodes: [], x: i, y: 0 }));
  const before = placeMapTerritories(territories, { x: 0, y: 0, scale: 0.02 });
  const after = placeMapTerritories(territories, { x: 100, y: -80, scale: 0.02 });
  for (let i = 0; i < before.length; i++) {
    expect(after[i].screenX - before[i].screenX).toBe(100);
    expect(after[i].screenY - before[i].screenY).toBe(-80);
    for (let j = i + 1; j < before.length; j++) {
      expect(Math.abs(before[i].screenX - before[j].screenX) >= 224 || Math.abs(before[i].screenY - before[j].screenY) >= 156).toBe(true);
    }
  }
});

test("dense labels trigger aggregation before their readable footprints collide", () => {
  const nodes = [0, 220].map((x, i) => ({ conversationId: String(i), x, y: 0, width: 200, height: 96, depth: 0 }));
  expect(mapLabelsOverlap(nodes, 0.75)).toBe(true);
  expect(mapLabelsOverlap(nodes, 1)).toBe(false);
});

const fitTerritory = (): MapTerritory => ({
  id: "research", label: "Research", color: "#888", x: -260, y: 200,
  nodes: [
    { conversationId: "first", x: -2100, y: -240, width: 240, height: 100, depth: 0 },
    { conversationId: "second", x: -500, y: 120, width: 330, height: 180, depth: 0 },
    { conversationId: "last", x: 1800, y: 540, width: 260, height: 90, depth: 0 },
  ],
});

test("territory bounds include whole nodes instead of averaging their centers", () => {
  expect(getMapTerritoryBounds(fitTerritory())).toEqual({ x: -2100, y: -240, width: 4160, height: 870 });
  expect(getMapTerritoryBounds({ ...fitTerritory(), nodes: [] })).toEqual({ x: -260, y: 200, width: 0, height: 0 });
});

test("group fit keeps readable cards and their region heading inside desktop and mobile canvases", () => {
  const territory = fitTerritory();
  const original = structuredClone(territory);
  for (const canvas of [{ width: 1100, height: 640 }, { width: 390, height: 500 }]) {
    const viewport = fitMapTerritory(territory, canvas, { selectedNodeId: "first" });
    const bounds = getMapTerritoryScreenBounds(territory, viewport, "first");
    expect(viewport.scale).toBeGreaterThan(0);
    expect(viewport.scale).toBeLessThanOrEqual(1.15);
    expect(bounds.x).toBeGreaterThanOrEqual(23.999);
    expect(bounds.y).toBeGreaterThanOrEqual(23.999);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(canvas.width - 23.999);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(canvas.height - 23.999);
  }
  expect(territory).toEqual(original);
});

test("compact group fit handles very distant nodes without imposing a cropping zoom floor", () => {
  const territory = fitTerritory();
  territory.nodes[2].x = 1000000;
  const canvas = { width: 280, height: 400 };
  const nodeFootprint = { width: 120, height: 60 };
  const viewport = fitMapTerritory(territory, canvas, { nodeFootprint, maxScale: 0.69 });
  const bounds = getMapTerritoryScreenBounds(territory, viewport, null, nodeFootprint);
  expect(viewport.scale).toBeGreaterThan(0);
  expect(viewport.scale).toBeLessThan(0.02);
  expect(bounds.x).toBeCloseTo(24);
  expect(bounds.x + bounds.width).toBeCloseTo(canvas.width - 24);
  expect(bounds.y).toBeGreaterThan(24);
  expect(bounds.y + bounds.height).toBeLessThan(canvas.height - 24);
});

test("all-groups fit includes every region and respects the overview zoom ceiling", () => {
  const first = fitTerritory();
  const second = { ...fitTerritory(), id: "other", nodes: fitTerritory().nodes.map((node) => ({ ...node, y: node.y + 2400 })) };
  const canvas = { width: 700, height: 500 };
  const nodeFootprint = { width: 120, height: 60 };
  const viewport = fitMapTerritories([first, second], canvas, { nodeFootprint, maxScale: 0.6 });
  expect(viewport.scale).toBeLessThanOrEqual(0.6);
  for (const territory of [first, second]) {
    const bounds = getMapTerritoryScreenBounds(territory, viewport, null, nodeFootprint);
    expect(bounds.x).toBeGreaterThanOrEqual(23.999);
    expect(bounds.y).toBeGreaterThanOrEqual(23.999);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(canvas.width - 23.999);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(canvas.height - 23.999);
  }
});

test("regions pan with the map and stay anchored to the same node geometry", () => {
  const territory = fitTerritory();
  const before = getMapTerritoryScreenBounds(territory, { x: 0, y: 0, scale: 0.4 });
  const after = getMapTerritoryScreenBounds(territory, { x: 90, y: -50, scale: 0.4 });
  expect(after).toEqual({ ...before, x: before.x + 90, y: before.y - 50 });
  const node = territory.nodes[0];
  const leftEdge = (node.x + node.width / 2) * 0.4 - node.width * 0.9 / 2;
  expect(before.x).toBeLessThan(leftEdge);
});

test("single, empty and unmeasured group fits return a usable finite camera", () => {
  const single = { ...fitTerritory(), nodes: [fitTerritory().nodes[0]] };
  expect(fitMapTerritory(single, { width: 1200, height: 800 }).scale).toBeCloseTo(1.15);
  for (const territories of [[], [single]]) {
    for (const canvas of [{ width: 0, height: 0 }, { width: 120, height: 80 }]) {
      const viewport = fitMapTerritories(territories, canvas);
      expect(Number.isFinite(viewport.x)).toBe(true);
      expect(Number.isFinite(viewport.y)).toBe(true);
      expect(viewport.scale).toBeGreaterThan(0);
      expect(Number.isFinite(viewport.scale)).toBe(true);
    }
  }
});

test("overlapping region headings remain separately clickable and pan together", () => {
  const regions = Array.from({ length: 12 }, (_, index) => ({ x: 30 + index * 2, y: 20 + index * 3, width: 240, height: 180 }));
  const original = structuredClone(regions);
  for (const mode of ["canvas", "overview"] as const) {
    const before = placeMapTerritoryHeadings(regions, mode);
    const after = placeMapTerritoryHeadings(regions.map((region) => ({ ...region, x: region.x - 100, y: region.y + 50 })), mode);
    for (let i = 0; i < before.length; i++) {
      expect(after[i]).toEqual({ ...before[i], x: before[i].x - 100, y: before[i].y + 50 });
      for (let j = i + 1; j < before.length; j++) {
        const a = before[i], b = before[j];
        expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
      }
    }
  }
  expect(regions).toEqual(original);
});

test("a focused heading stays inside its fitted region while neighbor labels avoid the cards", () => {
  const regions = Array.from({ length: 12 }, (_, index) => ({ x: 30 + index * 2, y: 20 + index * 3, width: 160, height: 180 }));
  const priorityIndex = 11;
  const focus = regions[priorityIndex];
  const obstacles = [{ x: 50, y: 145, width: 200, height: 70 }];
  const headings = placeMapTerritoryHeadings(regions, "canvas", { priorityIndex, obstacles });
  expect(headings[priorityIndex]).toMatchObject({ x: focus.x + 12, y: focus.y + 10 });
  for (let index = 0; index < headings.length; index++) {
    const a = headings[index];
    for (const b of [...headings.slice(index + 1), ...obstacles]) {
      expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
    }
  }
});

test("dense groups use readable temporary cards without changing their saved geometry", () => {
  const nodes = Array.from({ length: 12 }, (_, index) => ({ conversationId: String(index), x: (index % 4) * 320, y: Math.floor(index / 4) * 220, width: 250, height: 96, depth: 0 }));
  const territory = { id: "dense", label: "Dense", color: "#888", nodes, x: 0, y: 0 };
  const before = structuredClone(nodes);
  const canvas = { width: 390, height: 640 };
  const displayed = layoutFocusedMapTerritory(territory, canvas, { padding: 64 });
  expect(displayed.arranged).toBe(true);
  expect(displayed.nodeFootprint!.width).toBeGreaterThanOrEqual(140);
  expect(displayed.nodeFootprint!.height).toBe(88);
  expect(mapLabelsOverlap(displayed.territory.nodes, displayed.viewport.scale, displayed.nodeFootprint)).toBe(false);
  const bounds = getMapTerritoryScreenBounds(displayed.territory, displayed.viewport, null, displayed.nodeFootprint);
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  // A long phone group begins at its first row and remains available by pan.
  expect(bounds.y).toBeLessThan(64);
  expect(bounds.height).toBeGreaterThan(canvas.height);
  expect(nodes).toEqual(before);
  expect(fitFocusedMapTerritory(territory, canvas, { padding: 64 })).toEqual(displayed.viewport);
  expect(layoutFocusedMapTerritory(territory, canvas, { padding: 64 })).toEqual(displayed);
});

test("a desktop dense group fits all named cards while a small group retains authored positions", () => {
  const territory = { ...fitTerritory(), nodes: Array.from({ length: 25 }, (_, index) => ({
    conversationId: String(index), x: index * 2, y: index * 3, width: 200, height: 96, depth: 0,
  })) };
  const canvas = { width: 1000, height: 700 };
  const displayed = layoutFocusedMapTerritory(territory, canvas);
  expect(displayed.arranged).toBe(true);
  expect(mapLabelsOverlap(displayed.territory.nodes, displayed.viewport.scale, displayed.nodeFootprint)).toBe(false);
  const bounds = getMapTerritoryScreenBounds(displayed.territory, displayed.viewport, null, displayed.nodeFootprint);
  expect(bounds.x).toBeGreaterThanOrEqual(24);
  expect(bounds.y).toBeGreaterThanOrEqual(24);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(canvas.width - 24);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(canvas.height - 24);
  const small = { ...territory, nodes: [{ ...territory.nodes[0], x: 0 }, { ...territory.nodes[1], x: 400 }] };
  const unchanged = layoutFocusedMapTerritory(small, canvas);
  expect(unchanged.arranged).toBe(false);
  expect(unchanged.territory.nodes).toEqual(small.nodes);
});

test("coincident cards receive a readable layout even when the authored group fits at maximum zoom", () => {
  const territory = { ...fitTerritory(), nodes: Array.from({ length: 8 }, (_, index) => ({
    conversationId: String(index), x: 0, y: 0, width: 200, height: 96, depth: 0,
  })) };
  const canvas = { width: 1000, height: 700 };
  expect(fitMapTerritory(territory, canvas).scale).toBeCloseTo(1.15);
  const displayed = layoutFocusedMapTerritory(territory, canvas);
  expect(displayed.arranged).toBe(true);
  expect(mapLabelsOverlap(displayed.territory.nodes, displayed.viewport.scale, displayed.nodeFootprint)).toBe(false);
});

const overlappingTerritories = (count: number): MapTerritory[] => Array.from({ length: count }, (_, index) => ({
  id: String(index), label: String(index), color: "#888", x: index * 5, y: index * 5,
  nodes: [{ conversationId: String(index), x: index * 5, y: index * 5, width: 200, height: 96, depth: 0 }],
}));

test("many nearby groups fit phone heading columns without collapsing the camera", () => {
  for (const count of [8, 12, 16]) {
    const territories = overlappingTerritories(count);
    const canvas = { width: 390, height: 844 };
    const camera = fitMapTerritories(territories, canvas, { maxScale: 0.65, nodeFootprint: OVERVIEW_NODE_FOOTPRINT });
    expect(camera.scale).toBeCloseTo(0.65);
    const regions = territories.map((territory) => getMapTerritoryScreenBounds(territory, camera, null, OVERVIEW_NODE_FOOTPRINT));
    const headings = placeMapTerritoryHeadings(regions, "overview", { maxWidth: mapTerritoryHeadingWidth(canvas.width) });
    for (let index = 0; index < headings.length; index++) {
      const a = headings[index];
      expect(a.x).toBeGreaterThanOrEqual(24);
      expect(a.x + a.width).toBeLessThanOrEqual(canvas.width - 24);
      expect(a.y).toBeGreaterThanOrEqual(24);
      expect(a.y + a.height).toBeLessThanOrEqual(canvas.height - 24);
      for (const b of headings.slice(index + 1)) {
        expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
      }
    }
  }
});

test("more labels than can fit and very short canvases preserve a useful spatial scale", () => {
  const territories = overlappingTerritories(50);
  const crowded = fitMapTerritories(territories, { width: 390, height: 400 }, { maxScale: 0.65, nodeFootprint: OVERVIEW_NODE_FOOTPRINT });
  expect(crowded.scale).toBeGreaterThan(0.1);
  const short = fitMapTerritory(fitTerritory(), { width: 390, height: 80 }, { nodeFootprint: OVERVIEW_NODE_FOOTPRINT });
  expect(short.scale).toBeGreaterThan(0.00001);
  expect(Number.isFinite(short.x)).toBe(true);
  expect(Number.isFinite(short.y)).toBe(true);
});

test("overview boxes contain readable summaries without overlap or changing saved member positions", () => {
  const territories = overlappingTerritories(9);
  const before = structuredClone(territories);
  for (const canvas of [{ width: 841, height: 564 }, { width: 390, height: 844 }]) {
    const camera = fitMapTerritoryOverview(territories, canvas, { padding: 64 });
    const placements = layoutMapTerritoryOverview(territories, camera, canvas.width);
    expect(camera.scale).toBeGreaterThan(0.4);
    expect(camera.scale).toBeLessThan(0.7);
    expect(placements.map((item) => item.id)).toEqual(territories.map((item) => item.id));
    for (let index = 0; index < placements.length; index++) {
      const { bounds: a, nodes, screenX, screenY } = placements[index];
      expect(nodes).toEqual(territories[index].nodes);
      expect(a.width).toBeGreaterThanOrEqual(160);
      expect(a.height).toBeGreaterThanOrEqual(120);
      expect(a.x).toBeGreaterThanOrEqual(23.999);
      expect(a.x + a.width).toBeLessThanOrEqual(canvas.width - 23.999);
      expect(a.y).toBeGreaterThanOrEqual(63.999);
      expect(a.y + a.height).toBeLessThanOrEqual(canvas.height - 63.999);
      expect(screenX).toBeCloseTo(a.x + a.width / 2);
      expect(screenY).toBeCloseTo(a.y + a.height / 2);
      for (const { bounds: b } of placements.slice(index + 1)) {
        expect(a.x + a.width < b.x || b.x + b.width < a.x || a.y + a.height < b.y || b.y + b.height < a.y).toBe(true);
      }
    }
  }
  expect(territories).toEqual(before);
});

test("overview keeps semantic neighbors adjacent across rows and translates exactly when panning", () => {
  const territories = overlappingTerritories(12).reverse();
  const first = layoutMapTerritoryOverview(territories, { x: 0, y: 0, scale: 0.65 }, 900);
  const panned = layoutMapTerritoryOverview(territories, { x: 135, y: -80, scale: 0.65 }, 900);
  const zoomed = layoutMapTerritoryOverview(territories, { x: 0, y: 0, scale: 0.2 }, 900);
  for (let index = 0; index < first.length; index++) {
    const a = first[index];
    expect(panned[index].bounds).toEqual({ ...a.bounds, x: a.bounds.x + 135, y: a.bounds.y - 80 });
    expect(panned[index].screenX).toBeCloseTo(a.screenX + 135);
    expect(panned[index].screenY).toBeCloseTo(a.screenY - 80);
    const b = first[index + 1];
    if (!b) continue;
    // A row turn stays on the same column; neighbors never jump to the far edge.
    expect(a.screenX === b.screenX || a.screenY === b.screenY).toBe(true);
    expect(a.screenX === b.screenX ? Math.abs(a.screenY - b.screenY) : Math.abs(a.screenX - b.screenX))
      .toBeCloseTo((a.screenX === b.screenX ? a.bounds.height : a.bounds.width) + 20);
    expect(zoomed[index].screenX === zoomed[index + 1].screenX).toBe(a.screenX === b.screenX);
  }
});

test("crowded overview starts at readable first row and permits pan to the last group", () => {
  const territories = overlappingTerritories(25);
  const canvas = { width: 390, height: 500 };
  const camera = fitMapTerritoryOverview(territories, canvas, { padding: 64 });
  const placements = layoutMapTerritoryOverview(territories, camera, canvas.width);
  expect(camera.scale).toBe(0.5);
  expect(placements[0].bounds.y).toBe(64);
  const last = placements.at(-1)!;
  expect(last.bounds.y).toBeGreaterThan(canvas.height);
  const panned = layoutMapTerritoryOverview(territories, { ...camera, y: camera.y + 64 - last.bounds.y }, canvas.width);
  expect(panned.at(-1)!.bounds.y).toBe(64);
  expect(panned.at(-1)!.bounds.height).toBe(120);
  expect(fitMapTerritoryOverview(territories, canvas, { padding: 64 })).toEqual(camera);
});

test("overview cameras remain finite before measurement and honor the overview scale ceiling", () => {
  for (const territories of [[], overlappingTerritories(1), overlappingTerritories(50)]) {
    for (const canvas of [{ width: 0, height: 0 }, { width: 120, height: 80 }]) {
      const camera = fitMapTerritoryOverview(territories, canvas, { maxScale: 1.5 });
      expect(Number.isFinite(camera.x)).toBe(true);
      expect(Number.isFinite(camera.y)).toBe(true);
      expect(camera.scale).toBeGreaterThan(0);
      expect(camera.scale).toBeLessThan(0.7);
    }
  }
});

function territoriesWithDocumentCounts(counts: number[]): MapTerritory[] {
  return overlappingTerritories(counts.length).map((territory, index) => ({ ...territory,
    nodes: Array.from({ length: counts[index] }, (_, document) => ({ ...territory.nodes[0], conversationId: `${index}:${document}` })),
  }));
}

test("overview box area communicates document counts while preserving readable summary minima", () => {
  const territories = territoriesWithDocumentCounts([1, 2, 8, 32, 1000]);
  const original = structuredClone(territories);
  for (const scale of [0.01, 0.1, 0.65]) {
    const placements = layoutMapTerritoryOverview(territories, { x: 0, y: 0, scale }, 1024);
    const area = (index: number) => placements[index].bounds.width * placements[index].bounds.height;
    expect(area(1)).toBeGreaterThan(area(0));
    expect(area(2)).toBeGreaterThan(area(0) * 1.5);
    expect(area(3)).toBeGreaterThan(area(2));
    expect(area(4)).toBeGreaterThanOrEqual(area(3));
    expect(placements[0].bounds.width).toBeGreaterThanOrEqual(160);
    expect(placements[0].bounds.height).toBeGreaterThanOrEqual(120);
  }
  expect(territories).toEqual(original);
});

test("nine mixed-size group boxes fit desktop canvases and retain semantic order without overlap", () => {
  const territories = territoriesWithDocumentCounts([8, 1, 6, 2, 12, 3, 3, 1, 24]);
  for (const canvas of [{ width: 751, height: 678 }, { width: 1024, height: 678 }]) {
    const camera = fitMapTerritoryOverview(territories, canvas, { padding: 64 });
    const placements = layoutMapTerritoryOverview(territories, camera, canvas.width);
    expect(placements.map((item) => item.id)).toEqual(territories.map((item) => item.id));
    const panned = layoutMapTerritoryOverview(territories, { ...camera, x: camera.x + 113, y: camera.y - 89 }, canvas.width);
    for (let index = 0; index < placements.length; index++) {
      const a = placements[index].bounds;
      expect(a.x).toBeGreaterThanOrEqual(23.999);
      expect(a.x + a.width).toBeLessThanOrEqual(canvas.width - 23.999);
      expect(a.y).toBeGreaterThanOrEqual(63.999);
      expect(a.y + a.height).toBeLessThanOrEqual(canvas.height - 63.999);
      expect(panned[index].bounds.x).toBeCloseTo(a.x + 113);
      expect(panned[index].bounds.y).toBeCloseTo(a.y - 89);
      expect(panned[index].bounds.width).toBe(a.width);
      expect(panned[index].bounds.height).toBe(a.height);
      for (const { bounds: b } of placements.slice(index + 1)) {
        expect(a.x + a.width < b.x || b.x + b.width < a.x || a.y + a.height < b.y || b.y + b.height < a.y).toBe(true);
      }
    }
    const large = placements[0].bounds, small = placements[1].bounds;
    expect(large.width * large.height).toBeGreaterThan(small.width * small.height * 1.5);
  }
});

test("count-weighted phone boxes keep readable sizes and the last group remains reachable by pan", () => {
  const territories = territoriesWithDocumentCounts([8, 1, 6, 2, 12, 3, 3, 1, 24]);
  const canvas = { width: 390, height: 500 };
  const camera = fitMapTerritoryOverview(territories, canvas);
  const placements = layoutMapTerritoryOverview(territories, camera, canvas.width);
  expect(camera.scale).toBeGreaterThan(0);
  expect(camera.scale).toBeLessThan(0.65);
  expect(placements[0].bounds.y).toBeCloseTo(24);
  for (let index = 0; index < placements.length; index++) {
    const a = placements[index].bounds;
    expect(a.x).toBeGreaterThanOrEqual(24);
    expect(a.x + a.width).toBeLessThanOrEqual(canvas.width - 24);
    expect(a.height).toBeGreaterThanOrEqual(120);
    for (const { bounds: b } of placements.slice(index + 1)) {
      expect(a.x + a.width < b.x || b.x + b.width < a.x || a.y + a.height < b.y || b.y + b.height < a.y).toBe(true);
    }
  }
  const last = placements.at(-1)!.bounds;
  expect(last.y).toBeGreaterThan(canvas.height);
  const panned = layoutMapTerritoryOverview(territories, { ...camera, y: camera.y + 24 - last.y }, canvas.width);
  expect(panned.at(-1)!.bounds.y).toBeCloseTo(24);
  expect(panned.at(-1)!.bounds.height).toBe(last.height);
});

test("zoom reveals readable document grids inside every group without isolating or moving saved nodes", () => {
  const territories = territoriesWithDocumentCounts([1, 8, 3]);
  const original = structuredClone(territories);
  for (const canvasWidth of [751, 390]) {
    for (const scale of [0.39, 0.4, 0.5, 0.65, 0.75, 1.2]) {
      const camera = { x: 163, y: 91, scale };
      const placements = layoutMapTerritoryOverview(territories, camera, canvasWidth);
      expect(placements.map((item) => item.id)).toEqual(territories.map((item) => item.id));
      const panned = layoutMapTerritoryOverview(territories, { ...camera, x: 33, y: 188 }, canvasWidth);
      for (let index = 0; index < placements.length; index++) {
        const group = placements[index];
        expect(group.nodes).toEqual(territories[index].nodes);
        expect(panned[index].displayNodes).toEqual(group.displayNodes);
        expect(group.contentsVisible).toBe(scale >= 0.4);
        if (scale < 0.4) { expect(group.displayNodes).toEqual([]); continue; }
        expect(group.displayNodes.map((node) => node.conversationId)).toEqual(group.nodes.map((node) => node.conversationId));
        expect(group.nodeFootprint.width).toBeGreaterThanOrEqual(72);
        expect(group.nodeFootprint.height).toBeGreaterThanOrEqual(38.4);
        expect(group.nodeFootprint.titleFontSize).toBeCloseTo(Math.min(13, 20 * scale));
        expect(group.headerBounds.x).toBeGreaterThan(group.bounds.x);
        expect(group.headerBounds.y).toBeGreaterThan(group.bounds.y);
        expect(group.headerBounds.x + group.headerBounds.width).toBeLessThan(group.bounds.x + group.bounds.width);
        const cards = group.displayNodes.map((node) => ({
          x: camera.x + (node.x + node.width / 2) * scale - group.nodeFootprint.width / 2,
          y: camera.y + (node.y + node.height / 2) * scale - group.nodeFootprint.height / 2,
          ...group.nodeFootprint,
        }));
        for (let cardIndex = 0; cardIndex < cards.length; cardIndex++) {
          const card = cards[cardIndex];
          expect(card.x).toBeGreaterThan(group.bounds.x);
          expect(card.x + card.width).toBeLessThan(group.bounds.x + group.bounds.width);
          expect(card.y).toBeGreaterThanOrEqual(group.bounds.y + 35.199);
          expect(card.y).toBeGreaterThan(group.headerBounds.y + group.headerBounds.height);
          expect(card.y + card.height).toBeLessThan(group.bounds.y + group.bounds.height);
          for (const other of cards.slice(cardIndex + 1)) {
            expect(card.x + card.width < other.x || other.x + other.width < card.x || card.y + card.height < other.y || other.y + other.height < card.y).toBe(true);
          }
        }
      }
      for (let index = 0; index < placements.length; index++) {
        const a = placements[index].bounds;
        for (const { bounds: b } of placements.slice(index + 1)) {
          expect(a.x + a.width < b.x || b.x + b.width < a.x || a.y + a.height < b.y || b.y + b.height < a.y).toBe(true);
        }
      }
    }
  }
  expect(territories).toEqual(original);
});

test("group box geometry stays continuous as document titles appear during zoom", () => {
  const territories = territoriesWithDocumentCounts([1, 8, 3, 14]);
  const below = layoutMapTerritoryOverview(territories, { x: 0, y: 0, scale: 0.399999 }, 751);
  const above = layoutMapTerritoryOverview(territories, { x: 0, y: 0, scale: 0.400001 }, 751);
  for (let index = 0; index < below.length; index++) {
    expect(below[index].contentsVisible).toBe(false);
    expect(above[index].contentsVisible).toBe(true);
    for (const axis of ["x", "y", "width", "height"] as const) {
      expect(Math.abs(above[index].bounds[axis] - below[index].bounds[axis])).toBeLessThan(0.01);
    }
  }
  const canvas = { width: 751, height: 678 };
  const fitted = fitMapTerritoryOverview(territories, canvas);
  const initial = layoutMapTerritoryOverview(territories, fitted, canvas.width);
  expect(initial.every((group) => group.contentsVisible === (fitted.scale >= 0.4))).toBe(true);
  expect(initial.flatMap((group) => group.displayNodes).length).toBe(fitted.scale >= 0.4
    ? territories.reduce((count, group) => count + group.nodes.length, 0) : 0);
});
