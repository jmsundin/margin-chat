/**
 * Word-based topic matching for the Clusters view. Each document becomes a
 * TF-IDF vector of the words in its title and opening text; documents and
 * clusters are compared by cosine similarity. It runs in the browser with no
 * AI calls, so notes about one subject (say "Angular", "Angular components"
 * and "ViewChild") can share a cluster even when nobody linked them.
 */

export type TopicVector = Map<string, number>;

export interface TopicDocument {
  id: string;
  title: string;
  text: string;
}

/** Titles name a document's subject, so their words count several times. */
const TITLE_WEIGHT = 3;
/** Only the opening of a document is read; it is where the subject is set. */
const BODY_CHARACTERS = 2_000;
/** Text read across the whole vault, so large vaults read less of each document and stay quick. */
const TOTAL_BODY_CHARACTERS = 2_000_000;
/** Strongest words kept per document; the rest are noise for grouping. */
const DOCUMENT_TERMS = 24;
/** Strongest words kept per cluster as clusters merge. */
const GROUP_TERMS = 48;
/** A word shared by many items only suggests partners among the items it weighs most in. */
const MAX_POSTING = 64;
/** One word in common is chance ("Plan", "Meeting"); a topic shows up as several. */
const MIN_SHARED_WORDS = 2;
/** Candidate partners kept per item before merging. */
const PARTNERS_PER_ITEM = 8;
/**
 * Cosine similarity two clusters need to merge. One strongly shared title word
 * ("Angular") scores about 0.2; words two unrelated notes share in passing
 * score well under 0.1.
 */
export const TOPIC_MERGE_THRESHOLD = 0.2;

const STOPWORDS = new Set(`
a about above after again against all almost also although always am among an and another any anyone anything are
around as at be because been before being below between both but by can cannot could did do does doing done down
during each either else enough etc even ever every few for from further get gets getting go goes going got had has
have having he her here hers herself him himself his how however i if in into is it its itself just know let like
made make makes many may me might mine more most much must my myself need needs new no nor not now of off often on
once one only or other others our ours ourselves out over own per perhaps please rather really said same say says
see seem seems several shall she should since so some something sometimes still such take than that the their theirs
them themselves then there therefore these they thing things this those though through thus to too toward under
until up upon us use used uses using very via want was way ways we well were what whatever when where whether which
while who whom whose why will with within without would yes yet you your yours yourself yourselves
able across actually already another back best better big called come comes first given good great here's i'm
it's last least less let's lot lots maybe next part put show shows simply sure that's there's they're two three
we're what's work works you're you've
untitled document documents note notes page chat chats conversation draft copy summary overview introduction intro
question questions answer answers example examples user assistant http https www com org html md
`.trim().split(/\s+/u));

const TAG = /<[^>]+>/gu;
const URL = /\b(?:https?:\/\/|www\.)\S+/giu;
const LINK_TARGET = /\]\([^)]*\)/gu;
const WORD = /\p{L}[\p{L}\p{N}]*/gu;

/** A word's key: lower case and folded plurals, so "Components" meets "component". */
function stem(word: string) {
  const length = word.length;
  if (length <= 4 || word.charCodeAt(length - 1) !== 115 /* s */) return word;
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  const before = word.charCodeAt(length - 2);
  return before === 115 || before === 117 || before === 105 /* ss, us, is */ ? word : word.slice(0, -1);
}

function forEachWord(text: string, visit: (key: string, surface: string) => void) {
  const cleaned = text.replace(TAG, " ").replace(URL, " ").replace(LINK_TARGET, "] ");
  for (const [surface] of cleaned.matchAll(WORD)) {
    if (surface.length < 3 || surface.length > 32) continue;
    const lower = surface.toLowerCase();
    if (STOPWORDS.has(lower)) continue;
    const key = stem(lower);
    if (!STOPWORDS.has(key)) visit(key, surface);
  }
}

export interface TopicIndex {
  vectors: Map<string, TopicVector>;
  /** How a word was most often written in titles, for naming a topic. */
  display: (term: string) => string;
}

