import { HttpError } from "../lib/errors.mjs";
import { requestProviderJson } from "../chat/providers.mjs";

export const DOCUMENT_EMBEDDING_MODEL = "text-embedding-3-small";
export const DOCUMENT_EMBEDDING_DIMENSIONS = 1536;
const EMBEDDING_BATCH_SIZE = 64;

export async function createEmbeddings({ apiKey, inputs, userId, signal, usageMeter }) {
  signal?.throwIfAborted();
  if (!apiKey) {
    throw new HttpError(
      503,
      "Document search requires an OpenAI API key for embeddings.",
    );
  }

  const embeddings = [];

  for (let start = 0; start < inputs.length; start += EMBEDDING_BATCH_SIZE) {
    signal?.throwIfAborted();
    const batch = inputs.slice(start, start + EMBEDDING_BATCH_SIZE);
    const payload = await requestProviderJson({
      apiKey,
      provider: "openai",
      kind: "embedding",
      url: "https://api.openai.com/v1/embeddings",
      usageMeter,
      body: {
        dimensions: DOCUMENT_EMBEDDING_DIMENSIONS,
        input: batch,
        model: DOCUMENT_EMBEDDING_MODEL,
        user: userId,
      },
      signal,
      fallbackError: "OpenAI embedding request failed.",
    });
    signal?.throwIfAborted();

    const batchEmbeddings = [...(payload?.data ?? [])]
      .sort((left, right) => left.index - right.index)
      .map((item) => item.embedding);

    if (
      batchEmbeddings.length !== batch.length ||
      batchEmbeddings.some(
        (embedding) =>
          !Array.isArray(embedding) ||
          embedding.length !== DOCUMENT_EMBEDDING_DIMENSIONS,
      )
    ) {
      throw new HttpError(502, "OpenAI returned invalid document embeddings.");
    }

    embeddings.push(...batchEmbeddings);
  }

  return embeddings;
}
