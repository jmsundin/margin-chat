import { chunkDocumentSections } from "../documents/chunking.mjs";
import { createEmbeddings } from "../documents/embeddings.mjs";
import { extractDocumentText } from "../documents/extraction.mjs";
import { getEmbeddingApiKey } from "../documents/index.mjs";
import { quantizeEmbedding, TOPIC_EMBEDDING_DIMENSIONS, TOPIC_EMBEDDING_MODEL } from "../documents/topics.mjs";
import { buildFilePassages, buildSourcePassages, LEAD_CHARACTERS, MAX_SOURCE_CHARACTERS, passageEmbeddingInput } from "./passages.mjs";
import { passageSnippet, vaultSearchTerms } from "./search.mjs";

/**
 * Search over every saved document, note, chat and uploaded file, by keyword
 * and by meaning. Passages are kept current a batch at a time (the app asks
 * while it is open, see useVaultPassageIndex), so a save never waits on it.
 * Embeddings use the topic embeddings' model and size, and a document's opening
 * passage shares its topic embedding instead of paying for the same text twice.
 */
export const PASSAGE_EMBEDDING_MODEL = TOPIC_EMBEDDING_MODEL;
const SOURCES_PER_REQUEST = 100;
const FILES_PER_REQUEST = 4;
const PASSAGES_PER_REQUEST = 256;
/** Passages each of keyword and meaning search consider before they are merged. */
const SEARCH_CANDIDATES = 50;
/** A passage found only by meaning must be at least this close to the query. */
const MIN_MEANING_SIMILARITY = 0.25;
const QUERY_CACHE_SIZE = 256;
const MAX_QUERY_CHARACTERS = 2_000;
const SNIPPET_CHARACTERS = 280;

export const PASSAGE_EMBEDDINGS_OFF = "Search by meaning is off in Settings. Exact-word search still works.";
const NO_OPENAI = "Search by meaning needs OpenAI. Allow OpenAI, add your own OpenAI key, or use a plan with hosted AI.";

/** Signed bytes (a stored topic embedding) back to a unit vector. */
function decodeQuantized(base64) {
  const bytes = new Int8Array(Buffer.from(base64, "base64"));
  if (bytes.length !== TOPIC_EMBEDDING_DIMENSIONS) return null;
  let length = 0;
  for (const value of bytes) length += value * value;
  length = Math.sqrt(length);
  return length ? Array.from(bytes, (value) => value / length) : null;
}

/** The text around the first query word it contains, or its opening when it matched by meaning alone. */
function snippet(text, terms) {
  const around = passageSnippet(text, terms);
  if (around) return around.snippet;
  const clean = String(text ?? "").replace(/\s+/gu, " ").trim();
  return clean.length <= SNIPPET_CHARACTERS ? clean : `${clean.slice(0, SNIPPET_CHARACTERS - 1).replace(/\s+\S*$/u, "")}…`;
}

const isAbort = (error) => error?.name === "AbortError";

