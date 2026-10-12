-- Personal tokens that let an outside AI agent (Claude Code, Cursor and other
-- MCP clients) reach a member's cloud vault through /api/mcp. Only the token's
-- hash is stored; the token itself is shown once, when it is made.
create table if not exists marginchat_mcp_tokens (
  id text primary key,
  user_id text not null references marginchat_users(id) on delete cascade,
  name text not null,
  token_hash text not null unique,
  scope text not null default 'read' check (scope in ('read', 'write')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_used_at timestamptz
);

create index if not exists marginchat_mcp_tokens_user_idx
  on marginchat_mcp_tokens(user_id);
