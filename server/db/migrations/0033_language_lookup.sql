-- Language lookup: dictionary senses and machine translations fetched for a
-- tapped word, shared by everyone, so a repeat lookup needs no outside request.
-- Wiktionary rows are refetched after 30 days, machine translations after 90.

create table if not exists marginchat_lookup_cache (
  source text not null,
  src_lang text not null,
  tgt_lang text not null,
  term text not null,
  payload jsonb not null,
  fetched_at timestamptz not null default now(),
  primary key (source, src_lang, tgt_lang, term)
);

-- Where a saved meaning came from: 'user', 'wiktionary', 'google', 'deepl' or 'ai'. Empty for older rows.
alter table marginchat_language_terms add column if not exists meaning_source text not null default '';
