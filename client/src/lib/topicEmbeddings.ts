/**
 * Grouping by subject for the Clusters view. Each document has an embedding (a
 * meaning fingerprint made on the server). Documents are grouped by meaning
 * first; links only nudge close calls, so notes on Angular, ViewChild and
 * Angular components share one cluster whether or not anybody linked them.
 */

/**
 * Average similarity, over every pair of documents across two groups, needed
 * for them to merge. text-embedding-3-small scores documents on one subject
 * roughly 0.35 to 0.6 and documents that only share a broad field (Angular and
 * React) lower. An average, unlike a centroid, does not rise as groups grow,
 * so two large neighbouring subjects do not fuse.
 */
export const TOPIC_SIMILARITY_THRESHOLD = 0.36;
/** Added to a pair of groups with a link between them. */
export const TOPIC_LINK_BONUS = 0.05;
/**
 * A document left alone joins the cluster it is closest to when it scores at
 * least this against the cluster's mean direction, so few documents stay unfiled.
 */
export const TOPIC_ATTACH_THRESHOLD = 0.3;
/** Documents times clusters compared when filing documents. */
const MAX_ATTACH_COMPARISONS = 4_000_000;
/** Closest candidates kept per item before merging. */
const PARTNERS_PER_ITEM = 12;
/** Leading dimensions used to find candidates; text-embedding-3 vectors keep most of their meaning when cut short. */
const SCREEN_DIMENSIONS = 128;
/** Items searched for partners; the rest are filed into the nearest group afterwards. */
export const MAX_TOPIC_ITEMS = 3_000;

/** Base64 signed bytes from the server, as a unit-length vector. */
export function decodeTopicEmbedding(base64: string): Float32Array | null {
  let binary: string;
  try { binary = atob(base64); } catch { return null; }
  if (!binary.length) return null;
  const vector = new Float32Array(binary.length);
  let sum = 0;
  for (let index = 0; index < binary.length; index++) {
    const byte = binary.charCodeAt(index);
    vector[index] = byte > 127 ? byte - 256 : byte;
    sum += vector[index] * vector[index];
  }
  if (!sum) return null;
  const length = Math.sqrt(sum);
  for (let index = 0; index < vector.length; index++) vector[index] /= length;
  return vector;
}

function dot(a: Float32Array, b: Float32Array) {
  let total = 0;
  for (let index = 0; index < a.length; index++) total += a[index] * b[index];
  return total;
}

function unit(vector: Float32Array) {
  const length = Math.sqrt(dot(vector, vector));
  if (length) for (let index = 0; index < vector.length; index++) vector[index] /= length;
  return vector;
}

/** A document near another in meaning, as the server found it (useTopicEmbeddings). */
export type MeaningNeighbour = { id: string; similarity: number };
/** Each document's nearest documents by meaning, nearest first; undefined where the server has not found them yet. */
export type NeighboursOf = (id: string) => ReadonlyArray<MeaningNeighbour> | undefined;

export interface TopicGroup {
  /** Indices into the items passed in, the item closest to the group's meaning first. */
  itemIndices: number[];
}

/** A binary max-heap of candidate merges. */
class MergeQueue {
  private scores: number[] = [];
  private pairs: Array<[number, number, number, number]> = [];
  get size() { return this.scores.length; }
  push(score: number, pair: [number, number, number, number]) {
    let index = this.scores.length;
    this.scores.push(score); this.pairs.push(pair);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.scores[parent] >= score) break;
      this.swap(index, parent); index = parent;
    }
  }
  pop() {
    const score = this.scores[0], pair = this.pairs[0];
    const lastScore = this.scores.pop()!, lastPair = this.pairs.pop()!;
    if (this.scores.length) {
      this.scores[0] = lastScore; this.pairs[0] = lastPair;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1, right = left + 1;
        let top = index;
        if (left < this.scores.length && this.scores[left] > this.scores[top]) top = left;
        if (right < this.scores.length && this.scores[right] > this.scores[top]) top = right;
        if (top === index) break;
        this.swap(index, top); index = top;
      }
    }
    return { score, pair };
  }
  private swap(a: number, b: number) {
    [this.scores[a], this.scores[b]] = [this.scores[b], this.scores[a]];
    [this.pairs[a], this.pairs[b]] = [this.pairs[b], this.pairs[a]];
  }
}

