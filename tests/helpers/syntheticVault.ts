/**
 * Deterministic synthetic vaults for map performance work: topic communities of
 * uneven size, links that favor a few well-connected documents, some links
 * between communities, and a share of documents with no links at all.
 */
export interface SyntheticVault {
  ids: string[];
  connections: Array<{ sourceId: string; targetId: string }>;
  createdAt: Map<string, number>;
}

function random(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 4294967296;
  };
}

export function buildSyntheticVault(count: number, { seed = 7, unlinkedShare = 0.3, linksPerDocument = 1.6, crossShare = 0.08 } = {}): SyntheticVault {
  const next = random(seed);
  const ids = Array.from({ length: count }, (_, index) => `doc-${index.toString(36).padStart(5, "0")}`);
  const createdAt = new Map<string, number>();
  const start = Date.UTC(2022, 0, 1), span = 4 * 365 * 86_400_000;
  for (const id of ids) createdAt.set(id, start + Math.floor(next() * span));
  const linkedCount = Math.round(count * (1 - unlinkedShare));
  const communities: string[][] = [];
  let cursor = 0;
  while (cursor < linkedCount) {
    // Pareto-like sizes: many small topics, a few large ones.
    const size = Math.max(2, Math.min(linkedCount - cursor, Math.round(3 / Math.pow(1 - next() * 0.995, 0.9))));
    communities.push(ids.slice(cursor, cursor + size));
    cursor += size;
  }
  const connections: SyntheticVault["connections"] = [];
  for (const members of communities) {
    const degree = new Array(members.length).fill(1);
    let total = members.length;
    for (let index = 1; index < members.length; index++) {
      const links = Math.max(1, Math.round(linksPerDocument * next() * 1.5));
      for (let link = 0; link < links; link++) {
        // Preferential attachment toward earlier, busier documents.
        let pick = next() * total, target = 0;
        for (; target < index - 1 && pick > degree[target]; target++) pick -= degree[target];
        connections.push({ sourceId: members[index], targetId: members[target] });
        degree[target]++; degree[index]++; total += 2;
      }
    }
  }
  const crossLinks = Math.round(linkedCount * crossShare);
  for (let link = 0; link < crossLinks && communities.length > 1; link++) {
    const a = communities[Math.floor(next() * communities.length)], b = communities[Math.floor(next() * communities.length)];
    if (a === b) continue;
    connections.push({ sourceId: a[Math.floor(next() * a.length)], targetId: b[Math.floor(next() * b.length)] });
  }
  return { ids, connections, createdAt };
}
