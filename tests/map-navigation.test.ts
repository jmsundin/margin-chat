import { describe, expect, test } from "bun:test";
import { createMainConversation } from "../client/src/initialState";
import { layoutGravityClusters } from "../client/src/lib/gravityClusters";
import { mapColoring } from "../client/src/lib/mapColorBy";
import { countConnections, describeLensFilter, matchMapLens, newLensFilter, readMapLens } from "../client/src/lib/mapLens";
import { bundleLinks, edgeSignposts, interpolateViewport, isBigCameraMove, nextInDirection, placeLandmarks, readingOrder } from "../client/src/lib/mapNavigation";
import { readMapPlaces, rememberMapPlaces, stabilizeClusterLayout } from "../client/src/lib/mapPlaces";
import type { Conversation } from "../client/src/types";
import { buildSyntheticVault } from "./helpers/syntheticVault";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-16T12:00:00Z");
const size = { width: 1000, height: 600 };

describe("map camera trail", () => {
  test("remembers moves of most of a screen or big zooms, not nudges", () => {
    const start = { x: 0, y: 0, scale: 1 };
    expect(isBigCameraMove(start, { x: -200, y: 0, scale: 1 }, size)).toBe(false);
    expect(isBigCameraMove(start, { x: -600, y: 0, scale: 1 }, size)).toBe(true);
    expect(isBigCameraMove(start, { x: 0, y: 0, scale: 1.5 }, size)).toBe(false);
    expect(isBigCameraMove(start, { x: 0, y: 0, scale: 3 }, size)).toBe(true);
  });

  test("a flight starts and ends on the given cameras", () => {
    const from = { x: 0, y: 0, scale: 1 }, to = { x: -400, y: 100, scale: 0.25 };
    expect(interpolateViewport(from, to, size, 0)).toEqual(from);
    const end = interpolateViewport(from, to, size, 1);
    expect(end.scale).toBeCloseTo(to.scale);
    expect(end.x).toBeCloseTo(to.x);
    expect(end.y).toBeCloseTo(to.y);
  });
});

