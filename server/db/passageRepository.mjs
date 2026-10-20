import { fromWorkspaceEntityId, toWorkspaceEntityId } from "./repository.mjs";

// Passages for search by keyword and by meaning (migration 0015). A source is a
// saved document, note or chat (a conversation row), an uploaded file (a
// document row) or a PDF in the cloud vault (migration 0017). Its text is what the AI may read, by the same rule as
// searchRepository.mjs: a document's current blocks, a note's body, or a chat's
// messages. Margin comments never count. The opening (`lead`) is computed
// exactly as topicRepository.mjs computes a topic embedding's text, so the two
// can share one embedding.

const PLACEHOLDER_TITLE = "^(untitled( document| note| chat)?|new (chat|document|note))$";

const STALE_CONVERSATIONS = `
  with stale as (
    select c.id, coalesce(c.title, '') as title, c.conversation_kind, c.editable_document, c.updated_at,
      c.xmin::text as fingerprint, count(*) over () as total
    from marginchat_conversations c
    left join marginchat_vault_passage_sources s
      on s.session_id = $1 and s.source_kind = 'conversation' and s.source_id = c.id
    where c.session_id = $1 and not c.ai_hidden and s.fingerprint is distinct from c.xmin::text
    order by c.updated_at desc, c.id
    limit $2
  ), texts as (
    select st.*,
      case when st.editable_document is not null then 'document' when st.conversation_kind = 'note' then 'note' else 'chat' end as item_kind,
      case when st.editable_document is not null then st.editable_document -> 'blocks' end as blocks,
      case
        when st.editable_document is not null then coalesce((
          select string_agg(block.content, E'\\n\\n' order by block.position)
          from jsonb_array_elements_text(jsonb_path_query_array(st.editable_document, '$.blocks[*].content'))
            with ordinality as block(content, position)), '')
        when st.conversation_kind = 'note' then coalesce((
          select n.content from marginchat_conversation_notes n
          where n.conversation_id = st.id and n.note_kind = 'standalone'
          order by n.created_at, n.id limit 1), '')
        else coalesce((
          select string_agg(m.content, E'\\n\\n' order by m.created_at, m.id)
          from marginchat_messages m where m.conversation_id = st.id and m.role <> 'system'), '')
      end as full_body,
      case when st.editable_document is null and st.conversation_kind <> 'note' then coalesce((
          select string_agg(m.content, E'\\n\\n' order by m.created_at, m.id)
          from (select content, created_at, id from marginchat_messages
            where conversation_id = st.id and role <> 'system'
            order by created_at, id limit 6) m), '')
      end as chat_opening
    from stale st
  ), bodies as (
    select t.*, left(t.full_body, $3) as body,
      left(coalesce(t.chat_opening, t.full_body), $4) as lead
    from texts t
  )
  select b.id, b.title, b.item_kind, b.blocks, b.updated_at, b.fingerprint, b.total, b.body, b.lead,
    case when char_length(btrim(b.title || b.lead)) >= 3
      and (btrim(b.lead) <> '' or lower(btrim(b.title)) !~ '${PLACEHOLDER_TITLE}')
      then md5(b.title || E'\\n' || b.lead) end as topic_hash
  from bodies b`;

async function sessionIdFor(client, userId) {
  const session = await client.query("select id from marginchat_app_sessions where user_id = $1 limit 1", [userId]);
  return session.rowCount ? session.rows[0].id : null;
}

async function inTransaction(client, work) {
  await client.query("begin");
  try {
    const result = await work();
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  }
}

/**
 * Saved documents, notes and chats whose passages are missing or were made from
 * an older version, newest first, up to `limit`; and how many there are in all.
 */
