-- Documents the user moved to another subject cluster on the map. Each sits
-- with the cluster of anchor_conversation_id instead of where its embedding
-- put it.
create table if not exists marginchat_topic_placements (
  session_id text not null references marginchat_app_sessions(id) on delete cascade,
  conversation_id text not null,
  anchor_conversation_id text not null,
  updated_at timestamptz not null default now(),
  primary key (session_id, conversation_id)
);
