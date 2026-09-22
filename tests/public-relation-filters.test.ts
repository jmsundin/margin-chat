import { describe, expect, test } from "bun:test";
import {
  addPublicGraphRoot, appendPublicGraphExpansion, emptyPublicGraph, publicGraphPlacements,
  setPublicExpansionVisible, visiblePublicGraph,
} from "../client/src/lib/publicGraphScene";
import type { PublicExpansion, PublicRelation, PublicTopic } from "../client/src/lib/publicKnowledge";
import { publicMapNeighborhoods } from "../client/src/lib/publicMapPresentation";
import {
  DEFAULT_PUBLIC_RELATION_FILTERS, isPublicMetadataRelation, matchesPublicRelationFilter,
  type PublicRelationFilters,
} from "../client/src/lib/publicRelationFilters";

const topic = (id: string): PublicTopic => ({ id, aliases: [], label: `Topic ${id}`, description: "",
  wikidataUrl: `https://www.wikidata.org/wiki/${id}`, retrievedAt: "2026-09-20T00:00:00.000Z" });
const relation = (sourceId: string, propertyId: string, targetId: string): PublicRelation => ({
  id: `${sourceId}:${propertyId}:${targetId}`, sourceId, propertyId, targetId,
  label: "A translated relationship", sourceUrl: `https://www.wikidata.org/wiki/${sourceId}#${propertyId}`,
});
function expansion(id: string, links: [string, string][]): PublicExpansion {
  return { topic: topic(id), topics: [...new Set(links.map(([, targetId]) => targetId))].map(topic),
    relations: links.map(([propertyId, targetId]) => relation(id, propertyId, targetId)),
    hasMore: true, nextOffset: 10 };
}
function graphFixture() {
  let graph = addPublicGraphRoot(emptyPublicGraph(), topic("Q1"));
  graph = appendPublicGraphExpansion(graph, expansion("Q1", [["P279", "Q2"], ["P361", "Q3"], ["P910", "Q4"], ["P138", "Q5"]]));
  graph = appendPublicGraphExpansion(graph, expansion("Q2", [["P279", "Q6"]]));
  graph = appendPublicGraphExpansion(graph, expansion("Q4", [["P279", "Q7"], ["P301", "Q1"]]));
  return graph;
}
const filters: PublicRelationFilters = DEFAULT_PUBLIC_RELATION_FILTERS;
const ids = (view: ReturnType<typeof visiblePublicGraph>) => view.topics.map((item) => item.id).sort();

describe("public relation display filters", () => {
  test("recognizes Wikimedia links by property ID without hiding similarly named concepts", () => {
    for (const propertyId of ["P910", "P1151", "P1424", "P301", "P1204", "P1423", "P7084", "P5008"]) {
      expect(isPublicMetadataRelation({ propertyId })).toBe(true);
      expect(matchesPublicRelationFilter({ propertyId })).toBe(false);
      expect(matchesPublicRelationFilter({ propertyId }, { relation: "all", includeMetadata: true })).toBe(true);
    }
    const conceptual = { ...relation("Q1", "P279", "Q2"), label: "Category: an actual concept" };
    expect(isPublicMetadataRelation(conceptual)).toBe(false);
    expect(matchesPublicRelationFilter(conceptual)).toBe(true);
    expect(matchesPublicRelationFilter({ propertyId: "P99999" })).toBe(true);
  });

  test("separates type, part and other relations while respecting the metadata toggle", () => {
    for (const propertyId of ["P31", "P279", "P361", "P527", "P138", "P99999", "P910"]) {
      const link = { propertyId };
      expect(matchesPublicRelationFilter(link, { ...filters, relation: "types" })).toBe(["P31", "P279"].includes(propertyId));
      expect(matchesPublicRelationFilter(link, { ...filters, relation: "parts" })).toBe(["P361", "P527"].includes(propertyId));
      expect(matchesPublicRelationFilter(link, { ...filters, relation: "other" })).toBe(["P138", "P99999"].includes(propertyId));
    }
    expect(matchesPublicRelationFilter({ propertyId: "P910" }, { relation: "other", includeMetadata: true })).toBe(true);
    expect(matchesPublicRelationFilter({ propertyId: "P910" }, { relation: "types", includeMetadata: true })).toBe(false);
  });

  test("removes metadata-only branches and restores every loaded topic, cursor and source without mutation", () => {
    const graph = graphFixture();
    const before = structuredClone(graph);
    expect(ids(visiblePublicGraph(graph, { filters }))).toEqual(["Q1", "Q2", "Q3", "Q5", "Q6"]);
    expect(ids(visiblePublicGraph(graph, { filters: { ...filters, relation: "types" } }))).toEqual(["Q1", "Q2", "Q6"]);
    expect(ids(visiblePublicGraph(graph, { filters: { ...filters, relation: "parts" } }))).toEqual(["Q1", "Q3"]);
    const restored = visiblePublicGraph(graph, { filters: { relation: "all", includeMetadata: true } });
    expect(restored).toEqual(visiblePublicGraph(graph));
    expect(restored.relations.find((link) => link.propertyId === "P910")).toBe(graph.expansions.Q1.relations[2]);
    expect(graph).toEqual(before);
    expect(graph.expansions.Q1).toMatchObject({ hasMore: true, nextOffset: 10 });
  });

  test("retains a shared topic via an allowed relation and removes its hidden metadata edge", () => {
    let graph = graphFixture();
    graph = appendPublicGraphExpansion(graph, expansion("Q3", [["P527", "Q4"]]));
    const view = visiblePublicGraph(graph, { filters });
    expect(ids(view)).toEqual(["Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7"]);
    expect(view.relations.some((link) => link.propertyId === "P910")).toBe(false);
    expect(view.relations.some((link) => link.id === "Q3:P527:Q4")).toBe(true);
  });

  test("keeps the active topic and its allowed descendants but never reopens a collapsed branch", () => {
    const graph = graphFixture();
    expect(ids(visiblePublicGraph(graph, { filters, selectedId: "Q4" }))).toEqual(["Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7"]);
    expect(ids(visiblePublicGraph(graph, { filters, selectedId: "Q999" }))).toEqual(["Q1", "Q2", "Q3", "Q5", "Q6"]);
    const collapsed = setPublicExpansionVisible(graph, "Q1", false);
    expect(ids(visiblePublicGraph(collapsed, { filters, selectedId: "Q4" }))).toEqual(["Q1"]);
    expect(ids(visiblePublicGraph(graph, { filters }))).not.toContain("Q4");
  });

  test("placements, neighborhood counts and connections use the same filtered graph", () => {
    const graph = graphFixture();
    const options = { filters: { ...filters, relation: "types" as const }, selectedId: "Q4" };
    const visibleIds = ids(visiblePublicGraph(graph, options));
    expect(publicGraphPlacements(graph, "Q4", options).map((node) => node.conversationId).sort()).toEqual(visibleIds);
    const { territories, connections } = publicMapNeighborhoods(graph, options);
    expect(territories.flatMap((territory) => territory.nodes.map((node) => node.conversationId)).sort()).toEqual(visibleIds);
    expect(territories.map((territory) => territory.id)).toEqual(["Q1", "Q4"]);
    expect(connections.Q1.linkedConversationIds).toEqual(["Q2"]);
    expect(connections.Q4.linkedConversationIds).toEqual(["Q7"]);
    expect(Object.keys(connections).sort()).toEqual(visibleIds);
  });
});
