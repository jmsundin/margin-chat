-- Each document's topic embedding as a pgvector column, so the server finds
-- the documents nearest in meaning. Before, the map compared every pair in
-- the browser, which capped grouping by subject at 3,000 documents.
--
-- The stored bytes are signed int8 components scaled to the largest one;
-- cosine distance does not mind the scale, so no document is re-embedded.
create or replace function marginchat_int8_halfvec(bytes bytea) returns halfvec
language sql immutable strict as $$
  select (select array_agg((case when b > 127 then b - 256 else b end)::real order by i)
          from generate_series(0, octet_length(bytes) - 1) as i
          cross join lateral (select get_byte(bytes, i) as b) as byte)::halfvec
$$;

alter table marginchat_topic_embeddings
  add column if not exists vector halfvec(512);

update marginchat_topic_embeddings
  set vector = marginchat_int8_halfvec(embedding)
  where vector is null and octet_length(embedding) = 512;

create index if not exists marginchat_topic_embeddings_vector_idx
  on marginchat_topic_embeddings using hnsw (vector halfvec_cosine_ops);

-- The 12 documents nearest in meaning to each document, kept up to date as
-- documents are embedded. The map groups by these instead of every pair.
create table if not exists marginchat_topic_neighbours (
  session_id text not null references marginchat_app_sessions(id) on delete cascade,
  conversation_id text not null,
  neighbour_id text not null,
  similarity real not null,
  updated_at timestamptz not null default now(),
  primary key (session_id, conversation_id, neighbour_id)
);

create index if not exists marginchat_topic_neighbours_updated_idx
  on marginchat_topic_neighbours (session_id, updated_at);
