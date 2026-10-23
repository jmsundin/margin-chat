-- An Ask AI or agent reply keeps running when the browser that asked for it
-- disconnects, which phones do when the user switches tabs or apps. The server
-- saves the reply here as it goes, so the browser can pick it up when it comes
-- back, and so Stop reaches whichever server instance is writing the reply.
create table if not exists marginchat_chat_runs (
  id text primary key,
  user_id text not null references marginchat_users(id) on delete cascade,
  status text not null default 'running' check (status in ('running', 'complete', 'failed', 'cancelled')),
  reply text not null default '',
  metadata jsonb,
  documents jsonb not null default '[]'::jsonb,
  error text,
  status_code integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists marginchat_chat_runs_user_idx
  on marginchat_chat_runs(user_id, updated_at);