/**
 * The server-found neighbours of each item's documents, by item position, when
 * at least some of the items have them; null means the all-pairs screen is needed.
 */
function neighbourListsOf(items: Array<{ documentIds: string[] }>, positions: number[], neighbours: NeighboursOf) {
  const lists = new Map<number, MeaningNeighbour[]>();
  for (const position of positions) {
    const list: MeaningNeighbour[] = [];
    for (const id of items[position].documentIds) { const near = neighbours(id); if (near) list.push(...near); }
    if (list.length) lists.set(position, list);
  }
  return lists.size ? lists : null;
}

/**
 * Candidate pairs by comparing every item's mean direction, cut to its leading
 * dimensions, with every other's: each item offers its closest few.
 */
function screenCandidates(items: Array<{ documentIds: string[] }>, searched: number[], sums: Array<Float64Array | null>, width: number,
  floor: number, addCandidate: (a: number, b: number) => void) {
  const screen = Math.min(width, SCREEN_DIMENSIONS);
  const rows = new Float64Array(searched.length * screen);
  searched.forEach((position, row) => {
    const sum = sums[position]!;
    let length = 0;
    for (let index = 0; index < screen; index++) length += sum[index] * sum[index];
    length = Math.sqrt(length) || 1;
    for (let index = 0; index < screen; index++) rows[row * screen + index] = sum[index] / length;
  });
  const top = searched.map(() => ({ kept: 0, best: new Float64Array(PARTNERS_PER_ITEM), rows: new Int32Array(PARTNERS_PER_ITEM) }));
  const offer = (row: number, other: number, similarity: number) => {
    const entry = top[row];
    if (similarity < floor || (entry.kept === PARTNERS_PER_ITEM && similarity <= entry.best[entry.kept - 1])) return;
    let slot = entry.kept < PARTNERS_PER_ITEM ? entry.kept++ : entry.kept - 1;
    while (slot > 0 && entry.best[slot - 1] < similarity) { entry.best[slot] = entry.best[slot - 1]; entry.rows[slot] = entry.rows[slot - 1]; slot--; }
    entry.best[slot] = similarity; entry.rows[slot] = other;
  };
  for (let i = 0; i < searched.length; i++) {
    const offsetI = i * screen;
    for (let j = i + 1; j < searched.length; j++) {
      const offsetJ = j * screen;
      // Four running sums let the engine pipeline the multiply-adds.
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0, index = 0;
      for (; index + 3 < screen; index += 4) {
        s0 += rows[offsetI + index] * rows[offsetJ + index];
        s1 += rows[offsetI + index + 1] * rows[offsetJ + index + 1];
        s2 += rows[offsetI + index + 2] * rows[offsetJ + index + 2];
        s3 += rows[offsetI + index + 3] * rows[offsetJ + index + 3];
      }
      for (; index < screen; index++) s0 += rows[offsetI + index] * rows[offsetJ + index];
      const similarity = s0 + s1 + s2 + s3;
      if (similarity < floor) continue;
      offer(i, j, similarity); offer(j, i, similarity);
    }
  }
  top.forEach((entry, row) => { for (let slot = 0; slot < entry.kept; slot++) addCandidate(searched[row], searched[entry.rows[slot]]); });
}

/**
 * Groups items (single documents or clusters) by meaning with average-linkage
 * agglomerative clustering: the two groups whose documents are most alike on
 * average merge first, until no pair reaches `threshold`. Linked groups get a
 * small bonus, so links settle close calls without deciding groups. Candidate
 * pairs come from each item's nearest neighbours, so the work stays near
 * items x neighbours rather than every pair. Items without embeddings stay alone.
 */
