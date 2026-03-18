import { createStatusError } from "../lib/errors.mjs";

export async function createUser(
  client,
  { displayName, email, id, passwordHash, role },
) {
  try {
    const result = await client.query(
      `
        insert into users (
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
          role
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
      insert into auth_sessions (
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
  await client.query("delete from auth_sessions where id = $1", [sessionId]);
}

export async function updateUserProfile(
  client,
  { displayName, email, userId },
) {
  try {
    const result = await client.query(
      `
        update users
        set
          display_name = $1,
          email = $2
        where id = $3
        returning
          id,
          email,
          display_name,
          role
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
        role
      from users
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
  await client.query("delete from auth_sessions where expires_at <= now()");

  const result = await client.query(
    `
      select
        auth_sessions.id as session_id,
        users.id,
        users.email,
        users.display_name,
        users.role
      from auth_sessions
      join users on users.id = auth_sessions.user_id
      where auth_sessions.id = $1
        and auth_sessions.expires_at > now()
    `,
    [sessionId],
  );

  if (!result.rowCount) {
    return null;
  }

  await client.query(
    `
      update auth_sessions
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
    displayName: row.display_name,
    email: row.email,
    id: row.id,
    role: row.role,
  };
}
