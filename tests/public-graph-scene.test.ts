import { describe, expect, test } from "bun:test";
import {
  addPublicGraphRoot, appendPublicGraphExpansion, emptyPublicGraph,
  publicGraphPlacements, setPublicExpansionVisible, visiblePublicGraph,
} from "../client/src/lib/publicGraphScene";
import type { PublicExpansion, PublicTopic } from "../client/src/lib/publicKnowledge";
import { publicMapNeighborhoods, publicMapNodePlacements } from "../client/src/lib/publicMapPresentation";

function topic(id: string): PublicTopic {
  return { id, aliases: [], label: `Topic ${id}`, description: "Public topic", wikidataUrl: `https://www.wikidata.org/wiki/${id}`, retrievedAt: "2026-09-20T00:00:00.000Z" };
}
function expansion(root: string, neighbors: string[], more = false, offset = neighbors.length): PublicExpansion {
  return { topic: topic(root), topics: neighbors.map(topic), hasMore: more, nextOffset: offset,
    relations: neighbors.map((id) => ({ id: `${root}:P279:${id}`, sourceId: root, targetId: id, propertyId: "P279", label: "subclass of", sourceUrl: `https://www.wikidata.org/wiki/${root}#P279` })),
  };
}
const ids = (graph: ReturnType<typeof emptyPublicGraph>) => visiblePublicGraph(graph).topics.map((item) => item.id).sort();

