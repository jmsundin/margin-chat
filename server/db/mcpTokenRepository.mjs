import { randomUUID } from "node:crypto";
import { mapBillingRow } from "../billing/status.mjs";
import { HttpError } from "../lib/errors.mjs";

/** How many agent tokens one account may hold at once. */
export const MAX_MCP_TOKENS = 20;

function tokenSummary(row) {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    // Connectors that signed in with OAuth, rather than a token the member pasted.
    connector: Boolean(row.client_id),
  };
}

const SUMMARY_COLUMNS = "id, name, scope, created_at, expires_at, last_used_at, client_id";

export async function listMcpTokens(client, userId) {
  const result = await client.query(
    `select ${SUMMARY_COLUMNS} from marginchat_mcp_tokens
     where user_id = $1 and expires_at > now() order by created_at desc`,
    [userId],
  );
  return result.rows.map(tokenSummary);
}

export async function createMcpToken(client, { userId, name, tokenHash, scope = "read", expiresAt }) {
  await client.query("delete from marginchat_mcp_tokens where user_id = $1 and expires_at <= now()", [userId]);
  const count = await client.query("select count(*)::int as count from marginchat_mcp_tokens where user_id = $1", [userId]);
  if (count.rows[0].count >= MAX_MCP_TOKENS) {
    throw new HttpError(409, `You can have at most ${MAX_MCP_TOKENS} agent tokens. Revoke one you no longer use first.`);
  }
  const result = await client.query(
    `insert into marginchat_mcp_tokens (id, user_id, name, token_hash, scope, expires_at)
     values ($1, $2, $3, $4, $5, $6)
     returning ${SUMMARY_COLUMNS}`,
    [randomUUID(), userId, name, tokenHash, scope, expiresAt],
  );
  return tokenSummary(result.rows[0]);
}

export async function deleteMcpToken(client, { userId, id }) {
  const result = await client.query("delete from marginchat_mcp_tokens where user_id = $1 and id = $2 returning id", [userId, id]);
  return result.rows.length > 0;
}

/** The token's account, or null when the token is unknown, revoked or expired. */
export async function authenticateMcpToken(client, tokenHash) {
  // Writing last_used_at on every call would cost a write per tool call; once a minute is enough to show "last used".
  const result = await client.query(
    `update marginchat_mcp_tokens t set last_used_at = case
       when t.last_used_at is null or t.last_used_at < now() - interval '1 minute' then now() else t.last_used_at end
     from marginchat_users u
     where t.token_hash = $1 and t.expires_at > now() and (t.access_expires_at is null or t.access_expires_at > now())
       and u.id = t.user_id
     returning u.id, u.email, u.display_name, u.role, u.billing_status,
       u.stripe_customer_id, u.billing_price_id, u.billing_current_period_end,
       u.billing_cancel_at_period_end, u.trial_api_calls_used,
       u.trial_api_calls_limit, u.hosted_credit_balance_micros, t.id as token_id, t.name as token_name, t.scope`,
    [tokenHash],
  );
  const row = result.rows[0];
  return row ? {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    billing: mapBillingRow(row),
    token: { id: row.token_id, name: row.token_name, scope: row.scope },
  } : null;
}

export async function createOAuthClient(client, { clientId, clientName, redirectUris }) {
  await client.query(
    "insert into marginchat_oauth_clients (client_id, client_name, redirect_uris) values ($1, $2, $3::jsonb)",
    [clientId, clientName, JSON.stringify(redirectUris)],
  );
}

export async function getOAuthClient(client, clientId) {
  const result = await client.query("select client_id, client_name, redirect_uris from marginchat_oauth_clients where client_id = $1", [clientId]);
  const row = result.rows[0];
  return row ? { clientId: row.client_id, clientName: row.client_name, redirectUris: row.redirect_uris } : null;
}

export async function createOAuthCode(client, { codeHash, clientId, userId, redirectUri, codeChallenge, scope, expiresAt }) {
  await client.query("delete from marginchat_oauth_codes where expires_at <= now()");
  await client.query(
    `insert into marginchat_oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [codeHash, clientId, userId, redirectUri, codeChallenge, scope, expiresAt],
  );
}

/** A code works once: reading it deletes it, so a replayed code finds nothing. */
export async function consumeOAuthCode(client, codeHash) {
  const result = await client.query(
    `delete from marginchat_oauth_codes where code_hash = $1 and expires_at > now()
     returning client_id, user_id, redirect_uri, code_challenge, scope`,
    [codeHash],
  );
  const row = result.rows[0];
  return row ? { clientId: row.client_id, userId: row.user_id, redirectUri: row.redirect_uri, codeChallenge: row.code_challenge, scope: row.scope } : null;
}

/** A connector's sign-in replaces any earlier one from the same client, so reconnecting doesn't pile up rows. */
export async function createOAuthConnection(client, { userId, clientId, name, scope, tokenHash, refreshTokenHash, accessExpiresAt, expiresAt }) {
  await client.query("delete from marginchat_mcp_tokens where user_id = $1 and (client_id = $2 or expires_at <= now())", [userId, clientId]);
  const count = await client.query("select count(*)::int as count from marginchat_mcp_tokens where user_id = $1", [userId]);
  if (count.rows[0].count >= MAX_MCP_TOKENS) {
    throw new HttpError(409, `You can have at most ${MAX_MCP_TOKENS} connected agents. Revoke one in Margin Chat's Settings, Agents first.`);
  }
  const result = await client.query(
    `insert into marginchat_mcp_tokens (id, user_id, name, token_hash, scope, expires_at, client_id, refresh_token_hash, access_expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning ${SUMMARY_COLUMNS}`,
    [randomUUID(), userId, name, tokenHash, scope, expiresAt, clientId, refreshTokenHash, accessExpiresAt],
  );
  return tokenSummary(result.rows[0]);
}

/** Swaps a refresh token for new tokens; the old pair stops working. Null when the refresh token is unknown or expired. */
export async function refreshOAuthConnection(client, { clientId, refreshTokenHash, tokenHash, nextRefreshTokenHash, accessExpiresAt, expiresAt }) {
  const result = await client.query(
    `update marginchat_mcp_tokens set token_hash = $3, refresh_token_hash = $4, access_expires_at = $5, expires_at = $6
     where refresh_token_hash = $1 and client_id = $2 and expires_at > now()
     returning scope`,
    [refreshTokenHash, clientId, tokenHash, nextRefreshTokenHash, accessExpiresAt, expiresAt],
  );
  return result.rows[0] ? { scope: result.rows[0].scope } : null;
}

/** Revokes the connection an access or refresh token belongs to. */
export async function revokeMcpCredential(client, tokenHash) {
  await client.query("delete from marginchat_mcp_tokens where token_hash = $1 or refresh_token_hash = $1", [tokenHash]);
}