/** TF-IDF vectors, unit length, holding each document's strongest words. */
export function buildTopicIndex(documents: TopicDocument[]): TopicIndex {
  const counts: Array<Map<string, number>> = [];
  const documentFrequency = new Map<string, number>();
  const surfaces = new Map<string, Map<string, number>>();
  const noteSurface = (key: string, surface: string, weight: number) => {
    let forms = surfaces.get(key);
    if (!forms) surfaces.set(key, forms = new Map());
    forms.set(surface, (forms.get(surface) ?? 0) + weight);
  };
  const bodyCharacters = Math.min(BODY_CHARACTERS, Math.floor(TOTAL_BODY_CHARACTERS / Math.max(1, documents.length)));
  for (const document of documents) {
    const count = new Map<string, number>();
    forEachWord(document.title, (key, surface) => {
      count.set(key, (count.get(key) ?? 0) + TITLE_WEIGHT);
      noteSurface(key, surface, 10);
    });
    forEachWord(document.text.slice(0, bodyCharacters), (key, surface) => {
      count.set(key, (count.get(key) ?? 0) + 1);
      // Body spellings only matter where they differ from plain lower case, like "TypeScript".
      if (surface.charCodeAt(0) < 97 || surface.charCodeAt(0) > 122) noteSurface(key, surface, 1);
    });
    counts.push(count);
    for (const key of count.keys()) documentFrequency.set(key, (documentFrequency.get(key) ?? 0) + 1);
  }
  const total = documents.length;
  // In a vault of any size, a word in over half its documents names nothing in particular.
  const tooCommon = total >= 8 ? total / 2 : Infinity;
  const vectors = new Map<string, TopicVector>();
  documents.forEach((document, index) => {
    const weighted: Array<[string, number]> = [];
    for (const [key, count] of counts[index]) {
      // A word said once in passing is not what the document is about; title words always count.
      if (count < 2) continue;
      const frequency = documentFrequency.get(key)!;
      // A word no other document uses cannot match anything; it would only dilute the rest.
      if (frequency < 2 || frequency > tooCommon) continue;
      weighted.push([key, (1 + Math.log(count)) * Math.log(1 + total / frequency)]);
    }
    if (weighted.length) vectors.set(document.id, normalize(strongest(weighted, DOCUMENT_TERMS)));
  });
  const display = (term: string) => {
    const forms = surfaces.get(term);
    if (!forms) return term;
    let best = term, weight = -1;
    for (const [surface, count] of forms) if (count > weight || (count === weight && surface < best)) { best = surface; weight = count; }
    // A lower-case word reads better capitalized as a heading.
    return best === best.toLocaleLowerCase() ? best.charAt(0).toLocaleUpperCase() + best.slice(1) : best;
  };
  return { vectors, display };
}

function strongest(weighted: Array<[string, number]>, limit: number) {
  weighted.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return new Map(weighted.slice(0, limit));
}

function normalize(vector: TopicVector): TopicVector {
  let sum = 0;
  for (const value of vector.values()) sum += value * value;
  const length = Math.sqrt(sum) || 1;
  return new Map([...vector].map(([key, value]) => [key, value / length]));
}

function magnitude(vector: TopicVector) {
  let sum = 0;
  for (const value of vector.values()) sum += value * value;
  return Math.sqrt(sum);
}

export function cosine(a: TopicVector, b: TopicVector) {
  return cosineWith(a, magnitude(a), b, magnitude(b));
}

function cosineWith(a: TopicVector, lengthA: number, b: TopicVector, lengthB: number) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [key, value] of small) dot += value * (large.get(key) ?? 0);
  return dot ? dot / (lengthA * lengthB) : 0;
}

function addInto(target: TopicVector, source: TopicVector) {
  for (const [key, value] of source) target.set(key, (target.get(key) ?? 0) + value);
}

function centroid(documentIds: string[], vectors: Map<string, TopicVector>) {
  const sum: TopicVector = new Map();
  for (const id of documentIds) {
    const vector = vectors.get(id);
    if (vector) addInto(sum, vector);
  }
  return sum;
}

export interface TopicGroup {
  /** Indices into the items passed in, largest item first. */
  itemIndices: number[];
  /** The word most of the group's documents share, as written in titles; set for merged groups. */
  topic?: string;
}

/**
 * Merges items (clusters or single documents) whose words are similar enough,
 * most similar pairs first. A pair only merges while the two growing groups
 * still match as wholes, so a chain of loosely related notes does not snowball
 * into one blob. Items without words stay alone.
 */