describe("keyboard travel", () => {
  const candidates = [
    { id: "right-near", x: 200, y: 20 }, { id: "right-far", x: 600, y: 0 }, { id: "right-steep", x: 50, y: 300 },
    { id: "up", x: 10, y: -200 }, { id: "left", x: -300, y: 40 },
  ];
  test("each arrow picks the nearest document roughly in its direction", () => {
    const origin = { x: 0, y: 0 };
    expect(nextInDirection(origin, candidates, "right")).toBe("right-near");
    expect(nextInDirection(origin, candidates, "up")).toBe("up");
    expect(nextInDirection(origin, candidates, "left")).toBe("left");
    expect(nextInDirection(origin, candidates, "down")).toBe("right-steep");
    expect(nextInDirection(origin, [{ id: "behind", x: -10, y: 0 }], "right")).toBeNull();
  });

  test("matches are stepped through row by row", () => {
    const order = readingOrder([{ id: "b", x: 500, y: 10 }, { id: "c", x: 0, y: 400 }, { id: "a", x: 20, y: 60 }], 200);
    expect(order.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });
});

describe("edge signposts", () => {
  const inset = { top: 50, right: 20, bottom: 60, left: 20 };
  test("only documents off screen get one, pinned to the edge facing them", () => {
    const posts = edgeSignposts([{ id: "on", x: 500, y: 300 }, { id: "east", x: 3000, y: 300 }, { id: "north", x: 500, y: -900 }], size, inset);
    expect(posts.map((post) => post.ids)).toEqual([["north"], ["east"]]);
    const east = posts.find((post) => post.ids[0] === "east")!;
    expect(east.x).toBeCloseTo(size.width - inset.right);
    expect(east.angle).toBeCloseTo(0);
    const north = posts.find((post) => post.ids[0] === "north")!;
    expect(north.y).toBeCloseTo(inset.top);
  });

  test("documents off the same stretch of edge merge into one", () => {
    const posts = edgeSignposts([{ id: "a", x: 3000, y: 290 }, { id: "b", x: 3000, y: 320 }, { id: "c", x: -2000, y: 300 }], size, inset);
    expect(posts.map((post) => post.ids.sort())).toEqual([["a", "b"], ["c"]]);
  });
});

describe("landmarks", () => {
  test("bigger regions claim space first and overlapping labels wait", () => {
    const viewport = { x: 0, y: 0, scale: 1 };
    const placed = placeLandmarks([
      { id: "small", x: 105, y: 100, label: "Small note", priority: 1 },
      { id: "big", x: 100, y: 100, label: "Big family", priority: 10, region: true },
      { id: "far", x: 600, y: 400, label: "Elsewhere", priority: 2 },
      { id: "off", x: 5000, y: 100, label: "Off screen", priority: 50 },
    ], viewport, size);
    expect(placed.map((item) => item.id)).toEqual(["big", "far"]);
  });
});

describe("bundled lines", () => {
  test("lines between two regions become one strand weighted by count; lines within a region drop", () => {
    const point = { a1: { x: 0, y: 0 }, a2: { x: 10, y: 0 }, b1: { x: 500, y: 0 }, b2: { x: 520, y: 20 }, c1: { x: 0, y: 900 } } as Record<string, { x: number; y: number }>;
    const region = (id: string) => id[0];
    const bundles = bundleLinks([["a1", "b1"], ["a2", "b2"], ["b1", "a1"], ["a1", "a2"], ["c1", "a1"]], region, (id) => point[id]);
    expect(bundles.map((bundle) => [bundle.id, bundle.count])).toEqual([["a\nb", 3], ["a\nc", 1]]);
    expect(bundles[0].from).toEqual({ x: 5, y: 0 });
    expect(bundles[0].to).toEqual({ x: 510, y: 10 });
  });
});

function documents() {
  const conversations: Record<string, Conversation> = {};
  const add = (id: string, daysAgo: number, patch: Partial<Conversation> = {}) => {
    const at = new Date(NOW - daysAgo * DAY).toISOString();
    conversations[id] = { ...createMainConversation({ id, createdAt: at }), title: id, updatedAt: at, ...patch };
  };
  add("fresh", 2, { tags: ["work"] });
  add("month", 20, { tags: ["work", "home"] });
  add("old", 800, { tags: ["home"] });
  add("plain", 100);
  return conversations;
}

describe("color by", () => {
  test("age colors recent work warm and old work cool, with a legend that filters", () => {
    const conversations = documents();
    const coloring = mapColoring(Object.keys(conversations), "edited", { conversations, groups: {}, connectionCounts: new Map(), now: NOW })!;
    expect(coloring.colorOf.get("fresh")).not.toBe(coloring.colorOf.get("old"));
    expect(coloring.legend.map((item) => [item.label, item.count])).toEqual([["Past week", 1], ["Past month", 1], ["Past year", 1], ["Older", 1]]);
    const week = coloring.legend[0].filter!;
    expect([...matchMapLens(Object.keys(conversations), { filters: [week] }, { conversations, groups: {}, connectionCounts: new Map() })!]).toEqual(["fresh"]);
    const month = coloring.legend[1].filter!;
    expect([...matchMapLens(Object.keys(conversations), { filters: [month] }, { conversations, groups: {}, connectionCounts: new Map() })!]).toEqual(["month"]);
  });

  test("tags color by the most used tag, and untagged documents stay neutral", () => {
    const conversations = documents();
    const coloring = mapColoring(Object.keys(conversations), "tag", { conversations, groups: {}, connectionCounts: new Map(), now: NOW })!;
    // "work" and "home" are used twice each; "home" wins the tie alphabetically, so "month" (both) is home-colored.
    expect(coloring.colorOf.get("month")).toBe(coloring.colorOf.get("old")!);
    expect(coloring.colorOf.get("plain")).toBeNull();
    expect(coloring.legend.map((item) => item.label)).toEqual(["#home", "#work", "No tags"]);
  });

  test("family coloring is left to the map", () => {
    const conversations = documents();
    expect(mapColoring(Object.keys(conversations), "family", { conversations, groups: {}, connectionCounts: new Map() })).toBeNull();
  });
});

describe("near filter", () => {
  test("keeps documents within the chosen steps and survives a reload", () => {
    const conversations = documents();
    const filter = { ...newLensFilter("near", NOW, "fresh"), depth: 2 } as Extract<ReturnType<typeof newLensFilter>, { kind: "near" }>;
    const neighborhood = (id: string, depth: number) => new Set(depth >= 2 ? [id, "month", "old"] : [id, "month"]);
    const matched = matchMapLens(Object.keys(conversations), { filters: [filter] }, { conversations, groups: {}, connectionCounts: countConnections([]), neighborhood })!;
    expect([...matched].sort()).toEqual(["fresh", "month", "old"]);
    expect(describeLensFilter(filter, {}, conversations)).toBe("Within 2 steps of fresh");
    expect(readMapLens(JSON.parse(JSON.stringify({ filters: [filter] }))).filters).toHaveLength(1);
    expect(readMapLens({ filters: [{ ...filter, documentId: 4 }] }).filters).toHaveLength(0);
  });
});

describe("stable places", () => {
  const node = (conversationId: string) => ({ conversationId, depth: 0, x: 0, y: 0, width: 180, height: 96 });
  const canvas = { width: 1200, height: 800 };

  test("adding documents and a new cluster leaves existing documents where they were", () => {
    const vault = buildSyntheticVault(600, { seed: 3 });
    const before = layoutGravityClusters(vault.ids.map(node), canvas, vault.connections);
    const places = readMapPlaces(JSON.parse(JSON.stringify(rememberMapPlaces(before))));
    const added = ["new-hub", "new-1", "new-2", "new-3", "extra"];
    const connections = [...vault.connections, { sourceId: "new-hub", targetId: "new-1" }, { sourceId: "new-hub", targetId: "new-2" },
      { sourceId: "new-hub", targetId: "new-3" }, { sourceId: "new-hub", targetId: vault.ids[0] }, { sourceId: vault.ids[1], targetId: "extra" }];
    const fresh = layoutGravityClusters([...vault.ids, ...added].map(node), canvas, connections);
    const stable = stabilizeClusterLayout(fresh, places, connections, canvas);
    const position = (layout: typeof before) => new Map(layout.nodes.map((placement) => [placement.conversationId, `${Math.round(placement.x)},${Math.round(placement.y)}`]));
    const was = position(before), freshly = position(fresh), now = position(stable);
    const unchanged = (map: Map<string, string>) => vault.ids.filter((id) => map.get(id) === was.get(id)).length / vault.ids.length;
    // Laying out afresh moves most documents; keeping places leaves nearly all of them put.
    expect(unchanged(freshly)).toBeLessThan(0.5);
    expect(unchanged(now)).toBeGreaterThan(0.9);
    // Nothing overlaps: every pair of clusters keeps clear of each other.
    for (const [index, a] of stable.clusters.entries()) for (const b of stable.clusters.slice(index + 1)) {
      expect(Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y)).toBeGreaterThan(a.radius + b.radius - 1);
    }
    expect(stable.nodes.find((placement) => placement.conversationId === "new-hub")).toBeTruthy();
  });

  test("a layout with little in common with the remembered one is used as is", () => {
    const vault = buildSyntheticVault(200, { seed: 5 });
    const layout = layoutGravityClusters(vault.ids.map(node), canvas, vault.connections);
    expect(stabilizeClusterLayout(layout, { islands: [{ id: "elsewhere", x: 0, y: 0, members: ["gone"] }] }, vault.connections, canvas)).toBe(layout);
  });
});
