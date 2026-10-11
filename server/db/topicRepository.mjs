import { fromWorkspaceEntityId, toWorkspaceEntityId } from "./repository.mjs";

// The text a document is embedded from, by the same rule as what the AI may
// read (searchRepository.mjs): a document's current blocks, a note's body, or a
// chat's first messages. Margin comments never count.
const SOURCES = `
  with sources as (
    select c.id, coalesce(c.title, '') as title,
      left(case
        when c.editable_document is not null then coalesce((
          select string_agg(block.content, E'\\n\\n' order by block.position)
          from jsonb_array_elements_text(jsonb_path_query_array(c.editable_document, '$.blocks[*].content'))
            with ordinality as block(content, position)), '')
        when c.conversation_kind = 'note' then coalesce((
          select n.content from marginchat_conversation_notes n
          where n.conversation_id = c.id and n.note_kind = 'standalone'
          order by n.created_at, n.id limit 1), '')
        else coalesce((
          select string_agg(m.content, E'\\n\\n' order by m.created_at, m.id)
          from (select content, created_at, id from marginchat_messages
            where conversation_id = c.id and role <> 'system'
            order by created_at, id limit 6) m), '')
      end, $2) as body
    from marginchat_conversations c
    where c.session_id = $1
  )
  select id, title, body, md5(title || E'\\n' || body) as content_hash
  from sources
  -- A blank document with a placeholder title says nothing about its subject.
  where char_length(btrim(title || body)) >= 3
    and (btrim(body) <> '' or lower(btrim(title)) !~ '^(untitled( document| note| chat)?|new (chat|document|note))$')`;

async function sessionIdFor(client, userId) {
  const session = await client.query("select id from marginchat_app_sessions where user_id = $1 limit 1", [userId]);
  return session.rowCount ? session.rows[0].id : null;
}

/**
 * Documents whose embedding is missing or was made from different text, up to
 * `limit`, and how many such documents there are in all.
 */
export async function listStaleTopicSources(client, { userId, model, limit, maxCharacters }) {
  const sessionId = await sessionIdFor(client, userId);
  if (!sessionId) return { sources: [], remaining: 0 };
  const rows = (await client.query(
    `select s.id, s.title, s.body, s.content_hash, count(*) over () as total
     from (${SOURCES}) s
     left join marginchat_topic_embeddings e
       on e.session_id = $1 and e.conversation_id = s.id and e.embedding_model = $3
     where e.content_hash is distinct from s.content_hash
     order by s.id
     limit $4`,
    [sessionId, maxCharacters, model, limit],
  )).rows;
  return {
    sources: rows.map((row) => ({ id: fromWorkspaceEntityId(sessionId, row.id), title: row.title, text: row.body, contentHash: row.content_hash })),
    remaining: rows.length ? Number(rows[0].total) : 0,
  };
}

export async function saveTopicEmbeddings(client, { userId, model, embeddings }) {
  const sessionId = await sessionIdFor(client, userId);
  if (!sessionId || !embeddings.length) return;
  await client.query(
    `insert into marginchat_topic_embeddings (session_id, conversation_id, content_hash, embedding_model, embedding, updated_at)
     select $1, entry.conversation_id, entry.content_hash, $2, decode(entry.embedding, 'base64'), now()
     from jsonb_to_recordset($3::jsonb) as entry(conversation_id text, content_hash text, embedding text)
     on conflict (session_id, conversation_id) do update set
       content_hash = excluded.content_hash, embedding_model = excluded.embedding_model,
       embedding = excluded.embedding, updated_at = excluded.updated_at`,
    [sessionId, model, JSON.stringify(embeddings.map((entry) => ({
      conversation_id: toWorkspaceEntityId(sessionId, entry.id), content_hash: entry.contentHash, embedding: entry.embedding,
    })))],
  );
}

/**
 * Embeddings of documents that still exist, changed after `since` when given.
 * Embeddings of deleted documents are removed on the way.
 */
export async function readTopicEmbeddings(client, { userId, model, since }) {
  const sessionId = await sessionIdFor(client, userId);
  if (!sessionId) return { embeddings: [], cursor: null };
  await client.query(
    `delete from marginchat_topic_embeddings e
     where e.session_id = $1 and not exists (select 1 from marginchat_conversations c where c.id = e.conversation_id)`,
    [sessionId],
  );
  const rows = (await client.query(
    `select e.conversation_id, encode(e.embedding, 'base64') as embedding, e.updated_at
     from marginchat_topic_embeddings e
     where e.session_id = $1 and e.embedding_model = $2 and ($3::timestamptz is null or e.updated_at > $3::timestamptz)
     order by e.updated_at, e.conversation_id`,
    [sessionId, model, since ?? null],
  )).rows;
  return {
    embeddings: rows.map((row) => ({ id: fromWorkspaceEntityId(sessionId, row.conversation_id), embedding: row.embedding.replace(/\s+/gu, "") })),
    cursor: rows.length ? new Date(rows.at(-1).updated_at).toISOString() : since ?? null,
  };
}
