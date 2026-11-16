/** Words and phrases a person is learning, with their meaning and how well they know each (migration 0030). */

const iso = (value) => new Date(value).toISOString();

const termRow = (row) => ({
  language: row.language,
  key: row.term_key,
  meaning: row.meaning,
  source: row.meaning_source ?? "",
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
    `insert into marginchat_language_terms (user_id, language, term_key, meaning, meaning_source, status, tags, doc_ids, created_at, updated_at)
     select distinct on (t.language, t.key) $1, t.language, t.key, t.meaning, coalesce(t.source, ''), t.status, coalesce(t.tags, '[]'::jsonb), coalesce(t."docIds", '[]'::jsonb), t."createdAt", t."updatedAt"
     from jsonb_to_recordset($2::jsonb) as t(language text, key text, meaning text, source text, status smallint, tags jsonb, "docIds" jsonb, "createdAt" timestamptz, "updatedAt" timestamptz)
     order by t.language, t.key, t."updatedAt" desc
     on conflict (user_id, language, term_key) do update set
       meaning = excluded.meaning, meaning_source = excluded.meaning_source, status = excluded.status, tags = excluded.tags, doc_ids = excluded.doc_ids, updated_at = excluded.updated_at,
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

/** A cached lookup answer, or null. */
export async function readLookupCache(client, { source, srcLang, tgtLang, term }) {
  const result = await client.query(
    `select payload, fetched_at from marginchat_lookup_cache where source = $1 and src_lang = $2 and tgt_lang = $3 and term = $4`,
    [source, srcLang, tgtLang, term],
  );
  return result.rows[0] ? { payload: result.rows[0].payload, fetchedAt: iso(result.rows[0].fetched_at) } : null;
}

export async function saveLookupCache(client, { source, srcLang, tgtLang, term, payload, fetchedAt }) {
  await client.query(
    `insert into marginchat_lookup_cache (source, src_lang, tgt_lang, term, payload, fetched_at) values ($1, $2, $3, $4, $5::jsonb, $6)
     on conflict (source, src_lang, tgt_lang, term) do update set payload = excluded.payload, fetched_at = excluded.fetched_at`,
    [source, srcLang, tgtLang, term, JSON.stringify(payload), fetchedAt],
  );
}
