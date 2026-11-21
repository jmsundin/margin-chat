import { describe, expect, test } from "bun:test";
import { pickAroundNeighbours, ringPoints, topicQuery, wikipediaTitlesIn } from "../client/src/lib/aroundRings";

describe("pickAroundNeighbours", () => {
  const exists = (id: string) => id !== "gone";
  test("linked notes come first, most linked first, then similar notes", () => {
    const links = [{ sourceId: "c", targetId: "a" }, { sourceId: "b", targetId: "c" }, { sourceId: "c", targetId: "b" }, { sourceId: "x", targetId: "y" }, { sourceId: "c", targetId: "gone" }];
    expect(pickAroundNeighbours("c", links, [{ id: "s1" }, { id: "a" }, { id: "s2" }], exists)).toEqual([
      { id: "b", kind: "linked" }, { id: "a", kind: "linked" }, { id: "s1", kind: "similar" }, { id: "s2", kind: "similar" }]);
  });
  test("keeps a few places for similar notes when many are linked", () => {
    const links = Array.from({ length: 12 }, (_, at) => ({ sourceId: "c", targetId: `l${at}` }));
    const picked = pickAroundNeighbours("c", links, [{ id: "s1" }, { id: "s2" }, { id: "s3" }, { id: "s4" }], exists, 10);
    expect(picked).toHaveLength(10);
    expect(picked.filter((item) => item.kind === "similar").map((item) => item.id)).toEqual(["s1", "s2", "s3"]);
  });
});

describe("public topic lookups", () => {
  test("finds Wikipedia articles a note links to", () => {
    expect(wikipediaTitlesIn("See [Senolytic](https://en.wikipedia.org/wiki/Senolytic) and https://en.m.wikipedia.org/wiki/Cellular_senescence#Markers, not https://en.wikipedia.org/wiki/Category:Aging"))
      .toEqual(["Senolytic", "Cellular senescence"]);
  });
  test("turns a note title into a search", () => {
    expect(topicQuery("Are web sockets the only way to create a web app th...")).toBe("Are web sockets the only way to create a web app th");
    expect(topicQuery("AI Solving Problems (2026-10-20)")).toBe("AI Solving Problems");
  });
});

test("ringPoints starts at the top and goes round evenly", () => {
  const points = ringPoints(4, 100, 100, 50, 20);
  expect(points.map(({ x, y }) => [Math.round(x), Math.round(y)])).toEqual([[100, 80], [150, 100], [100, 120], [50, 100]]);
});
