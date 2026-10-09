const answerColumns = "id, topic_id, topic_label, question, answer, related, author_id, author_name, created_at";

function mapAnswer(row) {
  return {
    id: row.id,
    topicId: row.topic_id,
    topicLabel: row.topic_label,
    question: row.question,
    answer: row.answer,
    related: Array.isArray(row.related) ? row.related : JSON.parse(row.related ?? "[]"),
    authorId: row.author_id ?? null,
    authorName: row.author_name ?? "",
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

export async function readPublicMapState(client, userId) {
  const result = await client.query(
    "select state, revision, updated_at from marginchat_public_map_states where user_id = $1",
    [userId],
  );
  if (!result.rowCount) return null;
  const row = result.rows[0];
  return {
    state: typeof row.state === "string" ? JSON.parse(row.state) : row.state,
    revision: Number(row.revision),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

export async function writePublicMapState(client, { userId, state }) {
  const result = await client.query(
    `insert into marginchat_public_map_states (user_id, state)
     values ($1, $2::jsonb)
     on conflict (user_id) do update
       set state = excluded.state,
           revision = marginchat_public_map_states.revision + 1,
           updated_at = now()
     returning revision, updated_at`,
    [userId, JSON.stringify(state)],
  );
  const row = result.rows[0];
  return { revision: Number(row.revision), updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at) };
}

export async function createPublicAnswer(client, { id, topicId, topicLabel, question, answer, related, authorId, authorName }) {
  const result = await client.query(
    `insert into marginchat_public_answers (id, topic_id, topic_label, question, answer, related, author_id, author_name)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
     returning ${answerColumns}`,
    [id, topicId, topicLabel, question, answer, JSON.stringify(related), authorId, authorName],
  );
  return mapAnswer(result.rows[0]);
}

/** Newest first. Without a topic, this is the shared feed across every topic. */
export async function listPublicAnswers(client, { topicIds = [], limit = 20 } = {}) {
  const result = await client.query(
    `select ${answerColumns} from marginchat_public_answers
     ${topicIds.length ? "where topic_id = any($2::text[])" : ""}
     order by created_at desc, id desc limit $1`,
    topicIds.length ? [limit, topicIds] : [limit],
  );
  return result.rows.map(mapAnswer);
}

/** Authors remove their own answers; admins may remove any answer. */
export async function deletePublicAnswer(client, { id, userId, isAdmin = false }) {
  const result = await client.query(
    isAdmin
      ? "delete from marginchat_public_answers where id = $1 returning id"
      : "delete from marginchat_public_answers where id = $1 and author_id = $2 returning id",
    isAdmin ? [id] : [id, userId],
  );
  return result.rowCount > 0;
}
