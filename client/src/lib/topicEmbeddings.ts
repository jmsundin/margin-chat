/**
 * Grouping by subject for the Clusters view. Each document has an embedding (a
 * meaning fingerprint made on the server); clusters whose documents mean
 * similar things merge, so notes on Angular, ViewChild and Angular components
 * share one cluster even when nobody linked them.
 */

/**
 * Cosine similarity two groups need to merge. text-embedding-3-small scores
 * different documents on one subject (Angular components, ViewChild) around
 * 0.45 to 0.6, and documents that only share a broad field (Angular and
 * React) lower. 0.5 left Jon's Angular clusters apart on real documents.
 */
export const TOPIC_SIMILARITY_THRESHOLD = 0.42;
/**
 * An unlinked document that matched no other item joins the cluster it is
 * closest to when it scores at least this, so few documents stay unfiled.
 */
export const TOPIC_ATTACH_THRESHOLD = 0.3;
/** Unlinked documents times clusters compared when filing documents. */
const MAX_ATTACH_COMPARISONS = 1_500_000;
/** Strongest partners kept per item before merging. */
const PARTNERS_PER_ITEM = 8;
/** Items compared pairwise; beyond this the largest clusters are compared and the rest keep their links-only grouping. */
export const MAX_TOPIC_ITEMS = 1_200;

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

export interface TopicGroup {
  /** Indices into the items passed in, largest item first. */
  itemIndices: number[];
}

/**
 * Merges items (clusters or single documents) whose documents mean similar
 * things, most similar pairs first. A pair only merges while the two growing
 * groups still match as wholes, so a chain of loosely related notes does not
 * snowball into one blob. Items without embeddings stay alone.
 */
export function groupByTopicEmbedding(items: Array<{ documentIds: string[] }>,
  vectorOf: (id: string) => Float32Array | undefined, threshold = TOPIC_SIMILARITY_THRESHOLD): TopicGroup[] {
  // Each item's mean direction, plus its unnormalized sum for growing groups.
  const sums: Array<Float32Array | null> = items.map((item) => {
    let sum: Float32Array | null = null;
    for (const id of item.documentIds) {
      const vector = vectorOf(id);
      if (!vector) continue;
      if (!sum) sum = new Float32Array(vector.length);
      else if (sum.length !== vector.length) continue;
      for (let index = 0; index < vector.length; index++) sum[index] += vector[index];
    }
    return sum;
  });
  const compared = items.map((_, position) => position).filter((position) => sums[position])
    .sort((a, b) => items[b].documentIds.length - items[a].documentIds.length || a - b).slice(0, MAX_TOPIC_ITEMS);
  // One flat matrix of unit rows keeps the pairwise loop tight.
  const width = compared.length ? sums[compared[0]]!.length : 0;
  const rows = new Float64Array(compared.length * width);
  compared.forEach((position, row) => {
    const direction = unit(Float32Array.from(sums[position]!));
    if (direction.length === width) rows.set(direction, row * width);
  });

  const pairs: Array<{ a: number; b: number; similarity: number }> = [];
  const best = new Float64Array(PARTNERS_PER_ITEM);
  const bestRow = new Int32Array(PARTNERS_PER_ITEM);
  for (let i = 0; i < compared.length; i++) {
    let kept = 0;
    const offsetI = i * width;
    for (let j = i + 1; j < compared.length; j++) {
      const offsetJ = j * width;
      // Four running sums let the engine pipeline the multiply-adds.
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0, index = 0;
      for (; index + 3 < width; index += 4) {
        s0 += rows[offsetI + index] * rows[offsetJ + index];
        s1 += rows[offsetI + index + 1] * rows[offsetJ + index + 1];
        s2 += rows[offsetI + index + 2] * rows[offsetJ + index + 2];
        s3 += rows[offsetI + index + 3] * rows[offsetJ + index + 3];
      }
      for (; index < width; index++) s0 += rows[offsetI + index] * rows[offsetJ + index];
      const similarity = s0 + s1 + s2 + s3;
      if (similarity < threshold || (kept === PARTNERS_PER_ITEM && similarity <= best[kept - 1])) continue;
      // Insert into the short list of the strongest partners, strongest first.
      let slot = kept < PARTNERS_PER_ITEM ? kept++ : kept - 1;
      while (slot > 0 && best[slot - 1] < similarity) { best[slot] = best[slot - 1]; bestRow[slot] = bestRow[slot - 1]; slot--; }
      best[slot] = similarity; bestRow[slot] = j;
    }
    for (let slot = 0; slot < kept; slot++) {
      const a = compared[i], b = compared[bestRow[slot]];
      pairs.push(a < b ? { a, b, similarity: best[slot] } : { a: b, b: a, similarity: best[slot] });
    }
  }
  pairs.sort((x, y) => y.similarity - x.similarity || x.a - y.a || x.b - y.b);

  const parent = items.map((_, position) => position);
  const find = (position: number): number => {
    while (parent[position] !== position) { parent[position] = parent[parent[position]]; position = parent[position]; }
    return position;
  };
  const groupSum = new Map(compared.map((position) => [position, Float32Array.from(sums[position]!)]));
  const cosine = (a: Float32Array, b: Float32Array) => dot(a, b) / Math.sqrt(dot(a, a) * dot(b, b) || 1);
  for (const { a, b } of pairs) {
    const rootA = find(a), rootB = find(b);
    if (rootA === rootB) continue;
    const sumA = groupSum.get(rootA)!, sumB = groupSum.get(rootB)!;
    if (cosine(sumA, sumB) < threshold) continue;
    const [kept, absorbed] = rootA < rootB ? [rootA, rootB] : [rootB, rootA];
    parent[absorbed] = kept;
    const keptSum = groupSum.get(kept)!, absorbedSum = groupSum.get(absorbed)!;
    for (let index = 0; index < keptSum.length; index++) keptSum[index] += absorbedSum[index];
    groupSum.delete(absorbed);
  }

  const members = new Map<number, number[]>();
  items.forEach((_, position) => {
    const root = find(position);
    const list = members.get(root);
    if (list) list.push(position); else members.set(root, [position]);
  });
  return [...members.values()].map((itemIndices) => ({
    itemIndices: itemIndices.sort((a, b) => items[b].documentIds.length - items[a].documentIds.length || a - b),
  }));
}

/**
 * For each document, the index of the group whose mean direction it is
 * closest to, when that similarity reaches `threshold`; -1 otherwise.
 */
export function nearestTopicGroup(documentIds: string[], groups: string[][],
  vectorOf: (id: string) => Float32Array | undefined, threshold = TOPIC_ATTACH_THRESHOLD): number[] {
  const result = documentIds.map(() => -1);
  if (!documentIds.length || !groups.length || documentIds.length * groups.length > MAX_ATTACH_COMPARISONS) return result;
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
