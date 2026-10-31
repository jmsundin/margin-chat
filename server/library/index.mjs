import { randomUUID } from "node:crypto";
import { HttpError } from "../lib/errors.mjs";
import { createEmbeddings } from "../documents/embeddings.mjs";
import { getEmbeddingApiKey } from "../documents/index.mjs";
import { TOPIC_EMBEDDING_DIMENSIONS, TOPIC_EMBEDDING_MODEL } from "../documents/topics.mjs";
import { layoutLandscape, placeBesideNeighbours } from "../documents/landscape.mjs";
import { fetchPubMedArticles, searchPubMed } from "./pubmed.mjs";

/** Papers fetched per import request; the client asks again until the field is full. */
const PAPERS_PER_REQUEST = 200;
export const LIBRARY_DEFAULT_SIZE = 1000;
export const LIBRARY_MAX_SIZE = 5000;
const NEIGHBOURS_PER_WORK = 12;
/** A document of yours shows on a field only when a paper there is at least this close in meaning. */
export const LIBRARY_MIN_OWN_SIMILARITY = 0.35;

/**
 * Names each region by the PubMed major topic most particular to it: frequent
 * in the region, rare in the rest of the field.
 */
export function nameLibraryRegions(works, regionOf) {
  const fieldCounts = new Map(), regionCounts = new Map(), sizes = new Map();
  for (const work of works) {
    const region = regionOf.get(work.id) ?? -1;
    for (const topic of new Set(work.topics)) fieldCounts.set(topic, (fieldCounts.get(topic) ?? 0) + 1);
    if (region < 0) continue;
    sizes.set(region, (sizes.get(region) ?? 0) + 1);
    const counts = regionCounts.get(region) ?? regionCounts.set(region, new Map()).get(region);
    for (const topic of new Set(work.topics)) counts.set(topic, (counts.get(topic) ?? 0) + 1);
  }
  return [...regionCounts].sort((a, b) => a[0] - b[0]).map(([index, counts]) => {
    let best = null, bestScore = 0;
    for (const [topic, count] of counts) {
      if (count < 2) continue;
      // How much of the region has it, times how much of it is in this region.
      const score = (count / sizes.get(index)) * (count / fieldCounts.get(topic));
      if (score > bestScore || (score === bestScore && best !== null && topic < best)) { best = topic; bestScore = score; }
    }
    return { index, label: best, size: sizes.get(index) };
  });
}