export function groupByTopicEmbedding(items: Array<{ documentIds: string[] }>,
  vectorOf: (id: string) => Float32Array | undefined, threshold = TOPIC_SIMILARITY_THRESHOLD,
  options: { links?: Array<[number, number]>; linkBonus?: number;
    /** Nearest documents found on the server; with them, candidates need no all-pairs search and every item is searched. */
    neighbours?: NeighboursOf } = {}): TopicGroup[] {
  const linkBonus = options.linkBonus ?? TOPIC_LINK_BONUS;
  // Each item's summed vectors and how many documents were summed.
  const sums: Array<Float64Array | null> = [];
  const counts: number[] = [];
  for (const item of items) {
    let sum: Float64Array | null = null, count = 0;
    for (const id of item.documentIds) {
      const vector = vectorOf(id);
      if (!vector) continue;
      if (!sum) sum = new Float64Array(vector.length);
      else if (sum.length !== vector.length) continue;
      for (let index = 0; index < vector.length; index++) sum[index] += vector[index];
      count++;
    }
    sums.push(sum); counts.push(count);
  }
  const width = sums.find(Boolean)?.length ?? 0;
  const embedded = items.map((_, position) => position).filter((position) => sums[position]?.length === width)
    .sort((a, b) => items[b].documentIds.length - items[a].documentIds.length || a - b);
  // With neighbours from the server, candidates come from them and no item is left unsearched.
  const neighbourLists = options.neighbours ? neighbourListsOf(items, embedded, options.neighbours) : null;
  const searched = neighbourLists ? embedded : embedded.slice(0, MAX_TOPIC_ITEMS);

  const candidates = new Map<number, Set<number>>();
  const addCandidate = (a: number, b: number) => {
    if (a === b) return;
    (candidates.get(a) ?? candidates.set(a, new Set()).get(a)!).add(b);
    (candidates.get(b) ?? candidates.set(b, new Set()).get(b)!).add(a);
  };
  // Screening is loose: a cut-short vector scores a little off its full one.
  const floor = threshold - 0.15;
  if (neighbourLists) {
    const itemOf = new Map<string, number>();
    for (const position of searched) for (const id of items[position].documentIds) itemOf.set(id, position);
    for (const [position, list] of neighbourLists) {
      for (const near of list) {
        if (near.similarity < floor) continue;
        const other = itemOf.get(near.id);
        if (other !== undefined) addCandidate(position, other);
      }
    }
  } else screenCandidates(items, searched, sums, width, floor, addCandidate);

  // Links between items, counted per pair of groups as groups merge.
  const linked = new Map<number, Map<number, number>>();
  const isSearched = new Set(searched);
  for (const [a, b] of options.links ?? []) {
    if (a === b || !isSearched.has(a) || !isSearched.has(b)) continue;
    for (const [from, to] of [[a, b], [b, a]]) {
      const map = linked.get(from) ?? linked.set(from, new Map()).get(from)!;
      map.set(to, (map.get(to) ?? 0) + 1);
    }
    addCandidate(a, b);
  }

  const version = items.map(() => 0);
  const alive = new Set(searched);
  const score = (a: number, b: number) => {
    const sumA = sums[a]!, sumB = sums[b]!;
    let total = 0;
    for (let index = 0; index < width; index++) total += sumA[index] * sumB[index];
    return total / (counts[a] * counts[b]) + (linked.get(a)?.has(b) ? linkBonus : 0);
  };
  const queue = new MergeQueue();
  for (const [a, others] of candidates) for (const b of others) {
    if (a >= b) continue;
    const similarity = score(a, b);
    if (similarity >= threshold) queue.push(similarity, [a, b, 0, 0]);
  }
  const members = new Map<number, number[]>(searched.map((position) => [position, [position]]));
  while (queue.size) {
    const { pair: [a, b, versionA, versionB] } = queue.pop();
    if (!alive.has(a) || !alive.has(b) || version[a] !== versionA || version[b] !== versionB) continue;
    // The larger group keeps its index.
    const [kept, absorbed] = counts[a] >= counts[b] ? [a, b] : [b, a];
    const keptSum = sums[kept]!, absorbedSum = sums[absorbed]!;
    for (let index = 0; index < width; index++) keptSum[index] += absorbedSum[index];
    counts[kept] += counts[absorbed];
    members.get(kept)!.push(...members.get(absorbed)!);
    members.delete(absorbed);
    alive.delete(absorbed);
    version[kept]++;
    const keptLinks = linked.get(kept) ?? linked.set(kept, new Map()).get(kept)!;
    for (const [other, count] of linked.get(absorbed) ?? []) {
      if (other === kept) continue;
      keptLinks.set(other, (keptLinks.get(other) ?? 0) + count);
      const otherLinks = linked.get(other)!;
      otherLinks.delete(absorbed);
      otherLinks.set(kept, (otherLinks.get(kept) ?? 0) + count);
    }
    keptLinks.delete(absorbed);
    linked.delete(absorbed);
    const keptCandidates = candidates.get(kept) ?? candidates.set(kept, new Set()).get(kept)!;
    for (const other of candidates.get(absorbed) ?? []) {
      if (other === kept) continue;
      keptCandidates.add(other);
      const set = candidates.get(other)!;
      set.delete(absorbed); set.add(kept);
    }
    keptCandidates.delete(absorbed);
    candidates.delete(absorbed);
    for (const other of keptCandidates) {
      if (!alive.has(other)) continue;
      const similarity = score(kept, other);
      if (similarity >= threshold) queue.push(similarity, kept < other ? [kept, other, version[kept], version[other]] : [other, kept, version[other], version[kept]]);
    }
  }

  // Members closest to their group's meaning first.
  const groups: TopicGroup[] = [];
  for (const [root, list] of members) {
    const sum = sums[root]!;
    const closeness = (position: number) => {
      let total = 0;
      for (const id of items[position].documentIds) {
        const vector = vectorOf(id);
        if (!vector || vector.length !== width) continue;
        for (let index = 0; index < width; index++) total += vector[index] * sum[index];
      }
      return total / Math.max(1, items[position].documentIds.length);
    };
    const ranked = list.map((position) => ({ position, closeness: closeness(position) }))
      .sort((x, y) => y.closeness - x.closeness || x.position - y.position);
    groups.push({ itemIndices: ranked.map((entry) => entry.position) });
  }
  items.forEach((_, position) => { if (!isSearched.has(position)) groups.push({ itemIndices: [position] }); });
  return groups;
}

