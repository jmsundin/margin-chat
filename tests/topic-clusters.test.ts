import { describe, expect, test } from "bun:test";
import { applyClusterPlacements, findGravityClusters, finishSubjectClusters, groupDocumentsByMeaning, groupSubjects, layoutGravityClusters, UNLINKED_CLUSTER_ID } from "../client/src/lib/gravityClusters";
import { buildCategoriesPrompt, carryCategoryNames } from "../client/src/lib/useSubjectCategories";
import { decodeTopicEmbedding, groupByTopicEmbedding, MAX_TOPIC_ITEMS, nearestTopicGroup } from "../client/src/lib/topicEmbeddings";

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

describe("neighbours found on the server", () => {
  /** Each document's nearest others, as the server would send them: same subject first. */
  function neighboursFrom(vectors: Map<string, Float32Array>, limit = 12) {
    const ids = [...vectors.keys()];
    const lists = new Map(ids.map((id) => {
      const vector = vectors.get(id)!;
      const near = ids.filter((other) => other !== id)
        .map((other) => ({ id: other, similarity: vector.reduce((total, value, index) => total + value * vectors.get(other)![index], 0) }))
        .sort((a, b) => b.similarity - a.similarity).slice(0, limit);
      return [id, near] as const;
    }));
    return (id: string) => lists.get(id);
  }

  test("with neighbours, documents group by subject without comparing every pair", () => {
    const vectors = subjectVectors({ angular: ANGULAR, react: REACT, bread: BREAD, marathon: ["marathon"], budget: ["budget"], trip: ["trip"] });
    const neighbours = neighboursFrom(vectors);
    const vectorOf = (id: string) => vectors.get(id);
    const merged = groupDocumentsByMeaning(ids, connections, vectorOf, neighbours);
    expect([...merged.find((cluster) => cluster.memberIds.includes("viewchild"))!.memberIds].sort()).toEqual([...ANGULAR].sort());
    expect(merged.find((cluster) => cluster.memberIds.includes("react"))!.memberIds.sort()).toEqual([...REACT].sort());
    expect(merged.at(-1)).toEqual({ hubId: null, memberIds: [...LONE].sort() });
  });

  test("more documents than the all-pairs cap still group when neighbours are known", () => {
    const subjects: Record<string, string[]> = { a: [], b: [], c: [] };
    for (let index = 0; index < MAX_TOPIC_ITEMS + 600; index++) subjects[["a", "b", "c"][index % 3]].push(`doc-${index}`);
    const vectors = subjectVectors(subjects, 0.2);
    const all = Object.values(subjects).flat();
    // Neighbours as the server would find them: a dozen from the same subject.
    const neighbours = (id: string) => {
      const list = subjects[["a", "b", "c"][Number(id.slice(4)) % 3]];
      const at = list.indexOf(id);
      return Array.from({ length: 12 }, (_, offset) => ({ id: list[(at + offset + 1) % list.length], similarity: 0.6 - offset * 0.01 }));
    };
    const started = performance.now();
    const groups = groupByTopicEmbedding(all.map((id) => ({ documentIds: [id] })), (id) => vectors.get(id), undefined, { neighbours });
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(groups.filter((group) => group.itemIndices.length > 1)).toHaveLength(3);
    expect(groups.every((group) => group.itemIndices.length > 1)).toBe(true);
  });

  test("a document left alone joins the group of its nearest neighbour", () => {
    const groups = [["angular", "viewchild"], ["react", "react-memo"]];
    const neighbours = (id: string) => id === "inputs" ? [{ id: "trip", similarity: 0.5 }, { id: "react-memo", similarity: 0.4 }] : id === "trip" ? [{ id: "inputs", similarity: 0.2 }] : undefined;
    expect(nearestTopicGroup(["inputs", "trip"], groups, () => undefined, undefined, neighbours)).toEqual([1, -1]);
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

  test("with neighbours from the server, regions are communities of linked and related clusters", () => {
    const vectors = new Map<string, Float32Array>();
    const fieldOf = new Map<string, number>();
    const subjectOf = new Map<string, number>();
    for (let subject = 0; subject < 40; subject++) for (let note = 0; note < 3; note++) {
      const id = `s${subject}-${note}`;
      const vector = new Float32Array(96);
      vector[subject] = 1;
      vectors.set(id, vector);
      fieldOf.set(id, Math.floor(subject / 2));
      subjectOf.set(id, subject);
    }
    // Each note's neighbours: its own subject's notes, then the other subject of its field.
    const neighboursOf = (id: string) => [...vectors.keys()].filter((other) => other !== id && fieldOf.get(other) === fieldOf.get(id))
      .map((other) => ({ id: other, similarity: subjectOf.get(other) === subjectOf.get(id) ? 0.9 : 0.45 }))
      .sort((a, b) => b.similarity - a.similarity);
    const layout = layoutGravityClusters([...vectors.keys()].map(node), { width: 1200, height: 800 }, [], { topicVector: (id) => vectors.get(id), neighboursOf });
    expect(layout.clusters).toHaveLength(40);
    const regions = layout.levels[0].groups;
    expect(regions).toHaveLength(20);
    for (const region of regions) expect(new Set(region.memberIds.map((id) => fieldOf.get(id))).size).toBe(1);
  });
});

describe("clusters named by the AI", () => {
  // Three Angular clusters the embeddings left apart, as Jon saw them.
  const vectors = subjectVectors({ a1: ["angular", "angular-cli", "angular-di"], a2: ["components", "inputs", "lifecycle"],
    a3: ["viewchild", "viewchildren", "elementref"], react: REACT });
  const docs = [...vectors.keys()];
  const base = groupSubjects(docs, [], (id) => vectors.get(id));
  const fingerprintOf = (id: string) => base.find((cluster) => cluster.memberIds.includes(id))!.fingerprint;

  test("clusters given the same name become one category with that name", () => {
    expect(base).toHaveLength(4);
    const names = new Map([[fingerprintOf("angular"), "Angular"], [fingerprintOf("inputs"), "angular"], [fingerprintOf("viewchild"), "Angular"],
      [fingerprintOf("react"), "React"]]);
    const finished = finishSubjectClusters(base, { names });
    expect(finished).toHaveLength(2);
    const angular = finished.find((cluster) => cluster.memberIds.includes("elementref"))!;
    expect(angular.name).toBe("Angular");
    expect(angular.memberIds).toHaveLength(9);
    expect(finished.find((cluster) => cluster.memberIds.includes("react"))!.name).toBe("React");
  });

  test("a document moved by hand keeps its new category's name", () => {
    const names = new Map([[fingerprintOf("angular"), "Angular"], [fingerprintOf("inputs"), "Angular"], [fingerprintOf("react"), "React"]]);
    const finished = finishSubjectClusters(base, { names, placements: new Map([["react-memo", "inputs"]]) });
    const angular = finished.find((cluster) => cluster.memberIds.includes("inputs"))!;
    expect(angular.name).toBe("Angular");
    expect(angular.memberIds).toContain("react-memo");
    expect(finished.find((cluster) => cluster.memberIds.includes("viewchild"))!.name).toBeUndefined();
  });

  test("the map uses the named clusters and labels them", () => {
    const names = new Map(base.map((cluster) => [cluster.fingerprint, cluster.memberIds.includes("react") ? "React" : "Angular"]));
    const layout = layoutGravityClusters(docs.map(node), { width: 1200, height: 800 }, [],
      { topicVector: (id) => vectors.get(id), subjects: finishSubjectClusters(base, { names }) });
    expect(layout.clusters.map((cluster) => cluster.name).sort()).toEqual(["Angular", "React"]);
  });

  test("a cluster that changed a little keeps its name; a new one does not", () => {
    const named = [{ fingerprint: "old", name: "Angular", memberIds: ["angular", "angular-cli", "angular-di", "components", "inputs"] }];
    const names = carryCategoryNames([
      { fingerprint: "grown", memberIds: ["angular", "angular-cli", "angular-di", "components", "inputs", "signals"] },
      { fingerprint: "new", memberIds: ["react", "react-memo"] },
    ], named);
    expect(names.get("grown")).toBe("Angular");
    expect(names.has("new")).toBe(false);
  });

  test("the prompt lists each cluster's titles and its earlier name", () => {
    const conversations = Object.fromEntries(["angular", "inputs", "react"].map((id) => [id, { title: `${id} notes` }])) as never;
    const prompt = buildCategoriesPrompt([{ memberIds: ["angular", "inputs"] }, { memberIds: ["react", "missing"] }], conversations, new Map([[0, "Angular"]]));
    expect(prompt).toBe("C1 (2 docs): angular notes; inputs notes [was: Angular]\nC2 (2 docs): react notes");
  });
});
