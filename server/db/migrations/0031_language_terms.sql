-- Language learning: what a person knows about each word or phrase they meet
-- while reading in a language they're learning. One row per person, language
-- and term (lowercased; a phrase has spaces). The newest change wins, so two
-- devices can both rate words and merge.

create table if not exists marginchat_language_terms (
  user_id text not null references marginchat_users(id) on delete cascade,
  language text not null,
  term_key text not null,
  meaning text not null default '',
  status smallint not null check (status between -1 and 5),
  tags jsonb not null default '[]'::jsonb,
  doc_ids jsonb not null default '[]'::jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  seq bigserial not null,
  primary key (user_id, language, term_key)
);

create index if not exists marginchat_language_terms_seq_idx on marginchat_language_terms(user_id, seq);
