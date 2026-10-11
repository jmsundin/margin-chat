-- One meaning fingerprint (embedding) per document, so the map can group
-- documents about the same subject. content_hash names the text it was made
-- from; a document whose title or text changed is embedded again. Vectors are
-- stored as signed bytes, one per dimension, scaled to the largest component.
create table if not exists marginchat_topic_embeddings (
  session_id text not null references marginchat_app_sessions(id) on delete cascade,
  conversation_id text not null,
  content_hash text not null check (content_hash ~ '^[a-f0-9]{32}$'),
  embedding_model text not null,
  embedding bytea not null check (octet_length(embedding) between 1 and 4096),
  updated_at timestamptz not null default now(),
  primary key (session_id, conversation_id)
);

create index if not exists marginchat_topic_embeddings_updated_idx
  on marginchat_topic_embeddings (session_id, updated_at);
