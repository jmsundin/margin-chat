import { describe, expect, test } from "bun:test";
import { articleChildren, browsePath, categoryChildren, packBrowse, parseExploreSource, serializeExploreSource, sourceRoot, topicChildren, withChildren, type BrowseNode } from "../client/src/lib/exploreSources";

describe("Explore sources", () => {
  test("a source survives being stored and read back, and anything unknown means your notes", () => {
    for (const source of [{ kind: "notes" }, { kind: "wikipedia" }, { kind: "ai", topic: "Women's football" }] as const) {
      expect(parseExploreSource(serializeExploreSource(source))).toEqual(source);
    }
    expect(parseExploreSource("ai:   ")).toEqual({ kind: "notes" });
    expect(parseExploreSource("somewhere")).toEqual({ kind: "notes" });
    expect(parseExploreSource(null)).toEqual({ kind: "notes" });
  });
});

describe("Wikipedia as a library", () => {
  const health: BrowseNode = { id: "c:Health", label: "Health", kind: "section", category: "Health", weight: 1 };

  test("sub-categories become rooms, biggest first, and the articles filed directly go on one shelf led by the category's own article", () => {
    const children = categoryChildren(health, [
      { title: "Breast", kind: "article" },
      { title: "Public health", kind: "category", size: 300, pages: 178, subcats: 31 },
      { title: "Health", kind: "article", description: "Level of wellbeing" },
      { title: "Mental health", kind: "category", size: 130, pages: 70, subcats: 15 },
    ]);
    expect(children.map((child) => child.label)).toEqual(["Public health", "Mental health", "Articles in Health"]);
    expect(children[0].hint).toBe("178 articles · 31 sections");
    expect(children[0].weight).toBeGreaterThan(children[1].weight);
    const shelf = children[2];
    expect(shelf.kind).toBe("shelf");
    expect(shelf.children?.map((child) => child.label)).toEqual(["Health", "Breast"]);
    expect(shelf.children?.[0].summary).toBe("Level of wellbeing");
  });

  test("a category with only articles is a shelf on its own, and one with only rooms has no shelf", () => {
    expect(categoryChildren(health, [{ title: "Sleep", kind: "article" }]).map((child) => child.kind)).toEqual(["article"]);
    expect(categoryChildren(health, [{ title: "Sleep medicine", kind: "category", size: 4 }]).map((child) => child.kind)).toEqual(["section"]);
  });

  test("an article opens into its main ideas, its sections and See also, each holding the articles it links to", () => {
    const node: BrowseNode = { id: "a:Health", label: "Health", kind: "article", article: "Health", weight: 1 };
    const groups = articleChildren(node, { title: "Health", candidates: [
      { title: "Well-being", kind: "lead", section: null, score: 9 },
      { title: "Medicine", kind: "broader", section: null, score: 9 },
      { title: "Exercise", kind: "section", section: "Maintaining", score: 3 },
      { title: "Sleep", kind: "section", section: "Maintaining", score: 5 },
      { title: "Public health", kind: "see-also", section: "See also", score: 1 },
      { title: "Health", kind: "section", section: "Maintaining", score: 2 },
    ] });
    expect(groups.map((group) => group.label)).toEqual(["Main ideas", "Maintaining", "See also"]);
    expect(groups[1].children?.map((child) => child.label)).toEqual(["Sleep", "Exercise"]);
    expect(groups.every((group) => group.kind === "group" && group.children?.every((child) => child.kind === "article"))).toBe(true);
  });

  test("AI topics become nodes that keep their article when they have one", () => {
    const root = sourceRoot({ kind: "ai", topic: "Longevity" });
    const [first] = topicChildren(root, [{ id: "Q1", aliases: [], label: "Rapamycin", description: "Drug", wikidataUrl: "https://www.wikidata.org/wiki/Q1",
      wikipediaUrl: "https://en.wikipedia.org/wiki/Rapamycin", retrievedAt: "2026-11-18T00:00:00.000Z" }]);
    expect(first).toMatchObject({ kind: "topic", label: "Rapamycin", article: "Rapamycin", summary: "Drug" });
  });
});

describe("the walk", () => {
  test("opening a node changes only that node, and the path stops where the tree does", () => {
    const root = sourceRoot({ kind: "wikipedia" });
    const opened = withChildren(root, "wikipedia", [{ id: "c:Sports", label: "Sports", kind: "section", category: "Sports", weight: 4 }]);
    const deeper = withChildren(opened, "c:Sports", [{ id: "c:Women's sports", label: "Women's sports", kind: "section", category: "Women's sports", weight: 3 }]);
    expect(browsePath(deeper, ["c:Sports", "c:Women's sports"]).map((node) => node.label)).toEqual(["Wikipedia", "Sports", "Women's sports"]);
    expect(browsePath(deeper, ["c:Sports", "gone"]).map((node) => node.label)).toEqual(["Wikipedia", "Sports"]);
    expect(withChildren(deeper, "missing", [])).toBe(deeper);
    expect(withChildren(deeper, "c:Sports", undefined).children?.[0].children).toBeUndefined();
  });

  test("circles keep their place when what is inside them loads, and children sit inside their parent", () => {
    const sections: BrowseNode[] = ["Health", "Science", "Sports"].map((label, at) => ({ id: `c:${label}`, label, kind: "section", weight: 3 + at }));
    const root = withChildren(sourceRoot({ kind: "wikipedia" }), "wikipedia", sections);
    const before = packBrowse(root, () => "red");
    const opened = withChildren(root, "c:Sports", ["A", "B", "C", "D"].map((label) => ({ id: `a:${label}`, label, kind: "article", weight: 1 })));
    const after = packBrowse(opened, () => "red");
    const where = (circles: typeof before, id: string) => circles.find((circle) => circle.id === id)!;
    for (const id of ["c:Health", "c:Science", "c:Sports"]) expect(where(after, id)).toMatchObject({ x: where(before, id).x, y: where(before, id).y, r: where(before, id).r });
    const sports = where(after, "c:Sports");
    for (const circle of after.filter((item) => item.parentKey === sports.key)) {
      expect(Math.hypot(circle.x - sports.x, circle.y - sports.y) + circle.r).toBeLessThanOrEqual(sports.r + 0.01);
    }
  });

  test("a category filed inside itself is drawn once, not forever", () => {
    const loop: BrowseNode = { id: "c:A", label: "A", kind: "section", weight: 1 };
    loop.children = [{ ...loop, children: [{ id: "c:B", label: "B", kind: "section", weight: 1 }] }];
    const circles = packBrowse({ id: "root", label: "root", kind: "root", weight: 1, children: [loop] }, () => "red");
    expect(circles.length).toBeLessThan(5);
  });
});