export async function listStalePassageSources(client, { userId, limit, maxCharacters, leadCharacters }) {
  const sessionId = await sessionIdFor(client, userId);
  if (!sessionId) return { sources: [], remaining: 0 };
  const rows = (await client.query(STALE_CONVERSATIONS, [sessionId, limit, maxCharacters, leadCharacters])).rows;
  return {
    sources: rows.map((row) => ({
      kind: "conversation", id: fromWorkspaceEntityId(sessionId, row.id), itemKind: row.item_kind, title: row.title,
      body: row.body, lead: row.lead, blocks: Array.isArray(row.blocks) ? row.blocks : null, topicHash: row.topic_hash ?? null,
      fingerprint: row.fingerprint, updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    })),
    remaining: rows.length ? Number(rows[0].total) : 0,
  };
}

/** Uploaded files whose passages are missing or out of date, newest first, with their bytes. */
export async function listStaleFilePassageSources(client, { userId, limit }) {
  const sessionId = await sessionIdFor(client, userId);
  if (!sessionId) return { sources: [], remaining: 0 };
  const rows = (await client.query(
    `select coalesce(d.public_id, d.id) as id, d.filename, d.mime_type, d.original_bytes, d.updated_at,
       d.xmin::text as fingerprint, count(*) over () as total
     from marginchat_documents d
     left join marginchat_vault_passage_sources s
       on s.session_id = $1 and s.source_kind = 'attachment' and s.source_id = coalesce(d.public_id, d.id)
     where d.user_id = $2 and s.fingerprint is distinct from d.xmin::text
     order by d.created_at desc, d.id
     limit $3`,
    [sessionId, userId, limit],
  )).rows;
  return {
    sources: rows.map((row) => ({
      kind: "attachment", id: row.id, itemKind: "file", title: row.filename, mimeType: row.mime_type,
      bytes: row.original_bytes, fingerprint: row.fingerprint, updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    })),
    remaining: rows.length ? Number(rows[0].total) : 0,
  };
}

/** The PDFs from the vault that are indexed, by document ID, with the file revision each was made from. */
export async function listVaultFilePassageSources(client, { userId }) {
  const sessionId = await sessionIdFor(client, userId);
  if (!sessionId) return new Map();
  const rows = (await client.query(
    `select source_id, fingerprint from marginchat_vault_passage_sources where session_id = $1 and source_kind = 'vault-file'`,
    [sessionId],
  )).rows;
  return new Map(rows.map((row) => [row.source_id, row.fingerprint]));
}

/** Forgets the passages of vault PDFs that were deleted, renamed or are no longer synced. */
export async function deleteVaultFilePassageSources(client, { userId, ids }) {
  const sessionId = await sessionIdFor(client, userId);
  if (!sessionId || !ids.length) return;
  await client.query(
    `delete from marginchat_vault_passage_sources where session_id = $1 and source_kind = 'vault-file' and source_id = any($2::text[])`,
    [sessionId, ids],
  );
}

/** Forgets passages of documents and files that no longer exist, or that the user hid from AI. */
export async function deleteMissingPassageSources(client, { userId }) {
  const sessionId = await sessionIdFor(client, userId);
  if (!sessionId) return;
  await client.query(
    `delete from marginchat_vault_passage_sources s
     where s.session_id = $1 and (
       (s.source_kind = 'conversation' and not exists (select 1 from marginchat_conversations c where c.id = s.source_id and not c.ai_hidden))
       -- A vault PDF's passages carry the ID of the document that shows it.
       or (s.source_kind = 'vault-file' and exists (select 1 from marginchat_conversations c
         where c.session_id = $1 and c.ai_hidden and c.id = $3 || s.source_id))
       or (s.source_kind = 'attachment' and not exists (
         select 1 from marginchat_documents d where d.user_id = $2 and coalesce(d.public_id, d.id) = s.source_id)))`,
    [sessionId, userId, toWorkspaceEntityId(sessionId, "")],
  );
}

/** The documents the user hid from AI, by their IDs in the app. */
export async function listAIHiddenIds(client, { userId }) {
  const sessionId = await sessionIdFor(client, userId);
  if (!sessionId) return [];
  const rows = (await client.query(
    "select id from marginchat_conversations where session_id = $1 and ai_hidden", [sessionId])).rows;
  return rows.map((row) => fromWorkspaceEntityId(sessionId, row.id));
}

