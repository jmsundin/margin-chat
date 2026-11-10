import { HttpError } from "../lib/errors.mjs";

/** Most rows one sync request may carry each way; the client sends the rest next time. */
export const FLASHCARD_SYNC_BATCH = 1000;
export const FLASHCARD_SYNC_BODY_LIMIT = 6 * 1024 * 1024;
const MAX_TEXT = 20_000;
const MAX_ID = 200;
const KINDS = new Set(["basic", "reverse", "cloze"]);

const text = (value, max = MAX_TEXT) => (typeof value === "string" && value.length <= max ? value : null);
const id = (value) => (typeof value === "string" && value.length > 0 && value.length <= MAX_ID ? value : null);
const time = (value) => {
  if (typeof value !== "string") return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
};

function readCard(input) {
  if (!input || typeof input !== "object") return null;
  const card = {
    id: id(input.id), docId: id(input.docId), docTitle: text(input.docTitle ?? "", 1000),
    kind: KINDS.has(input.kind) ? input.kind : null, front: text(input.front), back: text(input.back),
    cloze: Number.isInteger(input.cloze) && input.cloze > 0 && input.cloze < 1000 ? input.cloze : null,
    source: input.source === undefined || input.source === null ? null : text(input.source),
    ordinal: Number.isInteger(input.ordinal) && input.ordinal >= 0 ? Math.min(input.ordinal, 1_000_000) : 0,
    historyFrom: Array.isArray(input.historyFrom) ? input.historyFrom.map(id).filter(Boolean).slice(0, 50) : [],
    removed: input.removed === true, suspended: input.suspended === true,
    createdAt: time(input.createdAt), updatedAt: time(input.updatedAt),
  };
  return card.id && card.docId && card.docTitle !== null && card.kind && card.front !== null && card.back !== null && card.source !== undefined && card.createdAt && card.updatedAt ? card : null;
}

function readReview(input) {
  if (!input || typeof input !== "object") return null;
  const review = {
    id: id(input.id), cardId: id(input.cardId),
    rating: [1, 2, 3, 4].includes(input.rating) ? input.rating : null,
    reviewedAt: time(input.reviewedAt),
    durationMs: Number.isInteger(input.durationMs) && input.durationMs >= 0 ? Math.min(input.durationMs, 86_400_000) : null,
  };
  return review.id && review.cardId && review.rating && review.reviewedAt ? review : null;
}

const cursor = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);

export function createFlashcardService({ database }) {
  /**
   * Save what this device has that the account doesn't, then return what other
   * devices saved since this one last asked.
   */
  async function sync({ userId, body }) {
    if (!body || typeof body !== "object") throw new HttpError(400, "Send flashcard changes as JSON.");
    const cardsIn = Array.isArray(body.cards) ? body.cards : [];
    const reviewsIn = Array.isArray(body.reviews) ? body.reviews : [];
    if (cardsIn.length > FLASHCARD_SYNC_BATCH || reviewsIn.length > FLASHCARD_SYNC_BATCH) {
      throw new HttpError(413, `Send at most ${FLASHCARD_SYNC_BATCH} cards and ${FLASHCARD_SYNC_BATCH} reviews at a time.`);
    }
    const cards = cardsIn.map(readCard);
    const reviews = reviewsIn.map(readReview);
    // Refuse the whole batch rather than drop a row quietly; the device keeps it and can show why.
    if (cards.some((card) => !card) || reviews.some((review) => !review)) throw new HttpError(400, "Some flashcard changes were not readable.");
    if (cards.length || reviews.length) await database.saveFlashcardChanges({ userId, cards, reviews });
    const changes = await database.readFlashcardChanges({
      userId, cardSince: cursor(body.cardCursor), reviewSince: cursor(body.reviewCursor), limit: FLASHCARD_SYNC_BATCH,
    });
    return { saved: { cards: cards.map((card) => ({ id: card.id, updatedAt: card.updatedAt })), reviews: reviews.map((review) => review.id) }, ...changes };
  }

  return { sync };
}
