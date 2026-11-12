/**
 * Splits a box's documents into runs of documents close in meaning, so the Map can draw each run
 * as a tight block with space around it: what is alike sits together, and the space between
 * blocks shows where one subject ends and the next begins.
 */

/** How alike two documents are, from 0 (unrelated) to 1 (the same). */
export type DocumentSimilarity = (a: string, b: string) => number;

/** Documents this alike, on average, form a block: text-embedding-3-small scores one narrow subject about 0.45 and up. */
export const SIMILAR_BLOCK_THRESHOLD = 0.45;
/** In a box of loosely related documents, pairs this alike still sit together. */
export const MIN_BLOCK_THRESHOLD = 0.3;
/** Past this many documents in one box, comparing every pair costs too much; the box keeps its order. */
const MAX_COMPARED = 200;

/**
 * Blocks of alike documents, each in an order that walks from one document to the one most like it,
 * the blocks in an order that keeps neighbouring blocks alike, biggest first. Documents alike to
 * none are the loners, also walked from alike to alike. Average linkage: two blocks join while their documents are,
 * on average, at least `threshold` alike.
 */
export function similarityBlocks(ids: string[], similarity: DocumentSimilarity, threshold?: number): { blocks: string[][]; loners: string[] } {
  if (ids.length < 2 || ids.length > MAX_COMPARED) return { blocks: [], loners: ids };
  const n = ids.length;
  const pair = new Float64Array(n * n);
  const values: number[] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const value = Math.max(0, Math.min(1, similarity(ids[i], ids[j]) || 0));
    pair[i * n + j] = value;
    pair[j * n + i] = value;
    values.push(value);
  }
  // A box of loosely related documents, such as Unfiled, still shows which of them go together:
  // the bar drops to the closest tenth of its pairs, but never below MIN_BLOCK_THRESHOLD.
  if (threshold === undefined) {
    values.sort((a, b) => a - b);
    const closest = values[Math.floor(values.length * 0.9)] ?? 0;
    threshold = Math.min(SIMILAR_BLOCK_THRESHOLD, Math.max(MIN_BLOCK_THRESHOLD, closest));
  }
  // Sum of pair similarities between blocks, so averages stay exact as blocks merge; a block's id is its first document.
  const sums = Float64Array.from(pair);
  const members = ids.map((_, index) => [index]);
  const alive = members.map((_, index) => index);
  for (;;) {
    let best = -1, bestA = -1, bestB = -1;
    for (let x = 0; x < alive.length; x++) for (let y = x + 1; y < alive.length; y++) {
      const a = alive[x], b = alive[y];
      const mean = sums[a * n + b] / (members[a].length * members[b].length);
      if (mean > best) { best = mean; bestA = a; bestB = b; }
    }
    if (bestA < 0 || best < threshold) break;
    alive.splice(alive.indexOf(bestB), 1);
    for (const other of alive) {
      if (other === bestA) continue;
      const total = sums[bestA * n + other] + sums[bestB * n + other];
      sums[bestA * n + other] = total;
      sums[other * n + bestA] = total;
    }
    members[bestA] = [...members[bestA], ...members[bestB]];
  }
  const blocks = alive.map((index) => members[index].sort((a, b) => a - b));
  const groups = blocks.filter((block) => block.length > 1).map((block) => walk(block, pair, n));
  // Loners too go from each to the one most like it, so what is a little alike still sits side by side.
  const lonely = blocks.filter((block) => block.length === 1).map((block) => block[0]).sort((a, b) => a - b);
  const loners = lonely.length > 2 ? walk(lonely, pair, n) : lonely;
  // Blocks follow each other from alike to alike, starting with the biggest.
  groups.sort((a, b) => b.length - a.length || a[0] - b[0]);
  const ordered: number[][] = [];
  const left = new Set(groups.map((_, index) => index));
  let current = groups.length ? 0 : -1;
  while (current >= 0) {
    left.delete(current);
    ordered.push(groups[current]);
    let next = -1, nextScore = -1;
    for (const candidate of left) {
      const score = average(groups[current], groups[candidate], pair, n);
      if (score > nextScore) { nextScore = score; next = candidate; }
    }
    current = next;
  }
  return { blocks: ordered.map((block) => block.map((index) => ids[index])), loners: loners.map((index) => ids[index]) };
}

function average(a: number[], b: number[], pair: Float64Array, n: number) {
  let total = 0;
  for (const i of a) for (const j of b) total += pair[i * n + j];
  return total / (a.length * b.length);
}

/** An order through a block that steps to the most alike document each time, from the block's most central one. */
function walk(block: number[], pair: Float64Array, n: number) {
  let start = block[0], startScore = -1;
  for (const i of block) {
    let score = 0;
    for (const j of block) if (i !== j) score += pair[i * n + j];
    if (score > startScore + 1e-9) { startScore = score; start = i; }
  }
  const order = [start];
  const left = new Set(block.filter((index) => index !== start));
  while (left.size) {
    const last = order[order.length - 1];
    let next = -1, nextScore = -1;
    for (const candidate of left) if (pair[last * n + candidate] > nextScore) { nextScore = pair[last * n + candidate]; next = candidate; }
    left.delete(next);
    order.push(next);
  }
  return order;
}

const STOP_WORDS = new Set(["the", "and", "for", "with", "from", "into", "about", "your", "are", "was", "you", "how", "why", "what", "notes", "note", "untitled", "document", "pdf", "md"]);

/** A title's words that say what it is about, lower case, with plural "s" dropped. */
export function titleWords(title: string) {
  return new Set(title.toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word))
    .map((word) => word.length > 4 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word));
}

/** Similarity from shared title words, for documents with no meaning vectors yet; sharing a third of their words counts as alike. */
export function titleSimilarity(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return Math.min(1, 1.5 * shared / (a.size + b.size - shared));
}

/** Documents linked to each other count as at least this alike. */
const LINKED_SIMILARITY = 0.6;

/**
 * How alike two documents are on the Map: their meaning vectors when both have one, else the
 * server's nearest-neighbour score, else shared title words; documents linked to each other
 * count as alike whatever they say.
 */
export function documentSimilarity({ conversations, connections, vectors, neighbours }: {
  conversations: Record<string, { title: string }>;
  connections: ReadonlyArray<{ sourceId: string; targetId: string }>;
  vectors?: ReadonlyMap<string, Float32Array>;
  neighbours?: ReadonlyMap<string, ReadonlyArray<{ id: string; similarity: number }>>;
}): DocumentSimilarity {
  const linked = new Set<string>();
  for (const { sourceId, targetId } of connections) { linked.add(`${sourceId}\n${targetId}`); linked.add(`${targetId}\n${sourceId}`); }
  const words = new Map<string, Set<string>>();
  const wordsOf = (id: string) => {
    let found = words.get(id);
    if (!found) words.set(id, found = titleWords(conversations[id]?.title ?? ""));
    return found;
  };
  return (a, b) => {
    const link = linked.has(`${a}\n${b}`) ? LINKED_SIMILARITY : 0;
    const va = vectors?.get(a), vb = vectors?.get(b);
    if (va && vb && va.length === vb.length) {
      let total = 0;
      for (let index = 0; index < va.length; index++) total += va[index] * vb[index];
      return Math.max(link, total);
    }
    const near = neighbours?.get(a)?.find((item) => item.id === b) ?? neighbours?.get(b)?.find((item) => item.id === a);
    if (near) return Math.max(link, near.similarity);
    return Math.max(link, titleSimilarity(wordsOf(a), wordsOf(b)));
  };
}