const storedSourceId = (sessionId, source) => source.kind === "conversation" ? toWorkspaceEntityId(sessionId, source.id) : source.id;

/**
 * Records the current passages of each source. A passage whose text is
 * unchanged keeps its embedding; passages that are gone are removed.
 */
export async function replacePassageSources(client, { userId, sources }) {
  const sessionId = await sessionIdFor(client, userId);
  if (!sessionId || !sources.length) return;
  const sourceRows = sources.map((source) => ({
    source_kind: source.kind, source_id: storedSourceId(sessionId, source), item_kind: source.itemKind,
    title: source.title, fingerprint: source.fingerprint, passage_count: source.passages.length,
    error: source.error ?? null, updated_at: source.updatedAt ?? null,
  }));
  const passageRows = sources.flatMap((source) => source.passages.map((passage) => ({
    source_kind: source.kind, source_id: storedSourceId(sessionId, source), content_hash: passage.contentHash,
    passage_index: passage.index, title: passage.title, heading: passage.heading ?? null, content: passage.content,
    block_id: passage.blockId ?? null, page_number: passage.pageNumber ?? null, char_start: passage.charStart ?? 0,
    topic_hash: passage.topicHash ?? null,
  })));
  await inTransaction(client, async () => {
    await client.query(
      `insert into marginchat_vault_passage_sources
         (session_id, source_kind, source_id, item_kind, title, fingerprint, passage_count, error, updated_at, indexed_at)
       select $1, s.source_kind, s.source_id, s.item_kind, s.title, s.fingerprint, s.passage_count, s.error, s.updated_at, now()
       from jsonb_to_recordset($2::jsonb) as s(source_kind text, source_id text, item_kind text, title text,
         fingerprint text, passage_count integer, error text, updated_at timestamptz)
       on conflict (session_id, source_kind, source_id) do update set
         item_kind = excluded.item_kind, title = excluded.title, fingerprint = excluded.fingerprint,
         passage_count = excluded.passage_count, error = excluded.error, updated_at = excluded.updated_at, indexed_at = now()`,
      [sessionId, JSON.stringify(sourceRows)],
    );
    await client.query(
      `delete from marginchat_vault_passages p
       using jsonb_to_recordset($2::jsonb) as s(source_kind text, source_id text)
       where p.session_id = $1 and p.source_kind = s.source_kind and p.source_id = s.source_id
         and not exists (
           select 1 from jsonb_to_recordset($3::jsonb) as n(source_kind text, source_id text, content_hash text)
           where n.source_kind = p.source_kind and n.source_id = p.source_id and n.content_hash = p.content_hash)`,
      [sessionId, JSON.stringify(sourceRows), JSON.stringify(passageRows)],
    );
    if (!passageRows.length) return;
    await client.query(
      `insert into marginchat_vault_passages (session_id, source_kind, source_id, content_hash, passage_index, title,
         heading, content, block_id, page_number, char_start, topic_hash)
       select $1, n.source_kind, n.source_id, n.content_hash, n.passage_index, n.title, n.heading, n.content,
         n.block_id, n.page_number, n.char_start, n.topic_hash
       from jsonb_to_recordset($2::jsonb) as n(source_kind text, source_id text, content_hash text, passage_index integer,
         title text, heading text, content text, block_id text, page_number integer, char_start integer, topic_hash text)
       on conflict (session_id, source_kind, source_id, content_hash) do update set
         passage_index = excluded.passage_index, heading = excluded.heading, block_id = excluded.block_id,
         page_number = excluded.page_number, char_start = excluded.char_start, topic_hash = excluded.topic_hash`,
      [sessionId, JSON.stringify(passageRows)],
    );
  });
}

