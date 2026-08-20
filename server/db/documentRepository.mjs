import { randomUUID } from "node:crypto";

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

export async function createDocument(
  client,
  { bytes, filename, mimeType, sizeBytes, userId },
) {
  const id = `document-${randomUUID()}`;
  const result = await client.query(
    `
      insert into marginchat_documents (
        id,
        user_id,
        filename,
        mime_type,
        size_bytes,
        original_bytes,
        status
      )
      values ($1, $2, $3, $4, $5, $6, 'processing')
      returning id, filename, mime_type, size_bytes, status, error_message, created_at
    `,
    [id, userId, filename, mimeType, sizeBytes, bytes],
  );

  return toDocument(result.rows[0]);
}

export async function completeDocument(
  client,
  { chunks, documentId, embeddingModel, userId },
) {
  await client.query("begin");

  try {
    const ownerResult = await client.query(
      `
        select id
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
