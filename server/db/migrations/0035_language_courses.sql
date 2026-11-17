-- Language courses: what a learner studies in a language and how far they've got.
-- Mini stories shipped with the app live in the code; the lessons stored here are
-- the learner's own (made from a document, pasted text or generated for them).
-- How well each word is known stays in marginchat_language_terms (0031), so a
-- word known in one lesson is known in every lesson and document.

create table if not exists marginchat_learning_profiles (
  user_id text not null references marginchat_users(id) on delete cascade,
  lang text not null,
  native_lang text not null default 'en',
  level text not null default 'A1' check (level in ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')),
  daily_goal_words integer not null default 20 check (daily_goal_words between 0 and 100000),
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, lang)
);

create table if not exists marginchat_courses (
  id text primary key,
  owner_user_id text references marginchat_users(id) on delete cascade,
  lang text not null,
  title text not null,
  description text not null default '',
  level text not null default 'A1',
  kind text not null check (kind in ('mini_stories', 'guided', 'user')),
  document_id text,
  cover_url text,
  tags jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists marginchat_courses_owner_idx on marginchat_courses(owner_user_id, lang);

create table if not exists marginchat_lessons (
  id text primary key,
  owner_user_id text not null references marginchat_users(id) on delete cascade,
  course_id text references marginchat_courses(id) on delete cascade,
  lang text not null,
  pos integer not null default 0,
  title text not null,
  level text not null default 'A1',
  source text not null check (source in ('generated', 'document', 'import')),
  document_id text,
  -- A fingerprint of the document text the lesson was made from, to notice when it changes.
  source_hash text,
  body text not null,
  tokens jsonb not null,
  -- The lesson's distinct words, so the library can say what share of them are new without reading every token.
  norms jsonb not null default '[]'::jsonb,
  word_count integer not null,
  unique_word_count integer not null,
  variant text check (variant in ('a', 'b', 'qa')),
  story_group text,
  simplified_from text,
  translation text,
  audio_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists marginchat_lessons_owner_idx on marginchat_lessons(owner_user_id, lang, course_id, pos);
create index if not exists marginchat_lessons_document_idx on marginchat_lessons(owner_user_id, document_id) where document_id is not null;

-- Course and lesson ids here are either a stored row's id or a shipped course's id (like de-ms-01-a), so they aren't foreign keys.
create table if not exists marginchat_course_enrollments (
  user_id text not null references marginchat_users(id) on delete cascade,
  course_id text not null,
  lang text not null,
  enrolled_at timestamptz not null default now(),
  last_lesson_id text,
  primary key (user_id, course_id)
);

create table if not exists marginchat_lesson_progress (
  user_id text not null references marginchat_users(id) on delete cascade,
  lesson_id text not null,
  lang text not null,
  status text not null default 'in_progress' check (status in ('not_started', 'in_progress', 'completed')),
  percent integer not null default 0 check (percent between 0 and 100),
  last_token_index integer not null default 0,
  read_count integer not null default 0,
  seconds integer not null default 0,
  opened_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, lesson_id)
);
create index if not exists marginchat_lesson_progress_opened_idx on marginchat_lesson_progress(user_id, lang, opened_at desc);

create table if not exists marginchat_learning_events (
  id bigserial primary key,
  user_id text not null references marginchat_users(id) on delete cascade,
  lang text not null,
  type text not null check (type in ('words_read', 'words_known', 'meanings_saved', 'reader_seconds', 'lesson_completed', 'reviewed')),
  lesson_id text,
  count integer not null default 1,
  at timestamptz not null default now()
);
create index if not exists marginchat_learning_events_idx on marginchat_learning_events(user_id, lang, at);

-- The sentence a word was saved from, and its review schedule (an FSRS card) once it has a meaning.
alter table marginchat_language_terms add column if not exists fragment text not null default '';
alter table marginchat_language_terms add column if not exists srs jsonb;
alter table marginchat_language_terms add column if not exists srs_due_at timestamptz;
create index if not exists marginchat_language_terms_due_idx on marginchat_language_terms(user_id, language, srs_due_at) where srs_due_at is not null;
