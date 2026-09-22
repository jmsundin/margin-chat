import { expect, test } from "bun:test";
import { getGraphNeighborhoodIds } from "../client/src/lib/graphNeighborhood";

const edge = (sourceId: string, targetId: string) => ({ sourceId, targetId });

test("neighborhoods follow both connection directions up to the hop limit in original document order", () => {
  const ids = ["grandchild", "incoming", "far", "focus", "outgoing", "isolated"];
  const connections = [edge("incoming", "focus"), edge("focus", "outgoing"), edge("outgoing", "grandchild"), edge("far", "grandchild")];
  expect([...getGraphNeighborhoodIds(ids, connections, "focus", 0)]).toEqual(["focus"]);
  expect([...getGraphNeighborhoodIds(ids, connections, "focus")]).toEqual(["incoming", "focus", "outgoing"]);
  expect([...getGraphNeighborhoodIds(ids, connections, "focus", 2)]).toEqual(["grandchild", "incoming", "focus", "outgoing"]);
  expect([...getGraphNeighborhoodIds(ids, connections, "focus", 3)]).toEqual(["grandchild", "incoming", "far", "focus", "outgoing"]);
});

test("duplicate, reverse, self, dangling, and cyclic connections never add duplicate or missing documents", () => {
  const ids = ["c", "a", "b", "d", "a"];
  const connections = [edge("a", "b"), edge("a", "b"), edge("b", "a"), edge("b", "c"), edge("c", "a"),
    edge("a", "a"), edge("a", "missing"), edge("missing", "d")];
  const before = structuredClone({ ids, connections });
  expect([...getGraphNeighborhoodIds(ids, connections, "a", 1)]).toEqual(["c", "a", "b"]);
  expect([...getGraphNeighborhoodIds(ids, connections, "a", 1000)]).toEqual(["c", "a", "b"]);
  expect(getGraphNeighborhoodIds(ids, connections, "a", 2))
    .toEqual(getGraphNeighborhoodIds(ids, [...connections].reverse(), "a", 2));
  expect({ ids, connections }).toEqual(before);
});

test("isolated and missing centers stay bounded, including fractional and nonfinite depth", () => {
  const ids = Object.freeze(["a", "b", "c", "isolated"]);
  const connections = Object.freeze([Object.freeze(edge("a", "b")), Object.freeze(edge("b", "c"))]);
  expect([...getGraphNeighborhoodIds(ids, connections, "isolated", 10)]).toEqual(["isolated"]);
  expect([...getGraphNeighborhoodIds(ids, connections, "missing", 10)]).toEqual([]);
  expect([...getGraphNeighborhoodIds([], connections, "a")]).toEqual([]);
  expect([...getGraphNeighborhoodIds(ids, connections, "a", -3)]).toEqual(["a"]);
  expect([...getGraphNeighborhoodIds(ids, connections, "a", 1.99)]).toEqual(["a", "b"]);
  for (const depth of [NaN, Infinity, -Infinity]) {
    expect([...getGraphNeighborhoodIds(ids, connections, "a", depth)]).toEqual(["a", "b"]);
  }
  expect([...getGraphNeighborhoodIds(ids, connections, "a", Number.MAX_VALUE)]).toEqual(["a", "b", "c"]);
});
