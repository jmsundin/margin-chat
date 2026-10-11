// Times grouping by meaning on synthetic vaults: bun scripts/bench-meaning.ts
import { findSubjectClusters, layoutGravityClusters } from "../client/src/lib/gravityClusters";

for (const count of [1_000, 3_000, 10_000]) {
  const dimensions = 512;
  const subjects = Math.round(count / 12);
  let seed = 3;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
  const vectors = new Map<string, Float32Array>();
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    const id = `d${index}`;
    const vector = new Float32Array(dimensions);
    for (let d = 0; d < dimensions; d++) vector[d] = random() * 0.1;
    vector[index % subjects % dimensions] += 1;
    vector[(index % subjects * 7 + 3) % dimensions] += 0.8;
    const length = Math.hypot(...vector);
    vectors.set(id, vector.map((value) => value / length));
    ids.push(id);
  }
  const connections = ids.slice(1).filter((_, index) => index % 3 === 0).map((id, index) => ({ sourceId: id, targetId: ids[(index * 31) % count] }));
  const start = performance.now();
  const clusters = findSubjectClusters(ids, connections, { topicVector: (id) => vectors.get(id) });
  const grouped = performance.now();
  const layout = layoutGravityClusters(ids.map((id) => ({ conversationId: id, depth: 0, x: 0, y: 0, width: 180, height: 96 })),
    { width: 1200, height: 800 }, connections, { topicVector: (id) => vectors.get(id) });
  const laidOut = performance.now();
  console.log(`${count} docs: ${clusters.length} clusters, grouping ${Math.round(grouped - start)} ms, full layout ${Math.round(laidOut - grouped)} ms, ${layout.levels.length} region levels`);
}