/** Passages without an embedding from `model`, openings first, up to `limit`; and how many wait in all. */
export async function listUnembeddedPassages(client, { userId, model, limit }) {
  const sessionId = await sessionIdFor(client, userId);
  if (!sessionId) return { passages: [], remaining: 0 };
  const rows = (await client.query(
    `select p.source_kind, p.source_id, p.content_hash, p.title, p.heading, p.content, p.topic_hash, count(*) over () as total
     from marginchat_vault_passages p
     where p.session_id = $1 and (p.embedding is null or p.embedding_model is distinct from $2)
     order by p.passage_index, p.source_kind, p.source_id, p.content_hash
     limit $3`,
    [sessionId, model, limit],
  )).rows;
  return {
    passages: rows.map((row) => ({
      sourceKind: row.source_kind, sourceId: row.source_kind === "conversation" ? fromWorkspaceEntityId(sessionId, row.source_id) : row.source_id,
      contentHash: row.content_hash, title: row.title, heading: row.heading, content: row.content, topicHash: row.topic_hash,
    })),
    remaining: rows.length ? Number(rows[0].total) : 0,
  };
}

/** Topic embeddings made from exactly the text of these openings, keyed by document id. */
export async function readMatchingTopicEmbeddings(client, { userId, model, openings }) {
  const sessionId = await sessionIdFor(client, userId);
  if (!sessionId || !openings.length) return new Map();
  const rows = (await client.query(
    `select e.conversation_id, encode(e.embedding, 'base64') as embedding
     from marginchat_topic_embeddings e
     join jsonb_to_recordset($3::jsonb) as o(conversation_id text, topic_hash text)
       on o.conversation_id = e.conversation_id and o.topic_hash = e.content_hash
     where e.session_id = $1 and e.embedding_model = $2`,
    [sessionId, model, JSON.stringify(openings.map((opening) => ({
      conversation_id: toWorkspaceEntityId(sessionId, opening.id), topic_hash: opening.topicHash,
    })))],
  )).rows;
  return new Map(rows.map((row) => [fromWorkspaceEntityId(sessionId, row.conversation_id), row.embedding.replace(/\s+/gu, "")]));
}

/** Stores embeddings; each value is a list of numbers. */
export async function savePassageEmbeddings(client, { userId, model, embeddings }) {
  const sessionId = await sessionIdFor(client, userId);
  if (!sessionId || !embeddings.length) return;
  await client.query(
    `update marginchat_vault_passages p
     set embedding = e.embedding::halfvec, embedding_model = $2
     from jsonb_to_recordset($3::jsonb) as e(source_kind text, source_id text, content_hash text, embedding text)
     where p.session_id = $1 and p.source_kind = e.source_kind and p.source_id = e.source_id and p.content_hash = e.content_hash`,
    [sessionId, model, JSON.stringify(embeddings.map((entry) => ({
      source_kind: entry.sourceKind,
      source_id: entry.sourceKind === "conversation" ? toWorkspaceEntityId(sessionId, entry.sourceId) : entry.sourceId,
      content_hash: entry.contentHash,
      embedding: `[${Array.from(entry.vector, (value) => (Number.isFinite(value) ? value : 0)).join(",")}]`,
    })))],
  );
}

/** Removes every stored passage embedding, for when the user turns search by meaning off. */
export async function clearPassageEmbeddings(client, { userId }) {
  const sessionId = await sessionIdFor(client, userId);
  if (!sessionId) return;
  await client.query("update marginchat_vault_passages set embedding = null, embedding_model = null where session_id = $1 and embedding is not null", [sessionId]);
}

/** How many passages there are and how many have an embedding from `model`. */
export async function readPassageIndexStatus(client, { userId, model }) {
  const sessionId = await sessionIdFor(client, userId);
  if (!sessionId) return { passages: 0, embedded: 0 };
  const row = (await client.query(
    `select count(*) as passages, count(*) filter (where embedding is not null and embedding_model = $2) as embedded
     from marginchat_vault_passages where session_id = $1`,
    [sessionId, model],
  )).rows[0];
  return { passages: Number(row?.passages ?? 0), embedded: Number(row?.embedded ?? 0) };
}