export function groupByTopic(items: Array<{ documentIds: string[] }>, index: TopicIndex,
  threshold = TOPIC_MERGE_THRESHOLD): TopicGroup[] {
  const centroids = items.map((item) => strongest([...centroid(item.documentIds, index.vectors)], GROUP_TERMS));
  // Each word's items and that word's weight in them, strongest first, cut to MAX_POSTING.
  const postingLists = new Map<string, Array<[number, number]>>();
  centroids.forEach((vector, position) => {
    for (const [key, value] of vector) {
      const list = postingLists.get(key);
      if (list) list.push([position, value]); else postingLists.set(key, [[position, value]]);
    }
  });
  const postings = new Map<string, { items: Int32Array; weights: Float64Array }>();
  for (const [key, list] of postingLists) {
    if (list.length < 2) continue;
    if (list.length > MAX_POSTING) list.sort((x, y) => y[1] - x[1] || x[0] - y[0]);
    const kept = list.slice(0, MAX_POSTING);
    postings.set(key, { items: Int32Array.from(kept, (entry) => entry[0]), weights: Float64Array.from(kept, (entry) => entry[1]) });
  }
  const pairs: Array<{ a: number; b: number; similarity: number }> = [];
  const lengths = centroids.map(magnitude);
  // Dense scratch space: summing overlaps in a typed array is far quicker than in a Map.
  const overlap = new Float64Array(items.length);
  const shared = new Uint16Array(items.length);
  const touched: number[] = [];
  centroids.forEach((vector, position) => {
    for (const other of touched) { overlap[other] = 0; shared[other] = 0; }
    touched.length = 0;
    for (const [key, value] of vector) {
      const posting = postings.get(key);
      if (!posting) continue;
      const { items: others, weights } = posting;
      for (let entry = 0; entry < others.length; entry++) {
        const other = others[entry];
        if (other === position) continue;
        if (!shared[other]) touched.push(other);
        overlap[other] += value * weights[entry];
        shared[other]++;
      }
    }
    // Postings may be cut short, so the overlap only shortlists; the full similarity decides.
    const shortlist = touched.filter((other) => shared[other] >= MIN_SHARED_WORDS).sort((x, y) => overlap[y] - overlap[x] || x - y).slice(0, PARTNERS_PER_ITEM * 2);
    const partners: Array<{ a: number; b: number; similarity: number }> = [];
    for (const other of shortlist) {
      const similarity = cosineWith(vector, lengths[position], centroids[other], lengths[other]);
      if (similarity >= threshold) partners.push(position < other ? { a: position, b: other, similarity } : { a: other, b: position, similarity });
    }
    partners.sort((x, y) => y.similarity - x.similarity || x.a - y.a || x.b - y.b);
    pairs.push(...partners.slice(0, PARTNERS_PER_ITEM));
  });
  pairs.sort((x, y) => y.similarity - x.similarity || x.a - y.a || x.b - y.b);

  const parent = items.map((_, position) => position);
  const find = (position: number): number => {
    while (parent[position] !== position) { parent[position] = parent[parent[position]]; position = parent[position]; }
    return position;
  };
  const groupVector = centroids.map((vector) => new Map(vector));
  for (const { a, b } of pairs) {
    const rootA = find(a), rootB = find(b);
    if (rootA === rootB || cosine(groupVector[rootA], groupVector[rootB]) < threshold) continue;
    const [kept, absorbed] = rootA < rootB ? [rootA, rootB] : [rootB, rootA];
    parent[absorbed] = kept;
    addInto(groupVector[kept], groupVector[absorbed]);
    groupVector[kept] = strongest([...groupVector[kept]], GROUP_TERMS);
    groupVector[absorbed] = new Map();
  }

  const members = new Map<number, number[]>();
  items.forEach((_, position) => {
    const root = find(position);
    const list = members.get(root);
    if (list) list.push(position); else members.set(root, [position]);
  });
  return [...members.values()].map((itemIndices) => {
    itemIndices.sort((a, b) => items[b].documentIds.length - items[a].documentIds.length || a - b);
    if (itemIndices.length < 2) return { itemIndices };
    return { itemIndices, topic: sharedTopic(itemIndices.map((position) => centroids[position]), index) };
  });
}

/** The strongest word that at least half of the merged items share. */
function sharedTopic(parts: TopicVector[], index: TopicIndex) {
  const weight = new Map<string, number>();
  const holders = new Map<string, number>();
  for (const vector of parts) {
    const length = magnitude(vector) || 1;
    for (const [key, value] of vector) {
      weight.set(key, (weight.get(key) ?? 0) + value / length);
      holders.set(key, (holders.get(key) ?? 0) + 1);
    }
  }
  let best: string | undefined, bestWeight = 0;
  for (const [key, total] of weight) {
    if (holders.get(key)! * 2 < parts.length) continue;
    if (total > bestWeight || (total === bestWeight && best !== undefined && key < best)) { best = key; bestWeight = total; }
  }
  return best === undefined ? undefined : index.display(best);
}
