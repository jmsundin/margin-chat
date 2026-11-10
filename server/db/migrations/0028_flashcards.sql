-- Flashcards (thread "Add Anki-style flashcards"). The card's words live in the
-- user's documents; these rows are a copy so every device can study without
-- opening the documents, plus every answer ever given. Reviews are only added,
-- never changed, so a card's schedule can always be replayed from them.

create table if not exists marginchat_flashcards (
  user_id text not null references marginchat_users(id) on delete cascade,
  card_id text not null,
  doc_id text not null,
  doc_title text not null default '',
  kind text not null check (kind in ('basic', 'reverse', 'cloze')),
  front text not null,
  back text not null,
  cloze integer,
  ordinal integer not null default 0,
  history_from jsonb not null default '[]'::jsonb,
  removed boolean not null default false,
  suspended boolean not null default false,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  seq bigserial not null,
  primary key (user_id, card_id)
);

create index if not exists marginchat_flashcards_seq_idx on marginchat_flashcards(user_id, seq);

create table if not exists marginchat_flashcard_reviews (
  user_id text not null references marginchat_users(id) on delete cascade,
  review_id text not null,
  card_id text not null,
  rating smallint not null check (rating between 1 and 4),
  reviewed_at timestamptz not null,
  duration_ms integer,
  received_at timestamptz not null default now(),
  seq bigserial not null,
  primary key (user_id, review_id)
);

create index if not exists marginchat_flashcard_reviews_seq_idx on marginchat_flashcard_reviews(user_id, seq);
create index if not exists marginchat_flashcard_reviews_card_idx on marginchat_flashcard_reviews(user_id, card_id);