describe("public graph neighborhoods", () => {
  test("canvas selection preserves every topic center and its atlas membership", () => {
    let graph = addPublicGraphRoot(emptyPublicGraph(), topic("Q1"));
    graph = appendPublicGraphExpansion(graph, expansion("Q1", ["Q2", "Q3"]));
    const neutral = publicMapNodePlacements(graph);
    const selected = publicMapNodePlacements(graph, { selectedId: "Q2" });
    for (const before of neutral) {
      const after = selected.find((node) => node.conversationId === before.conversationId)!;
      expect(after.x + after.width / 2).toBe(before.x + before.width / 2);
      expect(after.y + after.height / 2).toBe(before.y + before.height / 2);
      if (before.conversationId !== "Q2") expect(after).toEqual(before);
    }
    expect(publicMapNeighborhoods(graph, { selectedId: "Q2" }).territories[0].nodes).toEqual(selected);
  });
  test("zoomed-out neighborhood counts cover shared and cyclic expansions once", () => {
    let graph = addPublicGraphRoot(emptyPublicGraph(), topic("Q1"));
    graph = addPublicGraphRoot(graph, topic("Q2"));
    graph = appendPublicGraphExpansion(graph, expansion("Q1", ["Q3"]));
    graph = appendPublicGraphExpansion(graph, expansion("Q2", ["Q3"]));
    graph = appendPublicGraphExpansion(graph, expansion("Q3", ["Q1", "Q4"]));
    const before = structuredClone(graph);
    const { territories } = publicMapNeighborhoods(graph);
    const members = territories.flatMap((territory) => territory.nodes.map((node) => node.conversationId));
    expect(members.sort()).toEqual(["Q1", "Q2", "Q3", "Q4"]);
    expect(territories.find((territory) => territory.id === "Q2")!.nodes.map((node) => node.conversationId)).toContain("Q2");
    expect(graph).toEqual(before);
    const hidden = publicMapNeighborhoods(setPublicExpansionVisible(graph, "Q1", false));
    expect(hidden.territories.flatMap((territory) => territory.nodes).map((node) => node.conversationId).sort()).toEqual(["Q1", "Q2", "Q3", "Q4"]);
  });
  test("incremental expansion keeps the anchor and existing topic positions stable", () => {
    const root = addPublicGraphRoot(emptyPublicGraph(), topic("Q1"));
    const first = appendPublicGraphExpansion(root, expansion("Q1", ["Q2", "Q3"], true, 4));
    const second = appendPublicGraphExpansion(first, expansion("Q1", ["Q3", "Q4"], false, 9));
    expect(second.positions.Q1).toEqual(root.positions.Q1);
    expect(second.positions.Q2).toEqual(first.positions.Q2);
    expect(second.positions.Q3).toEqual(first.positions.Q3);
    expect(ids(second)).toEqual(["Q1", "Q2", "Q3", "Q4"]);
    expect(visiblePublicGraph(second).relations).toHaveLength(3);
    expect(second.expansions.Q1.nextOffset).toBe(9);
    expect(second.expansions.Q1.hasMore).toBe(false);
  });

  test("hiding a branch removes its orphan descendants while retaining a shared neighbor", () => {
    let graph = addPublicGraphRoot(emptyPublicGraph(), topic("Q1"));
    graph = addPublicGraphRoot(graph, topic("Q2"));
    graph = appendPublicGraphExpansion(graph, expansion("Q1", ["Q3", "Q4"]));
    graph = appendPublicGraphExpansion(graph, expansion("Q2", ["Q3"]));
    graph = appendPublicGraphExpansion(graph, expansion("Q3", ["Q5"]));
    graph = appendPublicGraphExpansion(graph, expansion("Q4", ["Q6"]));
    const hidden = setPublicExpansionVisible(graph, "Q1", false);
    expect(ids(hidden)).toEqual(["Q1", "Q2", "Q3", "Q5"]);
    expect(visiblePublicGraph(hidden).relations.map((relation) => relation.id)).toEqual(["Q2:P279:Q3", "Q3:P279:Q5"]);
    expect(ids(setPublicExpansionVisible(hidden, "Q1", true))).toEqual(ids(graph));
    expect(hidden.positions).toEqual(graph.positions);
  });

  test("cycles terminate and preserve only reachable nodes", () => {
    let graph = addPublicGraphRoot(emptyPublicGraph(), topic("Q1"));
    graph = appendPublicGraphExpansion(graph, expansion("Q1", ["Q2"]));
    graph = appendPublicGraphExpansion(graph, expansion("Q2", ["Q1", "Q3"]));
    graph = appendPublicGraphExpansion(graph, expansion("Q3", ["Q2"]));
    expect(ids(graph)).toEqual(["Q1", "Q2", "Q3"]);
    expect(ids(setPublicExpansionVisible(graph, "Q1", false))).toEqual(["Q1"]);
  });

  test("searching an already known root updates its metadata without duplicating it", () => {
    let graph = addPublicGraphRoot(emptyPublicGraph(), topic("Q1"));
    graph = appendPublicGraphExpansion(graph, expansion("Q1", ["Q2"]));
    const before = structuredClone(graph.positions);
    graph = addPublicGraphRoot(graph, { ...topic("Q1"), aliases: ["Q9"], label: "Canonical topic" });
    expect(graph.roots).toEqual(["Q1"]);
    expect(graph.positions).toEqual(before);
    expect(graph.topics.Q1.aliases).toEqual(["Q9"]);
    expect(graph.topics.Q1.label).toBe("Canonical topic");
  });

  test("focused topics make temporary room and deselecting restores all authored positions", () => {
    let graph = addPublicGraphRoot(emptyPublicGraph(), topic("Q1"));
    graph = appendPublicGraphExpansion(graph, expansion("Q1", Array.from({ length: 10 }, (_, index) => `Q${index + 2}`)));
    const authored = structuredClone(graph.positions);
    const compact = publicGraphPlacements(graph, null);
    const selected = publicGraphPlacements(graph, "Q1");
    for (let i = 0; i < selected.length; i += 1) for (let j = i + 1; j < selected.length; j += 1) {
      const a = selected[i]; const b = selected[j];
      expect(a.x + a.width + 47 <= b.x || b.x + b.width + 47 <= a.x || a.y + a.height + 63 <= b.y || b.y + b.height + 63 <= a.y).toBe(true);
    }
    expect(selected[0].x).toBe(authored.Q1.x);
    expect(selected[0].y).toBe(authored.Q1.y);
    expect(graph.positions).toEqual(authored);
    expect(publicGraphPlacements(graph, null)).toEqual(compact);
  });

  test("empty expansions are remembered without adding unrelated topics", () => {
    const graph = appendPublicGraphExpansion(emptyPublicGraph(), expansion("Q1", []));
    expect(ids(graph)).toEqual(["Q1"]);
    expect(graph.expansions.Q1.hasMore).toBe(false);
    expect(visiblePublicGraph(graph).relations).toEqual([]);
  });
});
