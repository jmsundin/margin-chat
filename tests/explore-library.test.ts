import { describe, expect, test } from "bun:test";
import { buildLibrary, groupLinks, LIBRARY_ROOT_ID, libraryPath, packCircles, packLibrary, pathToNote, squarify, type LibraryInput } from "../client/src/lib/exploreLibrary";

const notes = (prefix: string, count: number) => Array.from({ length: count }, (_, at) => `${prefix}${at}`);
const input = (overrides: Partial<LibraryInput> = {}): LibraryInput => ({
  themes: [{ id: "t-aging", label: "Biology of aging", color: "red", boxIds: ["b-senescence", "b-mito"] }],
  boxes: [
    { id: "b-senescence", label: "Cellular senescence", color: "red", kind: "group", conversationIds: [...notes("s", 6), "loose"],
      blocks: [{ id: "k-drugs", kind: "alike", conversationIds: notes("s", 4) }, { id: "k-family", kind: "family", conversationIds: ["s4", "s5"] }] },
    { id: "b-mito", label: "Mitochondria", color: "blue", kind: "group", conversationIds: notes("m", 3) },
    { id: "b-sleep", label: "Sleep", color: "green", kind: "group", conversationIds: notes("z", 2) },
    { id: "__no-group__", label: "Not grouped", color: "grey", kind: "none", conversationIds: notes("u", 9) },
  ],
  blockNames: new Map([["k-drugs", "Senolytic drugs"]]),
  titleOf: (id) => `Note ${id}`,
  ...overrides,
});

describe("buildLibrary", () => {
  test("themes hold topics, topics with blocks hold a section per block, and loose notes get their own shelf", () => {
    const root = buildLibrary(input());
    expect(root.id).toBe(LIBRARY_ROOT_ID);
    expect(root.label).toBe("All notes");
    expect(root.allIds).toHaveLength(7 + 3 + 2 + 9);
    const aging = root.sections.find((section) => section.id === "t-aging")!;
    expect(aging.sections.map((section) => section.label)).toEqual(["Cellular senescence", "Mitochondria"]);
    const senescence = aging.sections[0];
    expect(senescence.sections.map((section) => section.label)).toEqual(["Senolytic drugs", "Note s4", "More notes"]);
    expect(senescence.sections[2].noteIds).toEqual(["loose"]);
    expect(senescence.noteIds).toEqual([]);
  });

  test("biggest sections come first and the unfiled notes always come last", () => {
    const root = buildLibrary(input());
    expect(root.sections.map((section) => section.id)).toEqual(["t-aging", "b-sleep", "__no-group__"]);
  });

  test("a section holding one section takes its child's contents under its own name", () => {
    const root = buildLibrary(input({ themes: [{ id: "t-solo", label: "Rest", color: "green", boxIds: ["b-sleep"] }] }));
    const rest = root.sections.find((section) => section.id === "t-solo")!;
    expect(rest.label).toBe("Rest");
    expect(rest.sections).toEqual([]);
    expect(rest.noteIds).toEqual(["z0", "z1"]);
  });

  test("paths lead to a section, stop at a missing id, and find the shelf holding a note", () => {
    const root = buildLibrary(input());
    expect(libraryPath(root, ["t-aging", "b-senescence"]).map((section) => section.label)).toEqual(["All notes", "Biology of aging", "Cellular senescence"]);
    expect(libraryPath(root, ["t-aging", "gone", "b-senescence"]).map((section) => section.id)).toEqual([LIBRARY_ROOT_ID, "t-aging"]);
    expect(pathToNote(root, "s2")).toEqual(["t-aging", "b-senescence", "k-drugs"]);
    expect(pathToNote(root, "nowhere")).toEqual([]);
  });
});

describe("squarify", () => {
  test("rooms fill the space without overlapping, sized by what they hold", () => {
    const rects = squarify([40, 20, 10, 5, 1], 1000, 600, 0);
    expect(rects).toHaveLength(5);
    const area = rects.reduce((sum, rect) => sum + rect.width * rect.height, 0);
    expect(area).toBeCloseTo(1000 * 600, -2);
    for (const a of rects) for (const b of rects) {
      if (a === b) continue;
      const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      expect(overlapX <= 0.5 || overlapY <= 0.5).toBe(true);
    }
    const byIndex = new Map(rects.map((rect) => [rect.index, rect.width * rect.height]));
    expect(byIndex.get(0)!).toBeGreaterThan(byIndex.get(1)!);
  });

  test("a tiny section still gets a room big enough to click", () => {
    const rects = squarify([500, 1], 1000, 600, 0);
    const small = rects.find((rect) => rect.index === 1)!;
    expect(small.width * small.height).toBeGreaterThanOrEqual(1000 * 600 * 0.03);
  });
});

describe("circles", () => {
  test("packed circles never overlap and fit inside the outer circle", () => {
    const radii = [30, 22, 18, 12, 12, 9, 5];
    const { centers, radius } = packCircles(radii, 2);
    radii.forEach((r, i) => {
      expect(Math.hypot(centers[i].x, centers[i].y) + r).toBeLessThanOrEqual(radius + 0.01);
      for (let j = i + 1; j < radii.length; j++) expect(Math.hypot(centers[i].x - centers[j].x, centers[i].y - centers[j].y)).toBeGreaterThanOrEqual(r + radii[j] - 0.01);
    });
  });

  test("every note has a circle inside its shelf, and every section sits inside its parent", () => {
    const root = buildLibrary(input());
    const circles = packLibrary(root);
    const byId = new Map(circles.map((circle) => [circle.id, circle]));
    expect(circles.filter((circle) => circle.kind === "note")).toHaveLength(root.allIds.length);
    for (const circle of circles) {
      if (!circle.parentId) continue;
      const parent = byId.get(circle.parentId)!;
      expect(Math.hypot(circle.x - parent.x, circle.y - parent.y) + circle.r).toBeLessThanOrEqual(parent.r + 0.01);
    }
  });

  test("links between notes become one line per pair of visible sections, counted", () => {
    const standIn = (id: string) => (id.startsWith("s") ? "A" : id.startsWith("m") ? "B" : null);
    expect(groupLinks([{ sourceId: "s1", targetId: "m1" }, { sourceId: "m2", targetId: "s3" }, { sourceId: "s1", targetId: "s2" }, { sourceId: "s1", targetId: "x" }], standIn))
      .toEqual([{ a: "A", b: "B", count: 2 }]);
  });
});
