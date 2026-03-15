create table if not exists app_sessions (
  id text primary key,
  root_conversation_id text,
  active_conversation_id text,
  rail_open boolean not null default true,
  pinned_thread_ids text[] not null default '{}'::text[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table app_sessions
  add column if not exists pinned_thread_ids text[] not null default '{}'::text[];

create table if not exists conversations (
  id text primary key,
  session_id text not null references app_sessions(id) on delete cascade,
  title text not null,
  parent_id text references conversations(id) on delete cascade,
  service_id text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

alter table conversations
  drop constraint if exists conversations_service_id_check;

alter table conversations
  add constraint conversations_service_id_check check (
    service_id in (
      'backend-services',
      'openai-api',
      'gemini-api',
      'huggingface-api'
    )
  );

create table if not exists messages (
  id text primary key,
  conversation_id text not null references conversations(id) on delete cascade,
  role text not null check (role in ('system', 'user', 'assistant')),
  content text not null,
  created_at timestamptz not null
);

create table if not exists branch_anchors (
  id text primary key,
  conversation_id text not null unique references conversations(id) on delete cascade,
  source_conversation_id text not null references conversations(id) on delete cascade,
  source_message_id text not null references messages(id) on delete cascade,
  start_offset integer not null check (start_offset >= 0),
  end_offset integer not null check (end_offset > start_offset),
  quote text not null,
  prompt text not null,
  created_at timestamptz not null
);

create index if not exists conversations_session_parent_created_idx
  on conversations (session_id, parent_id, created_at);

create index if not exists messages_conversation_created_idx
  on messages (conversation_id, created_at);

create index if not exists branch_anchors_source_message_idx
  on branch_anchors (source_conversation_id, source_message_id);
