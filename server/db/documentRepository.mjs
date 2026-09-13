import { randomUUID } from "node:crypto";
import { createStatusError } from "../lib/errors.mjs";

function toDocument(row) {
  return {
    createdAt: new Date(row.created_at).toISOString(),
    error: row.error_message ?? null,
    filename: row.filename,
    id: row.id,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    status: row.status,
  };
}

function toVaultAttachment(row) {
  return { ...toDocument(row), bytes: Buffer.from(row.original_bytes) };
}

// Always scope original-byte access to the authenticated owner. These methods
// support one-time migration and restore; their results are not public URLs.
export async function listVaultAttachments(client, userId) {
  const result = await client.query(
    `select id, filename, mime_type, size_bytes, original_bytes,
            status, error_message, created_at
     from marginchat_documents where user_id = $1 order by created_at, id`,
    [userId],
  );
  return result.rows.map(toVaultAttachment);
}

export async function getVaultAttachment(client, { documentId, userId }) {
  const result = await client.query(
    `select id, filename, mime_type, size_bytes, original_bytes,
            status, error_message, created_at
     from marginchat_documents where id = $1 and user_id = $2`,
    [documentId, userId],
  );
  return result.rowCount ? toVaultAttachment(result.rows[0]) : null;
}

export async function restoreVaultAttachment(
  client,
  { userId, attachment, bytes },
) {
  const originalBytes = Buffer.from(bytes);
  if (!attachment?.id || !attachment.filename || !originalBytes.length) {
    throw createStatusError(400, "A vault attachment needs an identity, filename and original bytes.");
  }
  const result = await client.query(
    `insert into marginchat_documents (
       id, user_id, filename, mime_type, size_bytes, original_bytes, status, created_at
     ) values ($1, $2, $3, $4, $5, $6, 'processing', $7)
     on conflict (id) do update set
       filename = excluded.filename,
       mime_type = excluded.mime_type,
       size_bytes = excluded.size_bytes,
       original_bytes = excluded.original_bytes,
       status = case
         when marginchat_documents.original_bytes = excluded.original_bytes
         then marginchat_documents.status else 'processing' end,
       error_message = case
         when marginchat_documents.original_bytes = excluded.original_bytes
         then marginchat_documents.error_message else null end,
       created_at = excluded.created_at,
       updated_at = now()
     where marginchat_documents.user_id = excluded.user_id
     returning id, filename, mime_type, size_bytes, status, error_message, created_at`,
    [
      attachment.id,
      userId,
      attachment.filename,
      attachment.mimeType || "application/octet-stream",
      originalBytes.length,
      originalBytes,
      attachment.createdAt || new Date().toISOString(),
    ],
  );
  if (!result.rowCount) {
    throw createStatusError(409, "This attachment identity is unavailable.");
  }
  // A restored file is only 'ready' if its exact bytes already have an index.
  // Embeddings can be regenerated from the vault separately.
  return toDocument(result.rows[0]);
}

export async function createDocument(
  client,
  { bytes, filename, mimeType, sizeBytes, userId, id = `document-${randomUUID()}`, createdAt = new Date().toISOString() },
) {
  const result = await client.query(
    `
      insert into marginchat_documents (
        id,
        user_id,
        filename,
        mime_type,
        size_bytes,
        original_bytes,
        status,
        created_at
      )
      values ($1, $2, $3, $4, $5, $6, 'processing', $7)
      returning id, filename, mime_type, size_bytes, status, error_message, created_at
    `,
    [id, userId, filename, mimeType, sizeBytes, bytes, createdAt],
  );

  return toDocument(result.rows[0]);
}

export async function completeDocument(
  client,
  { chunks, documentId, embeddingModel, userId, sourceBytes },
) {
  await client.query("begin");

  try {
    const ownerResult = await client.query(
      `
        select id, original_bytes
        from marginchat_documents
        where id = $1 and user_id = $2
        for update
      `,
      [documentId, userId],
    );

    if (!ownerResult.rowCount) {
      await client.query("rollback");
      return null;
    }

    if (sourceBytes && !Buffer.from(ownerResult.rows[0].original_bytes).equals(Buffer.from(sourceBytes))) {
      // A later vault revision replaced the original during extraction. Its
      // bytes must never be marked ready with embeddings from the older file.
      await client.query("rollback");
      return null;
    }

    await client.query(
      "delete from marginchat_document_chunks where document_id = $1",
      [documentId],
    );

    const chunkParameters = [];
    const chunkValues = chunks.map((chunk, index) => {
      const parameter = index * 8;
      chunkParameters.push(
        `chunk-${randomUUID()}`,
        documentId,
        chunk.index,
        chunk.pageNumber,
        chunk.content,
        chunk.tokenCount,
        embeddingModel,
        JSON.stringify(chunk.embedding),
      );

      return `($${parameter + 1}, $${parameter + 2}, $${parameter + 3}, $${
        parameter + 4
      }, $${parameter + 5}, $${parameter + 6}, $${parameter + 7}, $${
        parameter + 8
      }::vector)`;
    });

    await client.query(
      `
        insert into marginchat_document_chunks (
          id,
          document_id,
          chunk_index,
          page_number,
          content,
          token_count,
          embedding_model,
          embedding
        )
        values ${chunkValues.join(",\n")}
      `,
      chunkParameters,
    );

    const result = await client.query(
      `
        update marginchat_documents
        set status = 'ready', error_message = null, updated_at = now()
        where id = $1 and user_id = $2
        returning id, filename, mime_type, size_bytes, status, error_message, created_at
      `,
      [documentId, userId],
    );

    await client.query("commit");
    return result.rowCount ? toDocument(result.rows[0]) : null;
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

export async function failDocument(client, { documentId, error, userId }) {
  const result = await client.query(
    `
      update marginchat_documents
      set status = 'failed', error_message = $3, updated_at = now()
      where id = $1 and user_id = $2
      returning id, filename, mime_type, size_bytes, status, error_message, created_at
    `,
    [documentId, userId, String(error).slice(0, 500)],
  );

  return result.rowCount ? toDocument(result.rows[0]) : null;
}

export async function deleteDocument(client, { documentId, userId }) {
  const result = await client.query(
    "delete from marginchat_documents where id = $1 and user_id = $2",
    [documentId, userId],
  );

  return result.rowCount > 0;
}

export async function findRelevantDocumentChunks(
  client,
  { documentIds, embedding, limit, userId },
) {
  if (!documentIds.length) {
    return [];
  }

  const result = await client.query(
    `
      select
        c.document_id,
        c.chunk_index,
        c.page_number,
        c.content,
        d.filename,
        1 - (c.embedding <=> $3::vector) as similarity
      from marginchat_document_chunks c
      join marginchat_documents d on d.id = c.document_id
      where d.user_id = $1
        and d.status = 'ready'
        and d.id = any($2::text[])
      order by c.embedding <=> $3::vector
      limit $4
    `,
    [userId, documentIds, JSON.stringify(embedding), limit],
  );

  return result.rows.map((row) => ({
    chunkIndex: row.chunk_index,
    content: row.content,
    documentId: row.document_id,
    filename: row.filename,
    pageNumber: row.page_number,
    similarity: Number(row.similarity),
  }));
}
