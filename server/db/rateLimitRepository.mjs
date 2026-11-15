/**
 * Attempt counters shared by every server instance. A limit's window is split into short
 * slots; an attempt adds one to its slot, and a check sums the slots inside the window.
 */

/** Hits for one key inside the window, and when the oldest of them stops counting. */
export async function countRateLimitHits(client, { bucket, keyHash, since }) {
  const result = await client.query(
    `select coalesce(sum(hits), 0)::integer as hits, min(slot_start) as oldest
       from marginchat_rate_limit_hits
      where bucket = $1 and key_hash = $2 and slot_start > $3`,
    [bucket, keyHash, since],
  );
  const row = result.rows[0] ?? {};
  return { hits: Number(row.hits ?? 0), oldest: row.oldest ? new Date(row.oldest) : null };
}

export async function recordRateLimitHit(client, { bucket, keyHash, slotStart, pruneBefore = null }) {
  await client.query(
    `insert into marginchat_rate_limit_hits (bucket, key_hash, slot_start, hits) values ($1, $2, $3, 1)
     on conflict (bucket, key_hash, slot_start) do update set hits = marginchat_rate_limit_hits.hits + 1`,
    [bucket, keyHash, slotStart],
  );
  // Old slots no longer count toward any limit; clearing them now and then keeps the table small.
  if (pruneBefore) await client.query("delete from marginchat_rate_limit_hits where slot_start < $1", [pruneBefore]);
}

export async function clearRateLimitHits(client, { bucket, keyHash }) {
  await client.query("delete from marginchat_rate_limit_hits where bucket = $1 and key_hash = $2", [bucket, keyHash]);
}
