-- OAuth for MCP connectors (ChatGPT, claude.ai): clients register themselves,
-- a member approves one on Margin Chat's consent page, and the client trades the
-- one-time code for an access token. The access token is a row in
-- marginchat_mcp_tokens, so it lists and revokes with the member's other agents.
create table if not exists marginchat_oauth_clients (
  client_id text primary key,
  client_name text not null,
  redirect_uris jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists marginchat_oauth_codes (
  code_hash text primary key,
  client_id text not null references marginchat_oauth_clients(client_id) on delete cascade,
  user_id text not null references marginchat_users(id) on delete cascade,
  redirect_uri text not null,
  code_challenge text not null,
  scope text not null check (scope in ('read', 'write')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- A connector's row: its access token expires within the hour and is renewed
-- with the refresh token, which lasts until expires_at and rotates on each use.
alter table marginchat_mcp_tokens
  add column if not exists client_id text references marginchat_oauth_clients(client_id) on delete cascade;
alter table marginchat_mcp_tokens
  add column if not exists refresh_token_hash text unique;
alter table marginchat_mcp_tokens
  add column if not exists access_expires_at timestamptz;
