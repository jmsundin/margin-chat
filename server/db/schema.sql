create table if not exists users (
  id text primary key,
  email text not null unique,
  password_hash text not null,
  display_name text not null,
  role text not null default 'member' check (role in ('member', 'admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists users_email_idx
  on users (email);

create table if not exists auth_sessions (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists auth_sessions_user_id_idx
  on auth_sessions (user_id);

create index if not exists auth_sessions_expires_at_idx
  on auth_sessions (expires_at);

create table if not exists app_sessions (
  id text primary key,
  user_id text references users(id) on delete cascade,
  root_conversation_id text,
  active_conversation_id text,
  rail_open boolean not null default true,
  pinned_thread_ids text[] not null default '{}'::text[],
  graph_layouts jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table app_sessions
  add column if not exists pinned_thread_ids text[] not null default '{}'::text[];

alter table app_sessions
  add column if not exists user_id text references users(id) on delete cascade;

alter table app_sessions
  add column if not exists graph_layouts jsonb not null default '{}'::jsonb;

alter table app_sessions
  add column if not exists default_service_id text;

alter table app_sessions
  add column if not exists default_model_id text;

update app_sessions
set default_service_id = null
where
  default_service_id is not null
  and (
    btrim(default_service_id) = ''
    or default_service_id not in (
      'backend-services',
      'openai-api',
      'gemini-api',
      'huggingface-api',
      'xai-api'
    )
  );

update app_sessions
set default_model_id = null
where default_service_id is null and default_model_id is not null;

update app_sessions
set default_model_id = case default_service_id
  when 'backend-services' then 'smart-routing'
  when 'openai-api' then 'gpt-5.4'
  when 'gemini-api' then 'gemini-3.1-pro-preview'
  when 'huggingface-api' then 'openai/gpt-oss-120b'
  when 'xai-api' then 'grok-4.20-beta-latest-non-reasoning'
  else null
end
where
  default_service_id is not null
  and (
    default_model_id is null
    or btrim(default_model_id) = ''
    or (default_service_id = 'backend-services' and default_model_id not in ('smart-routing'))
    or (
      default_service_id = 'openai-api'
      and default_model_id not in (
        'gpt-5.4',
        'gpt-5.4-pro',
        'gpt-5-chat-latest',
        'gpt-5.4-mini',
        'gpt-5.4-nano'
      )
    )
    or (
      default_service_id = 'gemini-api'
      and default_model_id not in (
        'gemini-3.1-pro-preview',
        'gemini-3-flash-preview',
        'gemini-3.1-flash-lite-preview'
      )
    )
    or (
      default_service_id = 'huggingface-api'
      and default_model_id not in (
        'openai/gpt-oss-120b',
        'deepseek-ai/DeepSeek-R1',
        'Qwen/Qwen3-Coder-480B-A35B-Instruct'
      )
    )
    or (
      default_service_id = 'xai-api'
      and default_model_id not in (
        'grok-4.20-beta-latest-non-reasoning',
        'grok-4',
        'grok-4-fast',
        'grok-4-fast-non-reasoning',
        'grok-4-1-fast-reasoning',
        'grok-4-1-fast-non-reasoning'
      )
    )
  );

alter table app_sessions
  alter column default_service_id set default 'backend-services';

alter table app_sessions
  alter column default_model_id set default 'smart-routing';

alter table app_sessions
  drop constraint if exists app_sessions_default_service_id_check;

alter table app_sessions
  add constraint app_sessions_default_service_id_check check (
    default_service_id is null
    or default_service_id in (
      'backend-services',
      'openai-api',
      'gemini-api',
      'huggingface-api',
      'xai-api'
    )
  );

alter table app_sessions
  drop constraint if exists app_sessions_default_model_id_check;

alter table app_sessions
  add constraint app_sessions_default_model_id_check check (
    (default_service_id is null and default_model_id is null)
    or (default_service_id = 'backend-services' and default_model_id in ('smart-routing'))
    or (
      default_service_id = 'openai-api'
      and default_model_id in (
        'gpt-5.4',
        'gpt-5.4-pro',
        'gpt-5-chat-latest',
        'gpt-5.4-mini',
        'gpt-5.4-nano'
      )
    )
    or (
      default_service_id = 'gemini-api'
      and default_model_id in (
        'gemini-3.1-pro-preview',
        'gemini-3-flash-preview',
        'gemini-3.1-flash-lite-preview'
      )
    )
    or (
      default_service_id = 'huggingface-api'
      and default_model_id in (
        'openai/gpt-oss-120b',
        'deepseek-ai/DeepSeek-R1',
        'Qwen/Qwen3-Coder-480B-A35B-Instruct'
      )
    )
    or (
      default_service_id = 'xai-api'
      and default_model_id in (
        'grok-4.20-beta-latest-non-reasoning',
        'grok-4',
        'grok-4-fast',
        'grok-4-fast-non-reasoning',
        'grok-4-1-fast-reasoning',
        'grok-4-1-fast-non-reasoning'
      )
    )
  );

create unique index if not exists app_sessions_user_id_idx
  on app_sessions (user_id)
  where user_id is not null;

create table if not exists conversations (
  id text primary key,
  session_id text not null references app_sessions(id) on delete cascade,
  title text not null,
  parent_id text references conversations(id) on delete cascade,
  service_id text not null,
  model_id text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

alter table conversations
  add column if not exists model_id text;

alter table conversations
  drop constraint if exists conversations_service_id_check;

alter table conversations
  add constraint conversations_service_id_check check (
    service_id in (
      'backend-services',
      'openai-api',
      'gemini-api',
      'huggingface-api',
      'xai-api'
    )
  );

alter table conversations
  drop constraint if exists conversations_model_id_check;

update conversations
set model_id = case
  when service_id = 'gemini-api' and model_id = 'gemini-3.1-pro-preview-03-25'
    then 'gemini-3.1-pro-preview'
  when service_id = 'gemini-api' and model_id = 'gemini-3-flash-preview-06-17'
    then 'gemini-3-flash-preview'
  when service_id = 'gemini-api' and model_id = 'gemini-3.1-flash-lite-preview-06-17'
    then 'gemini-3.1-flash-lite-preview'
  when service_id = 'openai-api' and model_id = 'gpt-5.2'
    then 'gpt-5.4'
  when service_id = 'openai-api' and model_id = 'gpt-5.2-pro'
    then 'gpt-5.4-pro'
  when service_id = 'openai-api' and model_id = 'gpt-5-mini'
    then 'gpt-5.4-mini'
  when service_id = 'backend-services' and model_id = 'smart-routing'
    then 'smart-routing'
  when service_id = 'openai-api' and model_id in ('gpt-5.4', 'gpt-5.4-pro', 'gpt-5-chat-latest', 'gpt-5.4-mini', 'gpt-5.4-nano')
    then model_id
  when service_id = 'gemini-api' and model_id in ('gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-3.1-flash-lite-preview')
    then model_id
  when service_id = 'huggingface-api' and model_id in ('openai/gpt-oss-120b', 'deepseek-ai/DeepSeek-R1', 'Qwen/Qwen3-Coder-480B-A35B-Instruct')
    then model_id
  when service_id = 'xai-api' and model_id in (
    'grok-4.20-beta-latest-non-reasoning',
    'grok-4',
    'grok-4-fast',
    'grok-4-fast-non-reasoning',
    'grok-4-1-fast-reasoning',
    'grok-4-1-fast-non-reasoning'
  )
    then model_id
  else case service_id
  when 'backend-services' then 'smart-routing'
  when 'openai-api' then 'gpt-5.4'
  when 'gemini-api' then 'gemini-3.1-pro-preview'
  when 'huggingface-api' then 'openai/gpt-oss-120b'
  when 'xai-api' then 'grok-4.20-beta-latest-non-reasoning'
  else 'smart-routing'
end
end
where
  model_id is null
  or btrim(model_id) = ''
  or (service_id = 'backend-services' and model_id not in ('smart-routing'))
  or (
    service_id = 'openai-api'
    and model_id not in (
      'gpt-5.4',
      'gpt-5.4-pro',
      'gpt-5-chat-latest',
      'gpt-5.4-mini',
      'gpt-5.4-nano'
    )
  )
  or (
    service_id = 'gemini-api'
    and model_id not in (
      'gemini-3.1-pro-preview',
      'gemini-3-flash-preview',
      'gemini-3.1-flash-lite-preview'
    )
  )
  or (
    service_id = 'huggingface-api'
    and model_id not in (
      'openai/gpt-oss-120b',
      'deepseek-ai/DeepSeek-R1',
      'Qwen/Qwen3-Coder-480B-A35B-Instruct'
    )
  )
  or (
    service_id = 'xai-api'
    and model_id not in (
      'grok-4.20-beta-latest-non-reasoning',
      'grok-4',
      'grok-4-fast',
      'grok-4-fast-non-reasoning',
      'grok-4-1-fast-reasoning',
      'grok-4-1-fast-non-reasoning'
    )
  );

alter table conversations
  alter column model_id set default 'smart-routing';

alter table conversations
  alter column model_id set not null;

alter table conversations
  add constraint conversations_model_id_check check (
    (service_id = 'backend-services' and model_id in ('smart-routing'))
    or (
      service_id = 'openai-api'
      and model_id in (
        'gpt-5.4',
        'gpt-5.4-pro',
        'gpt-5-chat-latest',
        'gpt-5.4-mini',
        'gpt-5.4-nano'
      )
    )
    or (
      service_id = 'gemini-api'
      and model_id in (
        'gemini-3.1-pro-preview',
        'gemini-3-flash-preview',
        'gemini-3.1-flash-lite-preview'
      )
    )
    or (
      service_id = 'huggingface-api'
      and model_id in (
        'openai/gpt-oss-120b',
        'deepseek-ai/DeepSeek-R1',
        'Qwen/Qwen3-Coder-480B-A35B-Instruct'
      )
    )
    or (
      service_id = 'xai-api'
      and model_id in (
        'grok-4.20-beta-latest-non-reasoning',
        'grok-4',
        'grok-4-fast',
        'grok-4-fast-non-reasoning',
        'grok-4-1-fast-reasoning',
        'grok-4-1-fast-non-reasoning'
      )
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
