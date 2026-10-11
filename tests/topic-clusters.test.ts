import { describe, expect, test } from "bun:test";
import { applyClusterPlacements, findGravityClusters, groupDocumentsByMeaning, layoutGravityClusters, UNLINKED_CLUSTER_ID } from "../client/src/lib/gravityClusters";
import { decodeTopicEmbedding, groupByTopicEmbedding } from "../client/src/lib/topicEmbeddings";

const link = (sourceId: string, targetId: string) => ({ sourceId, targetId });
const node = (conversationId: string) => ({ conversationId, depth: 0, x: 0, y: 0, width: 180, height: 96 });

/** Unit vectors around a few subject directions, with a little per-document noise. */
function subjectVectors(subjects: Record<string, string[]>, spread = 0.35) {
  const dimensions = 64;
  const vectors = new Map<string, Float32Array>();
  let seed = 11;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
  Object.values(subjects).forEach((ids, subject) => {
    for (const id of ids) {
      const vector = new Float32Array(dimensions);
      vector[subject] = 1;
      for (let index = 0; index < dimensions; index++) vector[index] += random() * spread;
      const length = Math.hypot(...vector);
      vectors.set(id, vector.map((value) => value / length));
    }
  });
  return vectors;
}

// Jon's case: four Angular notes, each leading its own family of linked child notes.
const ANGULAR = ["angular", "angular-cli", "angular-di", "mf", "mf-shell", "mf-shared", "viewchild", "viewchildren", "elementref", "components", "inputs", "lifecycle"];
const REACT = ["react", "react-effects", "react-memo"];
const BREAD = ["sourdough", "starter"];
const LONE = ["marathon", "budget", "trip"];
const connections = [
  ...["angular-cli", "angular-di"].map((id) => link("angular", id)),
  ...["mf-shell", "mf-shared"].map((id) => link("mf", id)),
  ...["viewchildren", "elementref"].map((id) => link("viewchild", id)),
  ...["inputs", "lifecycle"].map((id) => link("components", id)),
  ...["react-effects", "react-memo"].map((id) => link("react", id)),
  link("sourdough", "starter"),
];
const ids = [...ANGULAR, ...REACT, ...BREAD, ...LONE];

describe("grouping clusters by subject", () => {
  test("by links alone, each Angular note is its own cluster", () => {
    const { clusters } = findGravityClusters(ids, connections);
    expect(clusters.filter((cluster) => cluster.memberIds.some((id) => ANGULAR.includes(id)))).toHaveLength(4);
  });

  test("with embeddings, the Angular notes form one cluster and other subjects stay apart", () => {
    const vectors = subjectVectors({ angular: ANGULAR, react: REACT, bread: BREAD, marathon: ["marathon"], budget: ["budget"], trip: ["trip"] });
    const merged = groupDocumentsByMeaning(ids, connections, (id) => vectors.get(id));
    const angular = merged.find((cluster) => cluster.memberIds.includes("viewchild"))!;
    expect([...angular.memberIds].sort()).toEqual([...ANGULAR].sort());
    expect(merged.find((cluster) => cluster.memberIds.includes("react"))!.memberIds.sort()).toEqual([...REACT].sort());
    expect(merged.at(-1)).toEqual({ hubId: null, memberIds: [...LONE].sort() });
  });

  test("a link to another subject does not pull documents across", () => {
    const vectors = subjectVectors({ angular: ANGULAR, react: REACT, bread: BREAD });
    const merged = groupDocumentsByMeaning(ids, [...connections, link("components", "react"), link("viewchild", "react-memo")], (id) => vectors.get(id));
    expect([...merged.find((cluster) => cluster.memberIds.includes("angular"))!.memberIds].sort()).toEqual([...ANGULAR].sort());
    expect([...merged.find((cluster) => cluster.memberIds.includes("react"))!.memberIds].sort()).toEqual([...REACT].sort());
  });

  test("the hub is the most linked member, and a document without an embedding follows its links", () => {
    const vectors = subjectVectors({ angular: ANGULAR, react: REACT, bread: BREAD });
    vectors.delete("lifecycle");
    const merged = groupDocumentsByMeaning([...ids, "hooks"], [...connections, link("react", "hooks"), link("components", "angular")], (id) => vectors.get(id));
    const angular = merged.find((cluster) => cluster.memberIds.includes("angular"))!;
    expect(angular.memberIds).toContain("lifecycle");
    expect(angular.hubId).toBe("components");
    expect(angular.memberIds[0]).toBe("components");
    expect(merged.find((cluster) => cluster.memberIds.includes("react"))!.memberIds).toContain("hooks");
  });

  test("an unlinked note joins the cluster it is about", () => {
    const vectors = subjectVectors({ angular: [...ANGULAR, "signals"], react: REACT, bread: BREAD });
    const layout = layoutGravityClusters([...ids, "signals"].map(node), { width: 1200, height: 800 }, connections,
      { topicVector: (id) => vectors.get(id) });
    expect(layout.clusterByDocumentId.get("signals")).toBe(layout.clusterByDocumentId.get("angular"));
    expect(layout.clusterByDocumentId.get("marathon")).toBe(UNLINKED_CLUSTER_ID);
  });

  test("a chain of loosely related items does not snowball", () => {
    // a~b and b~c are each close enough, but a and c point different ways.
    const v = (x: number, y: number) => { const length = Math.hypot(x, y); return Float32Array.from([x / length, y / length]); };
    const vectors = new Map([["a", v(1, 0)], ["b", v(1, 1)], ["c", v(0, 1)]]);
    const groups = groupByTopicEmbedding(["a", "b", "c"].map((id) => ({ documentIds: [id] })), (id) => vectors.get(id), 0.7);
    expect(groups.map((group) => group.itemIndices.length).sort()).toEqual([1, 2]);
  });

  test("decodes the server's signed bytes into a unit vector", () => {
    const vector = decodeTopicEmbedding(btoa(String.fromCharCode(127, 256 - 63, 25, 0)))!;
    expect(Math.hypot(...vector)).toBeCloseTo(1, 5);
    expect(vector[1]).toBeLessThan(0);
  });
});

