/** Ratchet claims and check receipts (migration 0029). */

/** Replace one document's claims with a check's, and keep the check's receipt, together. */
export async function saveRatchetCheck(client, { userId, documentId, claims, run }) {
  await client.query("delete from marginchat_ratchet_claims where user_id = $1 and doc_id = $2", [userId, documentId]);
  if (claims.length) {
    await client.query(
      `insert into marginchat_ratchet_claims (user_id, doc_id, claim_id, run_id, verdict, claim, created_at, verdict_at)
       select $1, $2, c.claim->>'id', $3, c.claim->>'verdict', c.claim, (c.claim->>'createdAt')::timestamptz, (c.claim->>'verdictAt')::timestamptz
       from jsonb_array_elements($4::jsonb) as c(claim)
       on conflict (user_id, doc_id, claim_id) do update set run_id = excluded.run_id, verdict = excluded.verdict,
         claim = excluded.claim, created_at = excluded.created_at, verdict_at = excluded.verdict_at`,
      [userId, documentId, run.id, JSON.stringify(claims)],
    );
  }
  await client.query(
    `insert into marginchat_ratchet_runs (user_id, doc_id, run_id, receipt, finished_at) values ($1, $2, $3, $4::jsonb, $5)
     on conflict (user_id, run_id) do update set receipt = excluded.receipt, finished_at = excluded.finished_at`,
    [userId, documentId, run.id, JSON.stringify(run), run.finishedAt],
  );
}

/** A document's claims in reading order, and its latest check's receipt. */
export async function readRatchetCheck(client, { userId, documentId }) {
  const claims = await client.query(
    "select claim from marginchat_ratchet_claims where user_id = $1 and doc_id = $2 order by claim->'anchor'->>'blockId', (claim->'anchor'->>'lineStart')::int, claim_id",
    [userId, documentId],
  );
  const run = await client.query(
    "select receipt from marginchat_ratchet_runs where user_id = $1 and doc_id = $2 order by finished_at desc limit 1",
    [userId, documentId],
  );
  return { claims: claims.rows.map((row) => row.claim), run: run.rows[0]?.receipt ?? null };
}
