-- The landscape: one position per document on a plane where documents close
-- in meaning sit close together, laid out on the server from each document's
-- nearest neighbours (marginchat_topic_neighbours). Region numbers group the
-- positions into named areas, largest first; -1 is none.
create table if not exists marginchat_landscape_positions (
  session_id text not null references marginchat_app_sessions(id) on delete cascade,
  conversation_id text not null,
  x real not null,
  y real not null,
  region integer not null default -1,
  primary key (session_id, conversation_id)
);

create table if not exists marginchat_landscapes (
  session_id text primary key references marginchat_app_sessions(id) on delete cascade,
  computed_at timestamptz not null default now(),
  documents integer not null,
  regions integer not null
);
