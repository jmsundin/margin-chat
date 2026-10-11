import { describe, expect, test } from "bun:test";
import { findGravityClusters, layoutGravityClusters, mergeClustersByTopic, UNLINKED_CLUSTER_ID } from "../client/src/lib/gravityClusters";
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

  test("with embeddings, the Angular clusters join and other subjects stay apart", () => {
    const vectors = subjectVectors({ angular: ANGULAR, react: REACT, bread: BREAD, marathon: ["marathon"], budget: ["budget"], trip: ["trip"] });
    const merged = mergeClustersByTopic(findGravityClusters(ids, connections).clusters, (id) => vectors.get(id));
    const angular = merged.find((cluster) => cluster.memberIds.includes("viewchild"))!;
    expect([...angular.memberIds].sort()).toEqual([...ANGULAR].sort());
    expect(merged.find((cluster) => cluster.memberIds.includes("react"))!.memberIds.sort()).toEqual([...REACT].sort());
    expect(merged.at(-1)).toEqual({ hubId: null, memberIds: [...LONE].sort() });
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