export async function readVaultIndexSettings(client, { userId }) {
  const row = (await client.query("select cloud_embeddings from marginchat_vault_index_settings where user_id = $1", [userId])).rows[0];
  return { cloudEmbeddings: row ? row.cloud_embeddings === true : true };
}

export async function writeVaultIndexSettings(client, { userId, cloudEmbeddings }) {
  await client.query(
    `insert into marginchat_vault_index_settings (user_id, cloud_embeddings, updated_at) values ($1, $2, now())
     on conflict (user_id) do update set cloud_embeddings = excluded.cloud_embeddings, updated_at = excluded.updated_at`,
    [userId, cloudEmbeddings === true],
  );
  return { cloudEmbeddings: cloudEmbeddings === true };
}

// Ranks keyword matches (title, headings, then text) and nearest embeddings
// separately, then merges the two lists by reciprocal rank (k = 60), so a
// passage both lists agree on comes first.
const SEARCH = `
  with q as (select case when $2::text = '' then null else websearch_to_tsquery('english', $2::text) end as query),
  keyword as (
    select x.source_kind, x.source_id, x.content_hash, row_number() over (order by x.score desc, x.passage_index) as rank
    from (
      select p.source_kind, p.source_id, p.content_hash, p.passage_index, ts_rank_cd(p.search, q.query, 32) as score
      from marginchat_vault_passages p, q
      where q.query is not null and p.session_id = $1 and p.search @@ q.query
        and ($5::text[] is null or p.source_id = any($5::text[]))
      order by score desc, p.passage_index
      limit $4
    ) x
  ),
  semantic as (
    select x.source_kind, x.source_id, x.content_hash, x.distance, row_number() over (order by x.distance) as rank
    from (
      select p.source_kind, p.source_id, p.content_hash, p.embedding <=> ($3::text)::halfvec as distance
      from marginchat_vault_passages p
      where $3::text is not null and p.session_id = $1 and p.embedding is not null and p.embedding_model = $6
        and ($5::text[] is null or p.source_id = any($5::text[]))
      order by p.embedding <=> ($3::text)::halfvec
      limit $4
    ) x
  ),
  fused as (
    select coalesce(k.source_kind, s.source_kind) as source_kind, coalesce(k.source_id, s.source_id) as source_id,
      coalesce(k.content_hash, s.content_hash) as content_hash, k.rank as keyword_rank, s.rank as semantic_rank, s.distance,
      coalesce(1.0 / (60 + k.rank), 0) + coalesce(1.0 / (60 + s.rank), 0) as score
    from keyword k
    full outer join semantic s on s.source_kind = k.source_kind and s.source_id = k.source_id and s.content_hash = k.content_hash
  )
  select f.source_kind, f.source_id, f.content_hash, f.keyword_rank, f.semantic_rank, f.distance, f.score,
    p.title, p.heading, p.content, p.block_id, p.page_number, p.char_start, p.passage_index, src.item_kind, src.updated_at,
    -- The chat or document a file is attached to, newest first, so it can be opened.
    case when f.source_kind = 'attachment' then (
      select cd.conversation_id
      from marginchat_app_sessions a
      join marginchat_documents d on d.user_id = a.user_id and coalesce(d.public_id, d.id) = f.source_id
      join marginchat_conversation_documents cd on cd.document_id = d.id
      join marginchat_conversations c on c.id = cd.conversation_id and c.session_id = $1
      where a.id = $1
      order by cd.attached_at desc
      limit 1
    ) end as attached_to
  from fused f
  join marginchat_vault_passages p
    on p.session_id = $1 and p.source_kind = f.source_kind and p.source_id = f.source_id and p.content_hash = f.content_hash
  join marginchat_vault_passage_sources src
    on src.session_id = $1 and src.source_kind = f.source_kind and src.source_id = f.source_id
  -- Passages of a document hidden from AI since they were indexed are never returned.
  where not exists (select 1 from marginchat_conversations hidden
    where hidden.session_id = $1 and hidden.ai_hidden and hidden.id = case
      when f.source_kind = 'conversation' then f.source_id when f.source_kind = 'vault-file' then $8 || f.source_id end)
  order by f.score desc, f.semantic_rank nulls last, f.keyword_rank nulls last
  limit $7`;

