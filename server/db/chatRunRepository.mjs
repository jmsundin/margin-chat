/** Finished replies are kept a day for a browser that comes back late. */
const KEEP_RUNS = "1 day";

function runRecord(row) {
  return {
    id: row.id,
    status: row.status,
    reply: row.reply,
    metadata: row.metadata ?? null,
    documents: Array.isArray(row.documents) ? row.documents : [],
    error: row.error ?? null,
    statusCode: row.status_code ?? null,
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Saves a run's reply so far, or its end. A run that was stopped stays stopped:
 * the save then writes nothing and returns the stopped status, so the server
 * writing the reply knows to stop.
 */
export async function saveChatRun(client, { id, userId, status = "running", reply = "", metadata = null, documents = [], error = null, statusCode = null }) {
  const result = await client.query(
    `insert into marginchat_chat_runs (id, user_id, status, reply, metadata, documents, error, status_code)
     values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)
     on conflict (id) do update set
       status = excluded.status, reply = excluded.reply, metadata = excluded.metadata,
       documents = excluded.documents, error = excluded.error, status_code = excluded.status_code, updated_at = now()
     where marginchat_chat_runs.user_id = excluded.user_id and marginchat_chat_runs.status = 'running'
     returning status`,
    [id, userId, status, reply, metadata === null ? null : JSON.stringify(metadata), JSON.stringify(documents), error, statusCode],
  );
  if (result.rows[0]) {
    if (status !== "running") {
      await client.query(
        `delete from marginchat_chat_runs where user_id = $1 and updated_at < now() - interval '${KEEP_RUNS}'`,
        [userId],
      );
    }
    return result.rows[0].status;
  }
  const current = await client.query("select status from marginchat_chat_runs where id = $1 and user_id = $2", [id, userId]);
  return current.rows[0]?.status ?? null;
}

export async function readChatRun(client, { id, userId }) {
  const result = await client.query(
    `select id, status, reply, metadata, documents, error, status_code, updated_at
     from marginchat_chat_runs where id = $1 and user_id = $2`,
    [id, userId],
  );
  return result.rows[0] ? runRecord(result.rows[0]) : null;
}

/** Marks a run stopped, even before its server has saved anything. */
export async function cancelChatRun(client, { id, userId }) {
  await client.query(
    `insert into marginchat_chat_runs (id, user_id, status) values ($1, $2, 'cancelled')
     on conflict (id) do update set status = 'cancelled', updated_at = now()
     where marginchat_chat_runs.user_id = excluded.user_id and marginchat_chat_runs.status = 'running'`,
    [id, userId],
  );
}
