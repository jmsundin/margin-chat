-- The literature library: papers from PubMed kept beside the vault, never in
-- it. A paper is public and stored once however many readers import it; a
-- field (a search the reader imported) and its layout belong to the reader.
create table if not exists marginchat_library_works (
  id text primary key check (id ~ '^pubmed:[0-9]{1,12}$'),
  title text not null,
  abstract text not null default '',
  year integer,
  journal text,
  doi text,
  authors text,
  topics text[] not null default '{}',
  embedding_model text,
  vector halfvec(512),
  fetched_at timestamptz not null default now()
);

create table if not exists marginchat_library_fields (
  id text primary key,
  session_id text not null references marginchat_app_sessions(id) on delete cascade,
  query text not null check (char_length(query) between 2 and 300),
  source text not null default 'pubmed',
  target integer not null check (target between 1 and 5000),
  available integer,
  fetched integer not null default 0,
  regions jsonb not null default '[]',
  laid_out_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists marginchat_library_fields_session_idx
  on marginchat_library_fields (session_id, created_at);

create table if not exists marginchat_library_field_works (
  field_id text not null references marginchat_library_fields(id) on delete cascade,
  work_id text not null references marginchat_library_works(id) on delete cascade,
  rank integer not null,
  x real,
  y real,
  region integer not null default -1,
  primary key (field_id, work_id)
);
