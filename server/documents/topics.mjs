import { HttpError } from "../lib/errors.mjs";
import { createEmbeddings, DOCUMENT_EMBEDDING_MODEL } from "./embeddings.mjs";
import { getEmbeddingApiKey } from "./index.mjs";

/** Fewer dimensions than search uses: enough to tell subjects apart, small enough to send every document's to the map. */
export const TOPIC_EMBEDDING_DIMENSIONS = 512;
export const TOPIC_EMBEDDING_MODEL = `${DOCUMENT_EMBEDDING_MODEL}@${TOPIC_EMBEDDING_DIMENSIONS}`;
/** A document's subject is set by its title and opening; about 500 tokens. */
const TOPIC_TEXT_CHARACTERS = 2_000;
/** Documents embedded per request; the map asks again while more are waiting. */
const DOCUMENTS_PER_REQUEST = 256;
/** Documents whose nearest neighbours are found per request, for documents embedded before neighbours were kept. */
const NEIGHBOUR_CATCH_UP_PER_REQUEST = 256;

/** Signed bytes scaled to the largest component; cosine similarity survives the rounding. */
export function quantizeEmbedding(values) {
  let largest = 0;
  for (const value of values) largest = Math.max(largest, Math.abs(value));
  const scale = largest ? 127 / largest : 0;
  return Buffer.from(Int8Array.from(values, (value) => Math.round(value * scale)).buffer).toString("base64");
}

export function createTopicEmbeddingService({ database, env = process.env, embed = createEmbeddings }) {
  /**
   * Embeds documents that are new or changed since their last embedding (one
   * batch per call), then returns embeddings changed after `since`. Without an
   * OpenAI key the stored embeddings are still returned.
   */
  async function sync({ userId, context, since }) {
    if (!database?.listStaleTopicSources) return { model: TOPIC_EMBEDDING_MODEL, dimensions: TOPIC_EMBEDDING_DIMENSIONS, embeddings: [], neighbours: [], cursor: null, pending: 0, placements: [] };
    const stale = await database.listStaleTopicSources({ userId, model: TOPIC_EMBEDDING_MODEL, limit: DOCUMENTS_PER_REQUEST, maxCharacters: TOPIC_TEXT_CHARACTERS });
    const apiKey = getEmbeddingApiKey(context, env);
    let pending = stale.remaining;
    let unavailable;
    if (stale.sources.length && !apiKey) {
      unavailable = "Grouping by subject needs OpenAI. Allow OpenAI, add your own OpenAI key, or use a plan with hosted AI.";
    } else if (stale.sources.length) {
      const vectors = await embed({
        apiKey,
        inputs: stale.sources.map((source) => `${source.title}\n\n${source.text}`.trim()),
        userId,
        signal: context.signal,
        usageMeter: context.apiKeys?.openai ? null : context.usageMeter,
        dimensions: TOPIC_EMBEDDING_DIMENSIONS,
      });
      context.signal?.throwIfAborted();
      await database.saveTopicEmbeddings({ userId, model: TOPIC_EMBEDDING_MODEL, embeddings: stale.sources.map((source, index) => ({
        id: source.id, contentHash: source.contentHash, embedding: quantizeEmbedding(vectors[index]),
      })) });
      pending -= stale.sources.length;
      await database.refreshTopicNeighbours?.({ userId, ids: stale.sources.map((source) => source.id) });
    }
    const stored = await database.readTopicEmbeddings({ userId, model: TOPIC_EMBEDDING_MODEL, since });
    // Documents embedded before neighbours were kept get theirs a batch at a time.
    let neighbours = { neighbours: [], cursor: null };
    if (database.readTopicNeighbours) {
      const unneighboured = await database.listUnneighbouredTopicDocuments({ userId, limit: NEIGHBOUR_CATCH_UP_PER_REQUEST });
      if (unneighboured.ids.length) await database.refreshTopicNeighbours({ userId, ids: unneighboured.ids });
      pending += Math.max(0, unneighboured.remaining - unneighboured.ids.length);
      neighbours = await database.readTopicNeighbours({ userId, since });
    }
    const placements = database.readTopicPlacements ? await database.readTopicPlacements({ userId }) : [];
    const cursor = [stored.cursor, neighbours.cursor].filter(Boolean).sort().at(-1) ?? null;
    return { model: TOPIC_EMBEDDING_MODEL, dimensions: TOPIC_EMBEDDING_DIMENSIONS, embeddings: stored.embeddings, neighbours: neighbours.neighbours,
      cursor, pending: Math.max(0, pending), placements, ...(unavailable ? { unavailable } : {}) };
  }

  /** Remembers that the user moved `id` to the cluster of `anchorId`; null returns it to automatic placement. */
  async function place({ userId, id, anchorId }) {
    const valid = (value) => typeof value === "string" && value.trim() && value.length <= 256;
    if (!valid(id) || (anchorId !== null && (!valid(anchorId) || anchorId === id))) {
      throw new HttpError(400, "Choose a document and the document whose cluster it joins.");
    }
    await database.writeTopicPlacement({ userId, id, anchorId });
    return { id, anchorId };
  }

  return { sync, place };
}
