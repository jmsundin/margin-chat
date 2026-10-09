-- The public map: each member's saved exploration, plus AI answers which every
-- member can read. Topics are Wikidata item IDs; answers keep their own copy of
-- the related topics so readers never depend on the asker's map.
create table if not exists marginchat_public_map_states (
  user_id text primary key references marginchat_users(id) on delete cascade,
  state jsonb not null,
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now()
);

create table if not exists marginchat_public_answers (
  id uuid primary key,
  topic_id text not null check (topic_id ~ '^Q[1-9][0-9]*$'),
  topic_label text not null check (char_length(topic_label) between 1 and 200),
  question text not null check (char_length(question) between 3 and 500),
  answer text not null check (char_length(answer) between 1 and 3000),
  related jsonb not null default '[]'::jsonb check (jsonb_typeof(related) = 'array'),
  author_id text references marginchat_users(id) on delete set null,
  author_name text not null default '' check (char_length(author_name) <= 80),
  created_at timestamptz not null default now()
);

create index if not exists marginchat_public_answers_topic_idx
  on marginchat_public_answers (topic_id, created_at desc);
create index if not exists marginchat_public_answers_recent_idx
  on marginchat_public_answers (created_at desc);
