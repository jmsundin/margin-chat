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
    where c.session_id = $1 and not c.ai_hidden
  )
  select id, title, body, md5(title || E'\\n' || body) as content_hash
  from sources
  -- A blank document with a placeholder title says nothing about its subject.
  where char_length(btrim(title || body)) >= 3
    and (btrim(body) <> '' or lower(btrim(title)) !~ '^(untitled( document| note| chat)?|new (chat|document|note))$')`;

/** Dimensions of the vector column; embeddings of another width keep no vector and so no neighbours. */
const TOPIC_VECTOR_DIMENSIONS = 512;
/** Nearest documents kept per document. */
export const TOPIC_NEIGHBOURS_PER_DOCUMENT = 12;

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
    `insert into marginchat_topic_embeddings (session_id, conversation_id, content_hash, embedding_model, embedding, vector, updated_at)
     select $1, entry.conversation_id, entry.content_hash, $2, decode(entry.embedding, 'base64'),
       case when octet_length(decode(entry.embedding, 'base64')) = ${TOPIC_VECTOR_DIMENSIONS} then marginchat_int8_halfvec(decode(entry.embedding, 'base64')) end, now()
     from jsonb_to_recordset($3::jsonb) as entry(conversation_id text, content_hash text, embedding text)
     on conflict (session_id, conversation_id) do update set
       content_hash = excluded.content_hash, embedding_model = excluded.embedding_model,
       embedding = excluded.embedding, vector = excluded.vector, updated_at = excluded.updated_at`,
    [sessionId, model, JSON.stringify(embeddings.map((entry) => ({
      conversation_id: toWorkspaceEntityId(sessionId, entry.id), content_hash: entry.contentHash, embedding: entry.embedding,
    })))],
  );
}

/**
 * Embeddings of documents that still exist, changed after `since` when given.
 * Embeddings of deleted documents, and of documents hidden from AI, are removed on the way.
 */
export async function readTopicEmbeddings(client, { userId, model, since }) {
  const sessionId = await sessionIdFor(client, userId);
  if (!sessionId) return { embeddings: [], cursor: null };
  await client.query(
    `delete from marginchat_topic_embeddings e
     where e.session_id = $1 and not exists (select 1 from marginchat_conversations c where c.id = e.conversation_id and not c.ai_hidden)`,
    [sessionId],
  );
  await client.query(
    `delete from marginchat_topic_neighbours n
     where n.session_id = $1 and (not exists (select 1 from marginchat_topic_embeddings e where e.session_id = $1 and e.conversation_id = n.conversation_id)
       or not exists (select 1 from marginchat_topic_embeddings e where e.session_id = $1 and e.conversation_id = n.neighbour_id))`,
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

/** Documents the user moved to another cluster, each with the document whose cluster it joins. */
export async function readTopicPlacements(client, { userId }) {
  const sessionId = await sessionIdFor(client, userId);
  if (!sessionId) return [];
  const rows = (await client.query(
    `select p.conversation_id, p.anchor_conversation_id
     from marginchat_topic_placements p
     where p.session_id = $1
       and exists (select 1 from marginchat_conversations c where c.id = p.conversation_id)
       and exists (select 1 from marginchat_conversations c where c.id = p.anchor_conversation_id)
     order by p.conversation_id`,
    [sessionId],
  )).rows;
  return rows.map((row) => ({ id: fromWorkspaceEntityId(sessionId, row.conversation_id), anchorId: fromWorkspaceEntityId(sessionId, row.anchor_conversation_id) }));
}

/** Moves a document to the cluster of `anchorId`, or back to automatic placement when it is null. */
export async function writeTopicPlacement(client, { userId, id, anchorId }) {
  const sessionId = await sessionIdFor(client, userId);
  if (!sessionId) return false;
  const stored = toWorkspaceEntityId(sessionId, id);
  if (anchorId === null) {
    await client.query("delete from marginchat_topic_placements where session_id = $1 and conversation_id = $2", [sessionId, stored]);
    return true;
  }
  await client.query(
    `insert into marginchat_topic_placements (session_id, conversation_id, anchor_conversation_id, updated_at)
     values ($1, $2, $3, now())
     on conflict (session_id, conversation_id) do update set
       anchor_conversation_id = excluded.anchor_conversation_id, updated_at = excluded.updated_at`,
    [sessionId, stored, toWorkspaceEntityId(sessionId, anchorId)],
  );
  return true;
}

/**
 * Documents with a vector but no neighbours yet (embedded before neighbours
 * existed), up to `limit`, and how many there are in all.
 */
export async function listUnneighbouredTopicDocuments(client, { userId, limit }) {
  const sessionId = await sessionIdFor(client, userId);
  if (!sessionId) return { ids: [], remaining: 0 };
  const rows = (await client.query(
    `select e.conversation_id, count(*) over () as total
     from marginchat_topic_embeddings e
     where e.session_id = $1 and e.vector is not null
       and not exists (select 1 from marginchat_topic_neighbours n where n.session_id = $1 and n.conversation_id = e.conversation_id)
       and exists (select 1 from marginchat_topic_embeddings o where o.session_id = $1 and o.vector is not null and o.conversation_id <> e.conversation_id)
     order by e.updated_at desc, e.conversation_id
     limit $2`,
    [sessionId, limit],
  )).rows;
  return { ids: rows.map((row) => fromWorkspaceEntityId(sessionId, row.conversation_id)), remaining: rows.length ? Number(rows[0].total) : 0 };
}

/**
 * Finds the nearest documents of each document in `ids` with the vector
 * index, and adds each as a neighbour of the documents it found, so a new
 * document shows up beside its neighbours as well as the other way round.
 * Lists it lengthened are trimmed back to the nearest TOPIC_NEIGHBOURS_PER_DOCUMENT.
 */
export async function refreshTopicNeighbours(client, { userId, ids }) {
  const sessionId = await sessionIdFor(client, userId);
  if (!sessionId || !ids.length) return;
  const stored = ids.map((id) => toWorkspaceEntityId(sessionId, id));
  await client.query("delete from marginchat_topic_neighbours where session_id = $1 and conversation_id = any($2::text[])", [sessionId, stored]);
  await client.query(
    `insert into marginchat_topic_neighbours (session_id, conversation_id, neighbour_id, similarity, updated_at)
     select $1, s.conversation_id, near.conversation_id, 1 - near.distance, now()
     from marginchat_topic_embeddings s
     cross join lateral (
       select e.conversation_id, e.vector <=> s.vector as distance
       from marginchat_topic_embeddings e
       where e.session_id = $1 and e.vector is not null and e.conversation_id <> s.conversation_id
       order by e.vector <=> s.vector
       limit $3) near
     where s.session_id = $1 and s.vector is not null and s.conversation_id = any($2::text[])`,
    [sessionId, stored, TOPIC_NEIGHBOURS_PER_DOCUMENT],
  );
  await client.query(
    `insert into marginchat_topic_neighbours (session_id, conversation_id, neighbour_id, similarity, updated_at)
     select n.session_id, n.neighbour_id, n.conversation_id, n.similarity, now()
     from marginchat_topic_neighbours n
     where n.session_id = $1 and n.conversation_id = any($2::text[])
     on conflict (session_id, conversation_id, neighbour_id) do update set
       similarity = excluded.similarity, updated_at = excluded.updated_at`,
    [sessionId, stored],
  );
  await client.query(
    `delete from marginchat_topic_neighbours t
     using (
       select n.conversation_id, n.neighbour_id,
         row_number() over (partition by n.conversation_id order by n.similarity desc, n.neighbour_id) as rank
       from marginchat_topic_neighbours n
       where n.session_id = $1 and n.conversation_id in (
         select r.neighbour_id from marginchat_topic_neighbours r where r.session_id = $1 and r.conversation_id = any($2::text[]))) ranked
     where t.session_id = $1 and t.conversation_id = ranked.conversation_id and t.neighbour_id = ranked.neighbour_id and ranked.rank > $3`,
    [sessionId, stored, TOPIC_NEIGHBOURS_PER_DOCUMENT],
  );
}

/**
 * The neighbour lists of documents whose list changed after `since` (every
 * list when null), each list whole, nearest first.
 */
export async function readTopicNeighbours(client, { userId, since }) {
  const sessionId = await sessionIdFor(client, userId);
  if (!sessionId) return { neighbours: [], cursor: null };
  const rows = (await client.query(
    `select n.conversation_id, n.neighbour_id, n.similarity, changed.updated_at
     from (
       select conversation_id, max(updated_at) as updated_at
       from marginchat_topic_neighbours
       where session_id = $1
       group by conversation_id
       having $2::timestamptz is null or max(updated_at) > $2::timestamptz) changed
     join marginchat_topic_neighbours n on n.session_id = $1 and n.conversation_id = changed.conversation_id
     order by changed.updated_at, n.conversation_id, n.similarity desc, n.neighbour_id`,
    [sessionId, since ?? null],
  )).rows;
  const lists = new Map();
  for (const row of rows) {
    const id = fromWorkspaceEntityId(sessionId, row.conversation_id);
    const list = lists.get(id) ?? lists.set(id, []).get(id);
    list.push({ id: fromWorkspaceEntityId(sessionId, row.neighbour_id), similarity: Number(row.similarity) });
  }
  return {
    neighbours: [...lists].map(([id, list]) => ({ id, neighbours: list })),
    cursor: rows.length ? new Date(rows.at(-1).updated_at).toISOString() : since ?? null,
  };
}

/** The stored landscape: a position and region per document (see server/documents/landscape.mjs). */
export async function readLandscape(client, { userId }) {
  const sessionId = await sessionIdFor(client, userId);
  if (!sessionId) return { positions: [], regions: 0, computedAt: null };
  const meta = await client.query("select computed_at, regions from marginchat_landscapes where session_id = $1", [sessionId]);
  const rows = await client.query("select conversation_id, x, y, region from marginchat_landscape_positions where session_id = $1 order by conversation_id", [sessionId]);
  return {
    positions: rows.rows.map((row) => ({ id: fromWorkspaceEntityId(sessionId, row.conversation_id), x: Number(row.x), y: Number(row.y), region: Number(row.region) })),
    regions: meta.rowCount ? Number(meta.rows[0].regions) : 0,
    computedAt: meta.rowCount ? new Date(meta.rows[0].computed_at).toISOString() : null,
  };
}

/** Replaces the whole landscape in one transaction. */
export async function writeLandscape(client, { userId, positions, regions }) {
  const sessionId = await sessionIdFor(client, userId);
  if (!sessionId) return;
  await client.query("begin");
  try {
    await client.query("delete from marginchat_landscape_positions where session_id = $1", [sessionId]);
    for (let start = 0; start < positions.length; start += 5000) {
      const batch = positions.slice(start, start + 5000);
      await client.query(
        `insert into marginchat_landscape_positions (session_id, conversation_id, x, y, region)
         select $1, id, x, y, region from unnest($2::text[], $3::real[], $4::real[], $5::int[]) as p(id, x, y, region)`,
        [sessionId, batch.map((entry) => toWorkspaceEntityId(sessionId, entry.id)), batch.map((entry) => entry.x), batch.map((entry) => entry.y), batch.map((entry) => entry.region)],
      );
    }
    await client.query(
      `insert into marginchat_landscapes (session_id, computed_at, documents, regions) values ($1, now(), $2, $3)
       on conflict (session_id) do update set computed_at = excluded.computed_at, documents = excluded.documents, regions = excluded.regions`,
      [sessionId, positions.length, regions],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}
