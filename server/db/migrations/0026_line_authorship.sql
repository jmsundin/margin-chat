-- Line authorship (who wrote each line of a document), projected from the
-- per-revision sidecars the vault service writes beside its history. Like every
-- other projection here, both tables can be rebuilt from cloud storage.

-- One row per saved revision of a document: who saved it and what it came from.
create table if not exists marginchat_document_revisions (
  user_id text not null references marginchat_users(id) on delete cascade,
  document_id text not null,
  revision_key text not null,
  revision_id text not null,
  parent_revision_id text,
  vault_revision bigint not null,
  actor_type text not null check (actor_type in ('human', 'ai', 'agent', 'import', 'system', 'unknown')),
  actor_id text,
  actor_label text,
  source text not null check (source in ('editor', 'ask-ai', 'agent-mode', 'mcp', 'import', 'capture', 'external-sync', 'system', 'backfill')),
  reason text,
  created_at timestamptz not null default now(),
  primary key (user_id, document_id, revision_key)
);

create index if not exists marginchat_document_revisions_recent_idx
  on marginchat_document_revisions(user_id, document_id, vault_revision desc);

-- The current revision's lines only; history comes from the sidecars.
create table if not exists marginchat_line_authorship (
  user_id text not null references marginchat_users(id) on delete cascade,
  document_id text not null,
  block_id text not null,
  line_index integer not null,
  sha256 text not null,
  author_type text not null check (author_type in ('human', 'ai', 'agent', 'import', 'system', 'unknown')),
  author_id text,
  author_label text,
  origin_revision_id text not null,
  primary key (user_id, document_id, block_id, line_index)
);

-- One row per document: the totals search results and the document header show.
create table if not exists marginchat_document_authorship (
  user_id text not null references marginchat_users(id) on delete cascade,
  document_id text not null,
  revision_key text not null,
  revision_id text not null,
  human_lines integer not null default 0,
  ai_lines integer not null default 0,
  agent_lines integer not null default 0,
  import_lines integer not null default 0,
  system_lines integer not null default 0,
  unknown_lines integer not null default 0,
  total_lines integer not null default 0,
  last_actor_type text,
  last_actor_label text,
  updated_at timestamptz not null default now(),
  primary key (user_id, document_id)
);
