import { describe, expect, test } from "bun:test";
import { findCommunities, rankByLinks } from "../client/src/lib/graphCommunities";

const pair = (a: string, b: string, weight = 1) => ({ a, b, weight });

/** Two tight groups joined by one weak link, plus a document on its own. */
const ids = ["a1", "a2", "a3", "a4", "b1", "b2", "b3", "b4", "lone"];
const pairs = [
  pair("a1", "a2"), pair("a1", "a3"), pair("a1", "a4"), pair("a2", "a3"), pair("a3", "a4"),
  pair("b1", "b2"), pair("b1", "b3"), pair("b1", "b4"), pair("b2", "b3"), pair("b3", "b4"),
  pair("a4", "b1"),
];

describe("communities", () => {
  test("finds the two groups and leaves the lone document on its own", () => {
    expect(findCommunities(ids, pairs)).toEqual([["a1", "a2", "a3", "a4"], ["b1", "b2", "b3", "b4"], ["lone"]]);
  });

  test("gives the same answer every time, whatever the order of the input", () => {
    const first = findCommunities(ids, pairs);
    const shuffled = findCommunities([...ids].reverse(), [...pairs].reverse());
    expect(shuffled).toEqual(first);
    expect(findCommunities(ids, pairs, { seed: 99 })).toEqual(first);
  });

  test("a lower resolution makes broader communities", () => {
    const fine = findCommunities(ids, pairs, { resolution: 1 }).length;
    const broad = findCommunities(ids, pairs, { resolution: 0.1 }).length;
    expect(broad).toBeLessThanOrEqual(fine);
    expect(broad).toBe(2);
  });

  test("a graph with no links is one community per document", () => {
    expect(findCommunities(["x", "y"], [])).toEqual([["x"], ["y"]]);
    expect(findCommunities([], [])).toEqual([]);
  });

  test("ignores links to unknown documents, self links and zero weights", () => {
    expect(findCommunities(["x", "y"], [pair("x", "ghost"), pair("x", "x"), pair("x", "y", 0)])).toEqual([["x"], ["y"]]);
  });
});

describe("ranking by links", () => {
  test("the document the others lead to ranks highest", () => {
    const rank = rankByLinks(["hub", "s1", "s2", "s3", "far"], [pair("hub", "s1"), pair("hub", "s2"), pair("hub", "s3"), pair("s3", "far")]);
    const ordered = [...rank].sort((x, y) => y[1] - x[1]).map(([id]) => id);
    expect(ordered[0]).toBe("hub");
    // A document linked only from a spoke is worth less than the spoke itself.
    expect(rank.get("far")!).toBeLessThan(rank.get("s3")!);
  });

  test("documents with no links rank alike", () => {
    expect([...rankByLinks(["x", "y"], []).values()]).toEqual([0.5, 0.5]);
  });
});
