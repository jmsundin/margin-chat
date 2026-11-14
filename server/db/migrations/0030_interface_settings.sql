-- How each person has set up their interface (thread "Simplify Margin Chat with
-- opt-in features"): which features are on, theme, editor and AI-look choices.
-- One small JSON object per account so every device opens the same way. Keys are
-- the client's own setting names; values are the strings it saves.

create table if not exists marginchat_interface_settings (
  user_id text primary key references marginchat_users(id) on delete cascade,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