describe("filing and moving documents", () => {
  test("an unlinked note that matches nothing closely still joins its nearest cluster", () => {
    const vectors = subjectVectors({ angular: ANGULAR, react: REACT, bread: BREAD }, 0.35);
    // Halfway between Angular and nothing in particular: too far to merge, close enough to file.
    const loose = new Float32Array(64); loose[0] = 0.36; loose[10] = 0.93;
    const length = Math.hypot(...loose);
    vectors.set("forms", loose.map((value) => value / length));
    const merged = groupDocumentsByMeaning([...ids, "forms"], connections, (id) => vectors.get(id));
    expect(merged.find((cluster) => cluster.memberIds.includes("forms"))!.memberIds).toContain("angular");
    expect(merged.at(-1)!.hubId).toBeNull();
  });

  test("a document moved by hand joins its anchor's cluster, and a moved hub hands its cluster on", () => {
    const { clusters } = findGravityClusters(ids, connections);
    const moved = applyClusterPlacements(clusters, new Map([["react", "sourdough"], ["marathon", "angular"]]));
    const bread = moved.find((cluster) => cluster.memberIds.includes("sourdough"))!;
    expect(bread.memberIds).toContain("react");
    const react = moved.find((cluster) => cluster.memberIds.includes("react-effects"))!;
    expect(react.hubId).not.toBe("react");
    expect(react.memberIds).not.toContain("react");
    expect(moved.find((cluster) => cluster.memberIds.includes("angular"))!.memberIds).toContain("marathon");
    expect(moved.at(-1)).toEqual({ hubId: null, memberIds: ["budget", "trip"] });
  });

  test("placements apply in the laid-out map", () => {
    const layout = layoutGravityClusters(ids.map(node), { width: 1200, height: 800 }, connections, { placements: new Map([["trip", "react"]]) });
    expect(layout.clusterByDocumentId.get("trip")).toBe(layout.clusterByDocumentId.get("react"));
  });
});

describe("regions by meaning", () => {
  test("on a large map, clusters on related subjects share a region", () => {
    // 20 fields of 2 subjects each, 3 notes per subject: 40 clusters, over the grouping threshold.
    const dimensions = 96;
    const vectors = new Map<string, Float32Array>();
    const fieldOf = new Map<string, number>();
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
    for (let subject = 0; subject < 40; subject++) for (let note = 0; note < 3; note++) {
      const id = `s${subject}-${note}`;
      const vector = new Float32Array(dimensions);
      vector[subject] = 1;
      vector[40 + Math.floor(subject / 2)] = 0.6;
      for (let index = 0; index < dimensions; index++) vector[index] += random() * 0.2;
      const length = Math.hypot(...vector);
      vectors.set(id, vector.map((value) => value / length));
      fieldOf.set(id, Math.floor(subject / 2));
    }
    const layout = layoutGravityClusters([...vectors.keys()].map(node), { width: 1200, height: 800 }, [], { topicVector: (id) => vectors.get(id) });
    expect(layout.clusters).toHaveLength(40);
    const regions = layout.levels[0].groups;
    expect(regions.length).toBeLessThan(40);
    // Clusters that found no related subject share one leftover group.
    const pure = regions.filter((region) => new Set(region.memberIds.map((id) => fieldOf.get(id))).size === 1);
    expect(pure.length).toBeGreaterThanOrEqual(regions.length - 1);
    expect(pure.length).toBeGreaterThanOrEqual(15);
    expect(regions.some((region) => region.childIds.length === 2)).toBe(true);
  });
});
