/**
 * Map layout benchmark on synthetic vaults: `bun run bench:map [1000,10000,100000]`.
 * For drawing speed in a browser, run `bun tests/helpers/serveGravityClustersPreview.ts`
 * and open http://127.0.0.1:5183/?count=10000.
 */
import { buildSyntheticVault } from "../tests/helpers/syntheticVault";
import { findGravityClusters, layoutGravityClusters } from "../client/src/lib/gravityClusters";
import { buildConversationGraphNodeSpatialIndex } from "../client/src/lib/conversationGraph";

const sizes = (process.argv[2] ?? "1000,10000,100000").split(",").map(Number);
const time = <T>(run: () => T) => { const started = performance.now(); const value = run(); return [value, performance.now() - started] as const; };
for (const size of sizes) {
  const vault = buildSyntheticVault(size);
  const nodes = vault.ids.map((conversationId) => ({ conversationId, depth: 0, x: 0, y: 0, width: 180, height: 96 }));
  const [, clustering] = time(() => findGravityClusters(vault.ids, vault.connections));
  const [layout, laying] = time(() => layoutGravityClusters(nodes, { width: 1400, height: 900 }, vault.connections,
    { createdAt: (id) => vault.createdAt.get(id) }));
  const [, indexing] = time(() => buildConversationGraphNodeSpatialIndex(layout.nodes));
  console.log(`${size.toLocaleString("en-US").padStart(9)} documents  ${vault.connections.length.toLocaleString("en-US").padStart(8)} links  `
    + `clusters ${clustering.toFixed(0).padStart(5)} ms  layout ${laying.toFixed(0).padStart(5)} ms  index ${indexing.toFixed(0).padStart(4)} ms  `
    + `levels ${[layout.clusters.length, ...layout.levels.map((level) => level.groups.length)].join(" > ")}`);
}