export function createLibraryService({ database, env = process.env, embed = createEmbeddings, fetchImpl = fetch }) {
  const field = async (userId, fieldId) => {
    const found = typeof fieldId === "string" ? await database.readLibraryField({ userId, fieldId }) : null;
    if (!found) throw new HttpError(404, "That field is not in your library.");
    return found;
  };

  async function list({ userId }) {
    return { fields: await database.listLibraryFields({ userId }) };
  }

  async function create({ userId, query, size }) {
    const cleaned = typeof query === "string" ? query.replace(/\s+/g, " ").trim() : "";
    if (cleaned.length < 2 || cleaned.length > 300) throw new HttpError(400, "Describe the field in 2 to 300 characters, as you would search PubMed.");
    const target = Math.max(50, Math.min(LIBRARY_MAX_SIZE, Math.round(Number(size) || LIBRARY_DEFAULT_SIZE)));
    return { field: await database.createLibraryField({ userId, id: `field-${randomUUID()}`, query: cleaned, target }) };
  }

  async function remove({ userId, fieldId }) {
    if (!await database.deleteLibraryField({ userId, fieldId })) throw new HttpError(404, "That field is not in your library.");
    return { ok: true };
  }

  /**
   * One step of filling a field: fetch the next papers from PubMed, then
   * embed papers that have no vector yet (each paper is embedded once for
   * every reader). `done` once the field is full and every paper embedded.
   */
  async function importStep({ userId, fieldId, context }) {
    const current = await field(userId, fieldId);
    if (current.fetched < current.target && (current.available === null || current.fetched < current.available)) {
      const count = Math.min(PAPERS_PER_REQUEST, current.target - current.fetched);
      const found = await searchPubMed({ query: current.query, start: current.fetched, count, env, fetchImpl, signal: context.signal });
      const articles = (await fetchPubMedArticles({ ids: found.ids, env, fetchImpl, signal: context.signal }))
        .filter((article) => article.title && article.abstract);
      await database.saveLibraryWorks({ works: articles });
      const byId = new Map(articles.map((article) => [article.id, article]));
      const ordered = found.ids.map((id) => `pubmed:${id}`).filter((id) => byId.has(id));
      await database.linkLibraryWorks({ fieldId, ids: ordered, startRank: current.fetched,
        fetched: found.ids.length ? current.fetched + found.ids.length : current.target, available: found.total });
    }
    const waiting = await database.listUnembeddedLibraryWorks({ fieldId, model: TOPIC_EMBEDDING_MODEL, limit: PAPERS_PER_REQUEST });
    if (waiting.length) {
      const apiKey = getEmbeddingApiKey(context, env);
      if (!apiKey) throw new HttpError(503, "Placing papers by meaning needs OpenAI. Allow OpenAI, add your own OpenAI key, or use a plan with hosted AI.");
      const vectors = await embed({ apiKey, userId, signal: context.signal, dimensions: TOPIC_EMBEDDING_DIMENSIONS,
        usageMeter: context.apiKeys?.openai ? null : context.usageMeter,
        inputs: waiting.map((work) => `${work.title}\n\n${work.abstract}`.slice(0, 2000)) });
      await database.saveLibraryVectors({ model: TOPIC_EMBEDDING_MODEL, vectors: waiting.map((work, index) => ({ id: work.id, vector: vectors[index] })) });
    }
    const after = await field(userId, fieldId);
    const full = after.fetched >= after.target || (after.available !== null && after.fetched >= after.available);
    return { field: after, done: full && after.embedded >= after.works };
  }

  /** Lays the field's papers out from their nearest papers and names the regions. */
  async function layout({ userId, fieldId }) {
    await field(userId, fieldId);
    const neighbours = await database.readLibraryNeighbours({ fieldId, perWork: NEIGHBOURS_PER_WORK });
    const before = await database.readLibraryMap({ userId, fieldId, perDocument: 0 });
    const previous = new Map(before.works.map((work) => [work.id, work]));
    const { positions } = layoutLandscape({ neighbours, previous });
    const topics = await database.readLibraryWorkTopics({ fieldId });
    const regions = nameLibraryRegions([...positions.keys()].map((id) => ({ id, topics: topics.get(id) ?? [] })),
      new Map([...positions].map(([id, at]) => [id, at.region])));
    await database.writeLibraryLayout({ fieldId, regions, positions: [...positions].map(([id, at]) => ({ id, ...at })) });
    return read({ userId, fieldId });
  }

  /**
   * A field as the map draws it: its papers at their positions, region names,
   * and those of your documents close enough to a paper there, placed beside
   * their nearest papers.
   */
  async function read({ userId, fieldId }) {
    const current = await field(userId, fieldId);
    const { works, own } = await database.readLibraryMap({ userId, fieldId, perDocument: 6 });
    const positions = new Map(works.map((work) => [work.id, work]));
    const placed = own.filter((entry) => entry.neighbours[0]?.similarity >= LIBRARY_MIN_OWN_SIMILARITY).flatMap((entry) => {
      const at = placeBesideNeighbours(entry.id, entry.neighbours, positions);
      return at ? [{ id: entry.id, x: Math.round(at.x), y: Math.round(at.y), region: at.region, nearest: entry.neighbours[0].id }] : [];
    });
    return { field: current, works: works.map(({ id, title, year, x, y, region }) => ({ id, title, year, x, y, region })), own: placed };
  }

  async function work({ userId, workId }) {
    const found = typeof workId === "string" && /^pubmed:\d{1,12}$/.test(workId) ? await database.readLibraryWork({ userId, workId }) : null;
    if (!found) throw new HttpError(404, "That paper is not in your library.");
    return { work: found };
  }

  return { list, create, remove, importStep, layout, read, work };
}
