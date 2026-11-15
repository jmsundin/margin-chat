/** Words and phrases a person is learning, with their meaning and how well they know each (migration 0030). */

const iso = (value) => new Date(value).toISOString();

const termRow = (row) => ({
  language: row.language,
  key: row.term_key,
  meaning: row.meaning,
  status: Number(row.status),
  tags: Array.isArray(row.tags) ? row.tags : [],
  docIds: Array.isArray(row.doc_ids) ? row.doc_ids : [],
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

/** Save what a device sent. A term replaces the stored one only when it is newer. */
export async function saveLanguageTerms(client, { userId, terms }) {
  if (!terms.length) return;
  await client.query(
    `insert into marginchat_language_terms (user_id, language, term_key, meaning, status, tags, doc_ids, created_at, updated_at)
     select distinct on (t.language, t.key) $1, t.language, t.key, t.meaning, t.status, coalesce(t.tags, '[]'::jsonb), coalesce(t."docIds", '[]'::jsonb), t."createdAt", t."updatedAt"
     from jsonb_to_recordset($2::jsonb) as t(language text, key text, meaning text, status smallint, tags jsonb, "docIds" jsonb, "createdAt" timestamptz, "updatedAt" timestamptz)
     order by t.language, t.key, t."updatedAt" desc
     on conflict (user_id, language, term_key) do update set
       meaning = excluded.meaning, status = excluded.status, tags = excluded.tags, doc_ids = excluded.doc_ids, updated_at = excluded.updated_at,
       seq = nextval(pg_get_serial_sequence('marginchat_language_terms', 'seq'))
     where marginchat_language_terms.updated_at < excluded.updated_at`,
    [userId, JSON.stringify(terms)],
  );
}

/** Terms stored after the cursor from an earlier read, oldest first. */
export async function readLanguageTerms(client, { userId, since = 0, limit = 2000 }) {
  const result = await client.query(
    `select *, seq::text as seq_text from marginchat_language_terms where user_id = $1 and seq > $2 order by seq limit $3`,
    [userId, since, limit],
  );
  return {
    terms: result.rows.map(termRow),
    cursor: result.rows.length ? Number(result.rows.at(-1).seq_text) : since,
    more: result.rows.length === limit,
  };
}
