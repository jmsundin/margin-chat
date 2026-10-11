-- Search by keyword and by meaning over every saved document, note, chat and
-- uploaded file. Each source is split into passages; fingerprint records which
-- version of the source (its row version) the passages were made from.
create table if not exists marginchat_vault_passage_sources (
  session_id text not null references marginchat_app_sessions(id) on delete cascade,
  source_kind text not null check (source_kind in ('conversation', 'attachment')),
  source_id text not null,
  item_kind text not null check (item_kind in ('document', 'note', 'chat', 'file')),
  title text not null,
  fingerprint text not null,
  passage_count integer not null default 0 check (passage_count >= 0),
  error text,
  updated_at timestamptz,
  indexed_at timestamptz not null default now(),
  primary key (session_id, source_kind, source_id)
);

-- A passage is identified by the hash of the exact text that is embedded, so
-- an edit elsewhere in its document keeps its embedding. topic_hash is set on
-- a document's opening passage, whose text is the same as its topic embedding's
-- (marginchat_topic_embeddings), so the two share one embedding request.
create table if not exists marginchat_vault_passages (
  session_id text not null,
  source_kind text not null,
  source_id text not null,
  content_hash text not null check (content_hash ~ '^[a-f0-9]{32}$'),
  passage_index integer not null check (passage_index >= 0),
  title text not null,
  heading text,
  content text not null,
  block_id text,
  page_number integer check (page_number is null or page_number > 0),
  char_start integer not null default 0 check (char_start >= 0),
  topic_hash text check (topic_hash is null or topic_hash ~ '^[a-f0-9]{32}$'),
  embedding_model text,
  embedding halfvec(512),
  search tsvector generated always as (
    setweight(to_tsvector('english', title), 'A')
    || setweight(to_tsvector('english', coalesce(heading, '')), 'B')
    || to_tsvector('english', content)
  ) stored,
  primary key (session_id, source_kind, source_id, content_hash),
  foreign key (session_id, source_kind, source_id)
    references marginchat_vault_passage_sources (session_id, source_kind, source_id) on delete cascade
);

create index if not exists marginchat_vault_passages_search_idx
  on marginchat_vault_passages using gin (search);

create index if not exists marginchat_vault_passages_embedding_idx
  on marginchat_vault_passages using hnsw (embedding halfvec_cosine_ops);

create index if not exists marginchat_vault_passages_unembedded_idx
  on marginchat_vault_passages (session_id, passage_index) where embedding is null;

-- Whether the user lets their vault text be sent for embeddings. No row means yes.
create table if not exists marginchat_vault_index_settings (
  user_id text primary key references marginchat_users(id) on delete cascade,
  cloud_embeddings boolean not null default true,
  updated_at timestamptz not null default now()
);
