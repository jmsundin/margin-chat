import { HttpError } from "../lib/errors.mjs";

/** Most terms one sync request may carry each way; the device sends the rest next time. */
export const LANGUAGE_TERM_SYNC_BATCH = 1000;
export const LANGUAGE_TERM_SYNC_BODY_LIMIT = 2 * 1024 * 1024;
const MAX_KEY = 200;
const MAX_MEANING = 2000;
const MAX_FRAGMENT = 600;

const time = (value) => {
  if (typeof value !== "string") return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
};
const shortList = (value, max, length) => Array.isArray(value)
  ? [...new Set(value.filter((item) => typeof item === "string" && item.trim() && item.length <= length).map((item) => item.trim()))].slice(0, max) : [];

export function readLanguageTerm(input) {
  if (!input || typeof input !== "object") return null;
  const language = typeof input.language === "string" && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(input.language) ? input.language : null;
  const key = typeof input.key === "string" && input.key.trim() && input.key.length <= MAX_KEY ? input.key.trim().replace(/\s+/gu, " ") : null;
  const term = {
    language, key,
    meaning: typeof input.meaning === "string" && input.meaning.length <= MAX_MEANING ? input.meaning : null,
    source: typeof input.source === "string" && /^[a-z]{0,20}$/u.test(input.source) ? input.source : "",
    status: Number.isInteger(input.status) && input.status >= -1 && input.status <= 5 ? input.status : null,
    tags: shortList(input.tags, 20, 60), docIds: shortList(input.docIds, 50, 200),
    // Left out by older devices: undefined keeps what the account has.
    fragment: typeof input.fragment === "string" ? input.fragment.slice(0, MAX_FRAGMENT) : undefined,
    srs: input.srs === undefined ? undefined : readTermSrs(input.srs),
    createdAt: time(input.createdAt), updatedAt: time(input.updatedAt),
  };
  return term.language && term.key && term.meaning !== null && term.status !== null && term.createdAt && term.updatedAt ? term : null;
}

/** A word's review schedule: an FSRS card's state, or null before its first review. Kept only when well formed. */
export function readTermSrs(value) {
  if (value === null) return null;
  if (!value || typeof value !== "object") return undefined;
  const number = (item, min = 0) => (typeof item === "number" && Number.isFinite(item) && item >= min ? item : null);
  const due = number(value.due), stability = number(value.stability), difficulty = number(value.difficulty), reps = number(value.reps), lapses = number(value.lapses);
  const state = ["new", "learning", "review", "relearning"].includes(value.state) ? value.state : null;
  const lastReview = value.lastReview === null ? null : number(value.lastReview);
  if (due === null || stability === null || difficulty === null || reps === null || lapses === null || !state || lastReview === undefined) return undefined;
  // Where a word is in its learning steps, so a card being learned moves on rather than starting them again.
  const step = number(value.step);
  return { state, due, stability, difficulty, reps: Math.round(reps), lapses: Math.round(lapses), lastReview, ...(step === null ? {} : { step: Math.min(20, Math.round(step)) }) };
}

const cursor = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);

export function createLanguageTermService({ database }) {
  /** Save what this device has that the account doesn't, then return what other devices saved since this one last asked. */
  async function sync({ userId, body }) {
    if (!body || typeof body !== "object") throw new HttpError(400, "Send language terms as JSON.");
    const incoming = Array.isArray(body.terms) ? body.terms : [];
    if (incoming.length > LANGUAGE_TERM_SYNC_BATCH) throw new HttpError(413, `Send at most ${LANGUAGE_TERM_SYNC_BATCH} terms at a time.`);
    const terms = incoming.map(readLanguageTerm);
    // Refuse the whole batch rather than drop a term quietly; the device keeps it and sends it again.
    if (terms.some((term) => !term)) throw new HttpError(400, "Some language terms were not readable.");
    if (terms.length) await database.saveLanguageTerms({ userId, terms });
    const changes = await database.readLanguageTerms({ userId, since: cursor(body.cursor), limit: LANGUAGE_TERM_SYNC_BATCH });
    return { saved: terms.map((term) => ({ language: term.language, key: term.key, updatedAt: term.updatedAt })), ...changes };
  }
  return { sync };
}
