/** The account's interface settings, as one JSON object of setting name → saved string. */
export async function readInterfaceSettings(client, { userId }) {
  const result = await client.query("select settings from marginchat_interface_settings where user_id = $1", [userId]);
  return result.rows[0]?.settings ?? {};
}

/**
 * Merges `changes` into the saved settings in one statement, so two devices changing
 * different settings at once both keep their change. A null value removes that setting.
 */
export async function saveInterfaceSettings(client, { userId, changes }) {
  const set = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== null));
  const removed = Object.keys(changes).filter((key) => changes[key] === null);
  const result = await client.query(
    `insert into marginchat_interface_settings (user_id, settings, updated_at) values ($1, $2::jsonb - $3::text[], now())
     on conflict (user_id) do update set settings = (marginchat_interface_settings.settings || $2::jsonb) - $3::text[], updated_at = now()
     returning settings`,
    [userId, JSON.stringify(set), removed],
  );
  return result.rows[0]?.settings ?? {};
}