export function createVaultPassageService({ database, env = process.env, embed = createEmbeddings, extract = extractDocumentText }) {
  const available = Boolean(database?.listStalePassageSources && database?.searchPassages);
  const queryEmbeddings = new Map();

  async function settings(userId) {
    return database?.readVaultIndexSettings ? database.readVaultIndexSettings({ userId }) : { cloudEmbeddings: true };
  }

  async function status(userId) {
    if (!available) return { available: false, cloudEmbeddings: false, passages: 0, embedded: 0 };
    const [current, counts] = await Promise.all([settings(userId), database.readPassageIndexStatus({ userId, model: PASSAGE_EMBEDDING_MODEL })]);
    return { available: true, cloudEmbeddings: current.cloudEmbeddings, ...counts };
  }

  /** Turns embeddings on or off; off also removes every stored passage embedding. */
  async function setCloudEmbeddings({ userId, enabled }) {
    if (!available) return status(userId);
    await database.writeVaultIndexSettings({ userId, cloudEmbeddings: enabled === true });
    if (enabled !== true) {
      await database.clearPassageEmbeddings({ userId });
      for (const key of queryEmbeddings.keys()) if (key.startsWith(`${userId}\n`)) queryEmbeddings.delete(key);
    }
    return status(userId);
  }

  /** Rebuilds the passages of a batch of changed sources; no network calls except to read stored files. */
  async function refreshPassages(userId) {
    await database.deleteMissingPassageSources({ userId });
    const [conversations, files] = await Promise.all([
      database.listStalePassageSources({ userId, limit: SOURCES_PER_REQUEST, maxCharacters: MAX_SOURCE_CHARACTERS, leadCharacters: LEAD_CHARACTERS }),
      database.listStaleFilePassageSources ? database.listStaleFilePassageSources({ userId, limit: FILES_PER_REQUEST }) : { sources: [], remaining: 0 },
    ]);
    const prepared = conversations.sources.map((source) => ({
      ...source, passages: buildSourcePassages({ title: source.title, body: source.body, lead: source.lead, blocks: source.blocks, topicHash: source.topicHash }),
    }));
    for (const file of files.sources) {
      let passages = [];
      let error = null;
      try {
        const sections = await extract({ buffer: Buffer.from(file.bytes), filename: file.title, mimeType: file.mimeType ?? "" });
        passages = buildFilePassages({ title: file.title, chunks: chunkDocumentSections(sections) });
      } catch (failure) {
        // Recorded, so the same unreadable file is not tried again until it changes.
        error = String(failure?.message ?? "The file's text could not be read.").slice(0, 300);
      }
      prepared.push({ ...file, bytes: undefined, passages, error });
    }
    await database.replacePassageSources({ userId, sources: prepared });
    return { remaining: conversations.remaining - conversations.sources.length + files.remaining - files.sources.length };
  }

  /** Embeds a batch of passages, reusing topic embeddings of the same text. */
  async function embedPassages(userId, context) {
    const waiting = await database.listUnembeddedPassages({ userId, model: PASSAGE_EMBEDDING_MODEL, limit: PASSAGES_PER_REQUEST });
    if (!waiting.passages.length) return { remaining: 0 };
    const openings = waiting.passages.filter((passage) => passage.sourceKind === "conversation" && passage.topicHash);
    const topics = openings.length && database.readMatchingTopicEmbeddings
      ? await database.readMatchingTopicEmbeddings({ userId, model: TOPIC_EMBEDDING_MODEL, openings: openings.map((passage) => ({ id: passage.sourceId, topicHash: passage.topicHash })) })
      : new Map();
    const reused = [];
    const fresh = [];
    for (const passage of waiting.passages) {
      const shared = passage.topicHash && passage.sourceKind === "conversation" ? topics.get(passage.sourceId) : undefined;
      const vector = shared ? decodeQuantized(shared) : null;
      if (vector) reused.push({ ...passage, vector });
      else fresh.push(passage);
    }
    if (reused.length) await database.savePassageEmbeddings({ userId, model: PASSAGE_EMBEDDING_MODEL, embeddings: reused });
    let remaining = waiting.remaining - reused.length;
    if (!fresh.length) return { remaining };
    const apiKey = getEmbeddingApiKey(context, env);
    if (!apiKey) return { remaining, unavailable: NO_OPENAI };
    let vectors;
    try {
      vectors = await embed({
        apiKey,
        inputs: fresh.map(passageEmbeddingInput),
        userId,
        signal: context.signal,
        usageMeter: context.apiKeys?.openai ? null : context.usageMeter,
        dimensions: TOPIC_EMBEDDING_DIMENSIONS,
      });
    } catch (error) {
      if (isAbort(error)) throw error;
      console.error("Vault passage embedding failed", error);
      return { remaining, unavailable: error?.billingFailure || error?.status === 402
        ? String(error.message ?? "Your AI balance is empty.") : "Search by meaning couldn't index new passages just now. It will try again." };
    }
    context.signal?.throwIfAborted();
    const embedded = fresh.map((passage, index) => ({ ...passage, vector: vectors[index] }));
    await database.savePassageEmbeddings({ userId, model: PASSAGE_EMBEDDING_MODEL, embeddings: embedded });
    // The same vectors serve the map's topic grouping, so it need not embed these openings again.
    const topicEntries = embedded.filter((passage) => passage.sourceKind === "conversation" && passage.topicHash)
      .map((passage) => ({ id: passage.sourceId, contentHash: passage.topicHash, embedding: quantizeEmbedding(passage.vector) }));
    if (topicEntries.length && database.saveTopicEmbeddings) {
      await database.saveTopicEmbeddings({ userId, model: TOPIC_EMBEDDING_MODEL, embeddings: topicEntries }).catch((error) => {
        console.error("Sharing passage embeddings with topics failed", error);
      });
    }
    remaining -= fresh.length;
    return { remaining };
  }

  /**
   * One batch of indexing: passages of changed sources, then embeddings when the
   * user allows them. `more` tells the caller to ask again.
   */
  async function sync({ userId, context }) {
    if (!available) return { ...(await status(userId)), more: false };
    context.signal?.throwIfAborted();
    const passages = await refreshPassages(userId);
    const current = await settings(userId);
    let embedding = { remaining: 0 };
    if (current.cloudEmbeddings) embedding = await embedPassages(userId, context);
    const counts = await database.readPassageIndexStatus({ userId, model: PASSAGE_EMBEDDING_MODEL });
    return {
      available: true, cloudEmbeddings: current.cloudEmbeddings, ...counts,
      pendingSources: Math.max(0, passages.remaining),
      more: passages.remaining > 0 || (current.cloudEmbeddings && !embedding.unavailable && embedding.remaining > 0),
      ...(embedding.unavailable ? { unavailable: embedding.unavailable } : {}),
    };
  }

  async function embedQuery({ userId, query, context }) {
    const key = `${userId}\n${query}`;
    const cached = queryEmbeddings.get(key);
    if (cached) {
      queryEmbeddings.delete(key);
      queryEmbeddings.set(key, cached);
      return cached;
    }
    const apiKey = getEmbeddingApiKey(context, env);
    if (!apiKey) return null;
    const [vector] = await embed({
      apiKey, inputs: [query], userId, signal: context.signal,
      usageMeter: context.apiKeys?.openai ? null : context.usageMeter, dimensions: TOPIC_EMBEDDING_DIMENSIONS,
    });
    queryEmbeddings.set(key, vector);
    if (queryEmbeddings.size > QUERY_CACHE_SIZE) queryEmbeddings.delete(queryEmbeddings.keys().next().value);
    return vector;
  }

  /**
   * Passages best matching `query`, by keyword and (when allowed) by meaning.
   * `sourceIds` limits it to those documents and files; `meaning: false` skips
   * the embedding request. Never throws for a missing key or an empty balance:
   * it searches by keyword and says why in `warning`.
   */
  async function search({ userId, query, context = {}, limit = 8, sourceIds = null, meaning = true }) {
    if (!available) return { results: [], meaning: false };
    const text = String(query ?? "").trim().slice(0, MAX_QUERY_CHARACTERS);
    // Every word may match; ranking prefers passages with more of them.
    const terms = vaultSearchTerms(text).filter((term) => !["or", "and", "not"].includes(term));
    const keywords = terms.join(" or ");
    let vector = null;
    // "off" and "no-key" are the user's settings; "failed" is a passing problem.
    let warning;
    let warningKind;
    if (meaning && text.length >= 3) {
      const current = await settings(userId);
      if (!current.cloudEmbeddings) [warning, warningKind] = [PASSAGE_EMBEDDINGS_OFF, "off"];
      else {
        try {
          vector = await embedQuery({ userId, query: text, context });
          if (!vector) [warning, warningKind] = [NO_OPENAI, "no-key"];
        } catch (error) {
          if (isAbort(error)) throw error;
          console.error("Vault search embedding failed", error);
          [warning, warningKind] = ["Search by meaning is unavailable just now, so only exact words were matched.", "failed"];
        }
      }
    }
    const notice = warning ? { warning, warningKind } : {};
    if (!keywords && !vector) return { results: [], meaning: false, ...notice };
    const rows = await database.searchPassages({
      userId, keywords, embedding: vector, model: PASSAGE_EMBEDDING_MODEL, sourceIds,
      candidates: Math.max(SEARCH_CANDIDATES, limit * 2), limit: Math.max(limit * 2, limit + 10),
    });
    const results = rows
      .filter((row) => row.keywordRank !== null || (row.similarity ?? 0) >= MIN_MEANING_SIMILARITY)
      .slice(0, limit)
      .map((row) => ({
        id: row.id, sourceKind: row.sourceKind, kind: row.itemKind, title: row.title, heading: row.heading ?? null,
        text: row.content, snippet: snippet(row.content, terms), blockId: row.blockId ?? null, pageNumber: row.pageNumber ?? null,
        charStart: row.charStart, passageIndex: row.passageIndex, updatedAt: row.updatedAt, ...(row.attachedTo ? { attachedTo: row.attachedTo } : {}),
        matched: row.keywordRank !== null && row.semanticRank !== null ? "both" : row.keywordRank !== null ? "keyword" : "meaning",
        similarity: row.similarity, score: row.score,
      }));
    return { results, meaning: Boolean(vector), ...notice };
  }

  /** An uploaded file's text as indexed, for reading it whole. */
  async function readFile({ userId, fileId }) {
    if (!available || !database.readFilePassages) return null;
    return database.readFilePassages({ userId, fileId });
  }

  return { available, status, setCloudEmbeddings, sync, search, readFile };
}
