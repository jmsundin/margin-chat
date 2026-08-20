import { HttpError } from "../lib/errors.mjs";

export const DOCUMENT_EMBEDDING_MODEL = "text-embedding-3-small";
export const DOCUMENT_EMBEDDING_DIMENSIONS = 1536;
const EMBEDDING_BATCH_SIZE = 64;

export async function createEmbeddings({ apiKey, inputs, userId }) {
  if (!apiKey) {
    throw new HttpError(
      503,
      "Document search requires an OpenAI API key for embeddings.",
    );
  }

  const embeddings = [];

  for (let start = 0; start < inputs.length; start += EMBEDDING_BATCH_SIZE) {
    const batch = inputs.slice(start, start + EMBEDDING_BATCH_SIZE);
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      body: JSON.stringify({
        dimensions: DOCUMENT_EMBEDDING_DIMENSIONS,
        input: batch,
        model: DOCUMENT_EMBEDDING_MODEL,
        user: userId,
      }),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      throw new HttpError(
        response.status,
        payload?.error?.message ?? "OpenAI embedding request failed.",
      );
    }

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
