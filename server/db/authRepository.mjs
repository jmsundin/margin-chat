import { createStatusError } from "../lib/errors.mjs";
import { mapBillingRow } from "../billing/status.mjs";

export async function createUser(
  client,
  { displayName, email, id, passwordHash, role },
) {
  try {
    const result = await client.query(
      `
        insert into marginchat_user_accounts (
          id,
          email,
          password_hash,
          display_name,
          role
        )
        values ($1, $2, $3, $4, $5)
        returning
          id,
          email,
          display_name,
          role,
          stripe_customer_id,
          billing_status,
          billing_price_id,
          billing_current_period_end,
          billing_cancel_at_period_end,
          trial_api_calls_used,
          trial_api_calls_limit
      `,
      [id, email, passwordHash, displayName, role],
    );

    return mapUserRow(result.rows[0]);
  } catch (error) {
    if (error?.code === "23505") {
      throw createStatusError(409, "An account with that email already exists.");
    }

    throw error;
  }
}

export async function createAuthSession(client, { expiresAt, id, userId }) {
  await client.query(
    `
      insert into marginchat_user_sessions (
        id,
        user_id,
        expires_at
      )
      values ($1, $2, $3)
    `,
    [id, userId, expiresAt],
  );
}

export async function deleteAuthSession(client, sessionId) {
  await client.query("delete from marginchat_user_sessions where id = $1", [sessionId]);
}

export async function updateUserProfile(
  client,
  { displayName, email, userId },
) {
  try {
    const result = await client.query(
      `
        update marginchat_user_accounts
        set
          display_name = $1,
          email = $2
        where id = $3
        returning
          id,
          email,
          display_name,
          role,
          stripe_customer_id,
          billing_status,
          billing_price_id,
          billing_current_period_end,
          billing_cancel_at_period_end,
          trial_api_calls_used,
          trial_api_calls_limit
      `,
      [displayName, email, userId],
    );

    if (!result.rowCount) {
      throw createStatusError(404, "User account not found.");
    }

    return mapUserRow(result.rows[0]);
  } catch (error) {
    if (error?.code === "23505") {
      throw createStatusError(409, "An account with that email already exists.");
    }

    throw error;
  }
}

export async function findUserForLogin(client, email) {
  const result = await client.query(
    `
      select
        id,
        email,
        password_hash,
        display_name,
        role,
        stripe_customer_id,
        billing_status,
        billing_price_id,
        billing_current_period_end,
        billing_cancel_at_period_end,
        trial_api_calls_used,
        trial_api_calls_limit
      from marginchat_user_accounts
      where email = $1
    `,
    [email],
  );

  if (!result.rowCount) {
    return null;
  }

  const row = result.rows[0];

  return {
    ...mapUserRow(row),
    passwordHash: row.password_hash,
  };
}

export async function getUserByAuthSession(client, sessionId) {
  await client.query("delete from marginchat_user_sessions where expires_at <= now()");

  const result = await client.query(
    `
      select
        marginchat_user_sessions.id as session_id,
        marginchat_user_accounts.id,
        marginchat_user_accounts.email,
        marginchat_user_accounts.display_name,
        marginchat_user_accounts.role,
        marginchat_user_accounts.stripe_customer_id,
        marginchat_user_accounts.billing_status,
        marginchat_user_accounts.billing_price_id,
        marginchat_user_accounts.billing_current_period_end,
        marginchat_user_accounts.billing_cancel_at_period_end,
        marginchat_user_accounts.trial_api_calls_used,
        marginchat_user_accounts.trial_api_calls_limit
      from marginchat_user_sessions
      join marginchat_user_accounts on marginchat_user_accounts.id = marginchat_user_sessions.user_id
      where marginchat_user_sessions.id = $1
        and marginchat_user_sessions.expires_at > now()
    `,
    [sessionId],
  );

  if (!result.rowCount) {
    return null;
  }

  await client.query(
    `
      update marginchat_user_sessions
      set last_seen_at = now()
      where id = $1
    `,
    [sessionId],
  );

  return {
    sessionId,
    user: mapUserRow(result.rows[0]),
  };
}

function mapUserRow(row) {
  return {
    billing: mapBillingRow(row),
    displayName: row.display_name,
    email: row.email,
    id: row.id,
    role: row.role,
  };
}
