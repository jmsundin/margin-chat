import { randomUUID } from "node:crypto";
import { mapBillingRow } from "../billing/status.mjs";
import { HttpError } from "../lib/errors.mjs";

function tokenSummary(row) {
  return row
    ? {
        createdAt: row.created_at.toISOString(),
        expiresAt: row.expires_at.toISOString(),
        lastUsedAt: row.last_used_at?.toISOString() ?? null,
      }
    : null;
}

export async function getCaptureToken(client, userId) {
  const result = await client.query(
    "select created_at, expires_at, last_used_at from marginchat_capture_tokens where user_id = $1",
    [userId],
  );
  return tokenSummary(result.rows[0]);
}

export async function setCaptureToken(
  client,
  { userId, tokenHash, expiresAt },
) {
  const result = await client.query(
    `
    insert into marginchat_capture_tokens (user_id, token_hash, expires_at)
    values ($1, $2, $3)
    on conflict (user_id) do update set token_hash = excluded.token_hash,
      expires_at = excluded.expires_at, created_at = now(), last_used_at = null
    returning created_at, expires_at, last_used_at
  `,
    [userId, tokenHash, expiresAt],
  );
  return tokenSummary(result.rows[0]);
}

export async function deleteCaptureToken(client, userId) {
  await client.query(
    "delete from marginchat_capture_tokens where user_id = $1",
    [userId],
  );
}

export async function authenticateCaptureToken(client, tokenHash) {
  const result = await client.query(
    `
    update marginchat_capture_tokens t set last_used_at = now()
    from marginchat_users u
    where t.token_hash = $1 and t.expires_at > now() and u.id = t.user_id
    returning u.id, u.display_name, u.role, u.billing_status, t.expires_at
  `,
    [tokenHash],
  );
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        displayName: row.display_name,
        role: row.role,
        billing: mapBillingRow(row),
        expiresAt: row.expires_at.toISOString(),
      }
    : null;
}

export async function createExtensionSession(client, { userId, tokenHash, expiresAt }) {
  await client.query(
    "delete from marginchat_extension_sessions where user_id = $1 and expires_at <= now()",
    [userId],
  );
  await client.query(
    "insert into marginchat_extension_sessions (user_id, token_hash, expires_at) values ($1, $2, $3)",
    [userId, tokenHash, expiresAt],
  );
}

export async function deleteExtensionSession(client, tokenHash) {
  await client.query("delete from marginchat_extension_sessions where token_hash = $1", [tokenHash]);
}

export async function authenticateExtensionSession(client, tokenHash) {
  const result = await client.query(
    `update marginchat_extension_sessions s set last_used_at = now()
     from marginchat_users u
     where s.token_hash = $1 and s.expires_at > now() and u.id = s.user_id
     returning u.id, u.display_name, u.role, u.billing_status, s.expires_at`,
    [tokenHash],
  );
  const row = result.rows[0];
  return row ? {
    id: row.id,
    displayName: row.display_name,
    role: row.role,
    billing: mapBillingRow(row),
    expiresAt: row.expires_at.toISOString(),
  } : null;
}

export async function createCapture(client, { userId, capture, payloadHash }) {
  // One stable ID per save attempt; retries return the receipt even after the popup closes.
  const result = await client.query(
    `
    insert into marginchat_captures (id, user_id, client_capture_id, payload, payload_hash)
    values ($1, $2, $3, $4::jsonb, $5)
    on conflict (user_id, client_capture_id) do update set client_capture_id = excluded.client_capture_id
    returning id, created_at, payload_hash
  `,
    [
      randomUUID(),
      userId,
      capture.clientCaptureId,
      JSON.stringify(capture),
      payloadHash,
    ],
  );
  const row = result.rows[0];
  if (row.payload_hash !== payloadHash)
    throw new HttpError(
      409,
      "This capture ID was already saved with different content. Start a new capture.",
    );
  return { id: row.id, createdAt: row.created_at.toISOString() };
}

export async function listCaptures(client, { userId, cursor = null }) {
  const result = await client.query(
    `
    select id, created_at, payload - 'content' - 'comment' as metadata,
      left(payload->>'content', 180) as excerpt
    from marginchat_captures
    where user_id = $1 and ($2::timestamptz is null or (created_at, id) < ($2::timestamptz, $3::text))
    order by created_at desc, id desc limit 31
  `,
    [userId, cursor?.createdAt ?? null, cursor?.id ?? null],
  );
  const rows = result.rows.slice(0, 30);
  const last = rows.at(-1);
  return {
    captures: rows.map((row) => ({
      ...row.metadata,
      id: row.id,
      createdAt: row.created_at.toISOString(),
      excerpt: row.excerpt,
    })),
    nextCursor:
      result.rows.length > 30
        ? Buffer.from(
            JSON.stringify({
              createdAt: last.created_at.toISOString(),
              id: last.id,
            }),
          ).toString("base64url")
        : null,
  };
}

export async function getCapture(client, { userId, id }) {
  const result = await client.query(
    "select id, created_at, payload from marginchat_captures where user_id = $1 and id = $2",
    [userId, id],
  );
  const row = result.rows[0];
  return row
    ? { ...row.payload, id: row.id, createdAt: row.created_at.toISOString() }
    : null;
}
