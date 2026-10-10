import { fromWorkspaceEntityId, toWorkspaceEntityId } from "./repository.mjs";

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

// What the AI may read, by the same rule as the browser's context builder: a
// document's current blocks, a note's body, or a chat's messages. Margin comments
// and the message history behind an editable document never match. Keyed like
// PASSAGE_SOURCES in server/vault/search.mjs.
const AGENT_PASSAGE_QUERIES = {
  documents: `
    select c.id as conversation_id, c.title, c.updated_at,
      jsonb_path_query_array(c.editable_document, '$.blocks[*].content') as contents
    from marginchat_conversations c
    where c.session_id = $1 and c.editable_document is not null
      and jsonb_path_query_array(c.editable_document, '$.blocks[*].content')::text ilike all ($2::text[])
    order by c.updated_at desc, c.id
    limit $3`,
  messages: `
    select m.conversation_id, c.title, m.created_at as updated_at, m.content
    from marginchat_messages m
    join marginchat_conversations c on c.id = m.conversation_id
    where c.session_id = $1 and c.editable_document is null and c.conversation_kind = 'chat'
      and m.role <> 'system' and m.content ilike all ($2::text[])
    order by m.created_at desc, m.id
    limit $3`,
  notes: `
    select n.conversation_id, c.title, n.updated_at, n.content
    from marginchat_conversation_notes n
    join marginchat_conversations c on c.id = n.conversation_id
    where c.session_id = $1 and c.editable_document is null and c.conversation_kind = 'note'
      and n.note_kind = 'standalone' and n.content ilike all ($2::text[])
    order by n.updated_at desc, n.id
    limit $3`,
};

async function sessionIdFor(client, userId) {
  const session = await client.query("select id from marginchat_app_sessions where user_id = $1 limit 1", [userId]);
  return session.rowCount ? session.rows[0].id : null;
}

async function queryPassages(client, sql, { userId, patterns, limit, timeoutMs = 5000 }) {
  const sessionId = await sessionIdFor(client, userId);
  if (!sessionId) return [];
  await client.query("begin");
  let rows;
  try {
    // A broad search over a very large vault gives up instead of holding a connection.
    await client.query(`set local statement_timeout = ${Math.max(100, Math.min(30_000, Math.trunc(timeoutMs)))}`);
    rows = (await client.query(sql, [sessionId, patterns, limit])).rows;
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

/** Projected passages that contain every pattern, newest first. */
export async function searchVaultPassages(client, { source, ...args }) {
  if (!Object.hasOwn(PASSAGE_QUERIES, source)) throw new Error("Unknown search source.");
  return queryPassages(client, PASSAGE_QUERIES[source], args);
}

/** Like `searchVaultPassages`, limited to text the AI may read. */
export async function searchAgentPassages(client, { source, ...args }) {
  if (!Object.hasOwn(AGENT_PASSAGE_QUERIES, source)) throw new Error("Unknown search source.");
  return queryPassages(client, AGENT_PASSAGE_QUERIES[source], args);
}

/**
 * One document as the AI may read it: an editable document's current blocks, a
 * note's body, or a chat's newest messages. Null when it isn't in the projection.
 */
export async function readAgentConversation(client, { userId, conversationId, messageLimit = 40 }) {
  const sessionId = await sessionIdFor(client, userId);
  if (!sessionId) return null;
  const storedId = toWorkspaceEntityId(sessionId, conversationId);
  const found = await client.query(
    `select title, conversation_kind, parent_id, editable_document, updated_at
     from marginchat_conversations where session_id = $1 and id = $2`,
    [sessionId, storedId],
  );
  if (!found.rowCount) return null;
  const row = found.rows[0];
  const base = {
    id: conversationId,
    title: row.title,
    kind: row.editable_document ? "document" : row.conversation_kind === "note" ? "note" : "chat",
    parentId: row.parent_id ? fromWorkspaceEntityId(sessionId, row.parent_id) : null,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
  if (row.editable_document) {
    const blocks = Array.isArray(row.editable_document.blocks) ? row.editable_document.blocks : [];
    return { ...base, text: blocks.map((block) => typeof block?.content === "string" ? block.content : "").filter(Boolean).join("\n\n") };
  }
  if (row.conversation_kind === "note") {
    const note = await client.query(
      `select content from marginchat_conversation_notes
       where conversation_id = $1 and note_kind = 'standalone' order by created_at, id limit 1`,
      [storedId],
    );
    return { ...base, text: note.rows[0]?.content ?? "" };
  }
  const messages = await client.query(
    `select id, role, content, created_at, count(*) over () as total
     from marginchat_messages where conversation_id = $1 and role <> 'system'
     order by created_at desc, id desc limit $2`,
    [storedId, messageLimit],
  );
  return {
    ...base,
    messages: messages.rows.reverse().map((message) => ({ id: fromWorkspaceEntityId(sessionId, message.id), role: message.role, content: message.content })),
    messageCount: Number(messages.rows[0]?.total ?? 0),
  };
}
