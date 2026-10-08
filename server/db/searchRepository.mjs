import { fromWorkspaceEntityId } from "./repository.mjs";

// Each source returns its newest matches first. Every LIKE pattern must match.
// Document text is the JSON array of block contents, so keys and ids never match.
const PASSAGE_QUERIES = {
  documents: `
    select c.id as conversation_id, c.title, c.updated_at, c.editable_document as document
    from marginchat_conversations c
    where c.session_id = $1 and c.editable_document is not null
      and jsonb_path_query_array(c.editable_document, '$.blocks[*].content')::text ilike all ($2::text[])
    order by c.updated_at desc, c.id
    limit $3`,
  messages: `
    select m.id, m.conversation_id, m.content, m.created_at as updated_at, c.title
    from marginchat_messages m
    join marginchat_conversations c on c.id = m.conversation_id
    where c.session_id = $1 and m.role <> 'system' and m.content ilike all ($2::text[])
    order by m.created_at desc, m.id
    limit $3`,
  notes: `
    select n.id, n.conversation_id, n.content, n.updated_at, c.title
    from marginchat_conversation_notes n
    join marginchat_conversations c on c.id = n.conversation_id
    where c.session_id = $1 and n.content ilike all ($2::text[])
    order by n.updated_at desc, n.id
    limit $3`,
};

/** Projected passages that contain every pattern, newest first. */
export async function searchVaultPassages(client, { userId, source, patterns, limit, timeoutMs = 5000 }) {
  if (!Object.hasOwn(PASSAGE_QUERIES, source)) throw new Error("Unknown search source.");
  const session = await client.query("select id from marginchat_app_sessions where user_id = $1 limit 1", [userId]);
  if (!session.rowCount) return [];
  const sessionId = session.rows[0].id;
  await client.query("begin");
  let rows;
  try {
    // A broad search over a very large vault gives up instead of holding a connection.
    await client.query(`set local statement_timeout = ${Math.max(100, Math.min(30_000, Math.trunc(timeoutMs)))}`);
    rows = (await client.query(PASSAGE_QUERIES[source], [sessionId, patterns, limit])).rows;
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  }
  return rows.map((row) => ({
    ...row,
    ...(row.id ? { id: fromWorkspaceEntityId(sessionId, row.id) } : {}),
    conversation_id: fromWorkspaceEntityId(sessionId, row.conversation_id),
  }));
}
