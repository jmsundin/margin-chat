/** Flashcards and their review history (migration 0028). */

const iso = (value) => new Date(value).toISOString();

const cardRow = (row) => ({
  id: row.card_id,
  docId: row.doc_id,
  docTitle: row.doc_title,
  kind: row.kind,
  front: row.front,
  back: row.back,
  ...(row.cloze === null || row.cloze === undefined ? {} : { cloze: Number(row.cloze) }),
  ordinal: Number(row.ordinal),
  ...(Array.isArray(row.history_from) && row.history_from.length ? { historyFrom: row.history_from } : {}),
  ...(row.removed ? { removed: true } : {}),
  ...(row.suspended ? { suspended: true } : {}),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

const reviewRow = (row) => ({
  id: row.review_id,
  cardId: row.card_id,
  rating: Number(row.rating),
  reviewedAt: iso(row.reviewed_at),
  ...(row.duration_ms === null || row.duration_ms === undefined ? {} : { durationMs: Number(row.duration_ms) }),
});

/**
 * Save what a device sent. A card replaces the stored one only when it is newer;
 * a review is added once and never changed.
 */
export async function saveFlashcardChanges(client, { userId, cards, reviews }) {
  // One statement per kind, however many rows: each round trip to the database costs more than the rows.
  if (cards.length) {
    await client.query(
      `insert into marginchat_flashcards
         (user_id, card_id, doc_id, doc_title, kind, front, back, cloze, ordinal, history_from, removed, suspended, created_at, updated_at)
       select distinct on (c.id) $1, c.id, c."docId", c."docTitle", c.kind, c.front, c.back, c.cloze, c.ordinal,
         coalesce(c."historyFrom", '[]'::jsonb), coalesce(c.removed, false), coalesce(c.suspended, false), c."createdAt", c."updatedAt"
       from jsonb_to_recordset($2::jsonb) as c(id text, "docId" text, "docTitle" text, kind text, front text, back text,
         cloze integer, ordinal integer, "historyFrom" jsonb, removed boolean, suspended boolean, "createdAt" timestamptz, "updatedAt" timestamptz)
       order by c.id, c."updatedAt" desc
       on conflict (user_id, card_id) do update set
         doc_id = excluded.doc_id, doc_title = excluded.doc_title, kind = excluded.kind,
         front = excluded.front, back = excluded.back, cloze = excluded.cloze, ordinal = excluded.ordinal,
         history_from = excluded.history_from, removed = excluded.removed, suspended = excluded.suspended,
         updated_at = excluded.updated_at,
         seq = nextval(pg_get_serial_sequence('marginchat_flashcards', 'seq'))
       where marginchat_flashcards.updated_at < excluded.updated_at`,
      [userId, JSON.stringify(cards)],
    );
  }
  if (reviews.length) {
    await client.query(
      `insert into marginchat_flashcard_reviews (user_id, review_id, card_id, rating, reviewed_at, duration_ms)
       select $1, r.id, r."cardId", r.rating, r."reviewedAt", r."durationMs"
       from jsonb_to_recordset($2::jsonb) as r(id text, "cardId" text, rating smallint, "reviewedAt" timestamptz, "durationMs" integer)
       on conflict (user_id, review_id) do nothing`,
      [userId, JSON.stringify(reviews)],
    );
  }
}

/** Cards and reviews stored after the cursors from an earlier read, oldest first. */
export async function readFlashcardChanges(client, { userId, cardSince = 0, reviewSince = 0, limit = 2000 }) {
  const cards = await client.query(
    `select *, seq::text as seq_text from marginchat_flashcards where user_id = $1 and seq > $2 order by seq limit $3`,
    [userId, cardSince, limit],
  );
  const reviews = await client.query(
    `select *, seq::text as seq_text from marginchat_flashcard_reviews where user_id = $1 and seq > $2 order by seq limit $3`,
    [userId, reviewSince, limit],
  );
  return {
    cards: cards.rows.map(cardRow),
    reviews: reviews.rows.map(reviewRow),
    cardCursor: cards.rows.length ? Number(cards.rows.at(-1).seq_text) : cardSince,
    reviewCursor: reviews.rows.length ? Number(reviews.rows.at(-1).seq_text) : reviewSince,
    more: cards.rows.length === limit || reviews.rows.length === limit,
  };
}
