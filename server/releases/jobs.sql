create table if not exists marginchat_persistence_jobs (
  id text primary key,
  version integer not null check (version > 0),
  checksum text not null,
  status text not null check (status in ('running', 'failed', 'complete')),
  cursor_user_id text,
  upper_user_id text,
  processed_users bigint not null default 0 check (processed_users >= 0),
  failed_user_id text,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists marginchat_persistence_job_users (
  job_id text not null references marginchat_persistence_jobs(id),
  user_id text not null,
  status text not null check (status in ('running', 'failed', 'complete')),
  attempts integer not null default 1 check (attempts > 0),
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (job_id, user_id)
);