/**
 * Passages matching `keywords` (a websearch_to_tsquery string) or nearest to
 * `embedding`, best first. `sourceIds` limits the search to those documents and files.
 */
export async function searchPassages(client, { userId, keywords, embedding, model, sourceIds = null, candidates = 50, limit = 10, timeoutMs = 5_000 }) {
  const sessionId = await sessionIdFor(client, userId);
  if (!sessionId) return [];
  const stored = Array.isArray(sourceIds)
    ? sourceIds.flatMap((id) => [toWorkspaceEntityId(sessionId, id), id])
    : null;
  const vector = Array.isArray(embedding) || ArrayBuffer.isView(embedding)
    ? `[${Array.from(embedding, (value) => (Number.isFinite(value) ? value : 0)).join(",")}]`
    : null;
  const rows = await inTransaction(client, async () => {
    await client.query(`set local statement_timeout = ${Math.max(100, Math.min(30_000, Math.trunc(timeoutMs)))}`);
    if (vector) {
      // Filtered nearest-neighbour search keeps scanning the index until it has
      // enough of this user's passages (pgvector 0.8). Older versions do without.
      await client.query("savepoint vector_settings");
      try {
        await client.query("set local hnsw.ef_search = 100");
        await client.query("set local hnsw.iterative_scan = relaxed_order");
        await client.query("release savepoint vector_settings");
      } catch {
        await client.query("rollback to savepoint vector_settings");
      }
    }
    return (await client.query(SEARCH, [sessionId, keywords ?? "", vector, candidates, stored, model, limit, toWorkspaceEntityId(sessionId, "")])).rows;
  });
  return rows.map((row) => ({
    sourceKind: row.source_kind,
    id: row.source_kind === "conversation" ? fromWorkspaceEntityId(sessionId, row.source_id) : row.source_id,
    itemKind: row.item_kind,
    title: row.title,
    heading: row.heading,
    content: row.content,
    blockId: row.block_id,
    pageNumber: row.page_number,
    charStart: Number(row.char_start ?? 0),
    passageIndex: Number(row.passage_index ?? 0),
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    attachedTo: row.attached_to ? fromWorkspaceEntityId(sessionId, row.attached_to) : null,
    keywordRank: row.keyword_rank === null ? null : Number(row.keyword_rank),
    semanticRank: row.semantic_rank === null ? null : Number(row.semantic_rank),
    similarity: row.distance === null || row.distance === undefined ? null : 1 - Number(row.distance),
    score: Number(row.score),
  }));
}

/** An uploaded file's or a vault PDF's indexed text, passage by passage, for reading it whole. */
export async function readFilePassages(client, { userId, fileId, limit = 400 }) {
  const sessionId = await sessionIdFor(client, userId);
  if (!sessionId) return null;
  const source = (await client.query(
    `select source_kind, title, updated_at, passage_count, error from marginchat_vault_passage_sources
     where session_id = $1 and source_kind in ('attachment', 'vault-file') and source_id = $2
     order by source_kind limit 1`,
    [sessionId, fileId],
  )).rows[0];
  if (!source) return null;
  const passages = (await client.query(
    `select content, page_number from marginchat_vault_passages
     where session_id = $1 and source_kind = $2 and source_id = $3
     order by passage_index limit $4`,
    [sessionId, source.source_kind, fileId, limit],
  )).rows;
  return {
    id: fileId, title: source.title, updatedAt: source.updated_at ? new Date(source.updated_at).toISOString() : null,
    error: source.error ?? null, passages: passages.map((row) => ({ content: row.content, pageNumber: row.page_number })),
  };
}
