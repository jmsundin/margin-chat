export async function listUserApiKeys(client, userId) {
  const result = await client.query(
    `
      select provider, encrypted_api_key, key_hint
      from marginchat_user_api_keys
      where user_id = $1
      order by provider
    `,
    [userId],
  );

  return result.rows.map((row) => ({
    encryptedApiKey: row.encrypted_api_key,
    keyHint: row.key_hint,
    provider: row.provider,
  }));
}

export async function upsertUserApiKey(
  client,
  { encryptedApiKey, keyHint, provider, userId },
) {
  await client.query(
    `
      insert into marginchat_user_api_keys (
        user_id,
        provider,
        encrypted_api_key,
        key_hint
      )
      values ($1, $2, $3, $4)
      on conflict (user_id, provider) do update
      set
        encrypted_api_key = excluded.encrypted_api_key,
        key_hint = excluded.key_hint,
        updated_at = now()
    `,
    [userId, provider, encryptedApiKey, keyHint],
  );
}

export async function deleteUserApiKey(client, { provider, userId }) {
  await client.query(
    "delete from marginchat_user_api_keys where user_id = $1 and provider = $2",
    [userId, provider],
  );
}