/**
 * For each document, the index of the group whose mean direction it is
 * closest to, when that similarity reaches `threshold`; -1 otherwise.
 */
export function nearestTopicGroup(documentIds: string[], groups: string[][],
  vectorOf: (id: string) => Float32Array | undefined, threshold = TOPIC_ATTACH_THRESHOLD, neighbours?: NeighboursOf): number[] {
  const result = documentIds.map(() => -1);
  if (!documentIds.length || !groups.length) return result;
  // With neighbours from the server, a document joins the group of its nearest neighbour that has one.
  if (neighbours) {
    const groupOf = new Map<string, number>();
    groups.forEach((members, group) => { for (const id of members) groupOf.set(id, group); });
    let unresolved = 0;
    documentIds.forEach((id, position) => {
      const near = neighbours(id);
      if (!near) { unresolved++; return; }
      for (const entry of near) {
        if (entry.similarity < threshold) break;
        const group = groupOf.get(entry.id);
        if (group !== undefined) { result[position] = group; return; }
      }
      // Every neighbour is known, so a closer group than theirs cannot exist.
      result[position] = -2;
    });
    if (!unresolved) return result.map((value) => Math.max(-1, value));
    if (unresolved * groups.length > MAX_ATTACH_COMPARISONS) return result.map((value) => Math.max(-1, value));
  } else if (documentIds.length * groups.length > MAX_ATTACH_COMPARISONS) return result;
  const centers = groups.map((members) => {
    let sum: Float32Array | null = null;
    for (const id of members) {
      const vector = vectorOf(id);
      if (!vector) continue;
      if (!sum) sum = new Float32Array(vector.length);
      if (sum.length !== vector.length) continue;
      for (let index = 0; index < vector.length; index++) sum[index] += vector[index];
    }
    return sum ? unit(sum) : null;
  });
  documentIds.forEach((id, position) => {
    if (result[position] !== -1) { result[position] = Math.max(-1, result[position]); return; }
    const vector = vectorOf(id);
    if (!vector) return;
    let best = threshold, bestGroup = -1;
    centers.forEach((center, group) => {
      if (!center || center.length !== vector.length) return;
      const similarity = dot(vector, center);
      if (similarity >= best) { best = similarity; bestGroup = group; }
    });
    result[position] = bestGroup;
  });
  return result;
}
