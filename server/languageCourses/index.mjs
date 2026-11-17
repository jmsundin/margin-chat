import { isBuiltInLessonId, isCourseLanguage } from "@margin-chat/workspace-contracts/languageCourses";
import { HttpError } from "../lib/errors.mjs";

/** Language courses: where a learner is in each lesson, and what they studied each day. */

export const LEARN_BODY_LIMIT = 64 * 1024;
const MAX_EVENTS = 200;
const EVENT_TYPES = new Set(["words_read", "words_known", "meanings_saved", "reader_seconds", "lesson_completed", "reviewed"]);
/** A lesson id: one shipped with the app (de-ms-01-a) or one stored for the learner (lsn_…). */
const isLessonId = (value) => typeof value === "string" && (isBuiltInLessonId(value) || /^lsn_[A-Za-z0-9_-]{6,64}$/u.test(value));

export function readLang(value) {
  if (!isCourseLanguage(value)) throw new HttpError(400, "Pick a language written with spaces between words, such as de or es.");
  return value;
}

const time = (value) => {
  if (value === undefined || value === null) return undefined;
  const at = typeof value === "string" ? new Date(value) : null;
  if (!at || Number.isNaN(at.getTime())) return undefined;
  // A device's clock may be off; nothing is recorded as happening in the future.
  return new Date(Math.min(at.getTime(), Date.now())).toISOString();
};
const count = (value, max) => (Number.isFinite(value) ? Math.max(0, Math.min(max, Math.round(value))) : 0);

export function readEvents(input) {
  if (!Array.isArray(input)) return [];
  if (input.length > MAX_EVENTS) throw new HttpError(413, `Send at most ${MAX_EVENTS} study events at a time.`);
  return input.flatMap((event) => {
    if (!event || typeof event !== "object" || !EVENT_TYPES.has(event.type) || !isCourseLanguage(event.lang)) return [];
    const amount = count(event.count, event.type === "reader_seconds" ? 6 * 3600 : 100_000);
    if (!amount) return [];
    return [{ lang: event.lang, type: event.type, lessonId: isLessonId(event.lessonId) ? event.lessonId : null, count: amount, at: time(event.at) }];
  });
}

export function createLanguageCourseService({ database }) {
  function lessonId(value) {
    if (!isLessonId(value)) throw new HttpError(404, "That lesson isn't here.");
    return value;
  }

  /** Saves where the learner is in a lesson; `complete` finishes it. Study events may ride along. */
  async function saveProgress({ userId, lessonId: id, body }) {
    if (!body || typeof body !== "object") throw new HttpError(400, "Send progress as JSON.");
    const lang = readLang(body.lang);
    const lesson = lessonId(id);
    const progress = await database.saveProgress({
      userId, lessonId: lesson, lang, percent: count(body.percent, 100), lastTokenIndex: count(body.lastTokenIndex, 10_000_000),
      seconds: count(body.seconds, 6 * 3600), complete: body.complete === true, at: time(body.at),
    });
    const events = readEvents(body.events);
    if (body.complete === true) events.push({ lang, type: "lesson_completed", lessonId: lesson, count: 1, at: time(body.at) });
    if (events.length) await database.addLearningEvents({ userId, events });
    if (typeof body.courseId === "string" && body.courseId.length <= 120) await database.enroll({ userId, courseId: body.courseId, lang, lastLessonId: lesson });
    return { progress };
  }

  async function recordEvents({ userId, body }) {
    const events = readEvents(body?.events);
    return { saved: events.length ? await database.addLearningEvents({ userId, events }) : 0 };
  }

  async function readProgress({ userId, lang }) {
    return { progress: await database.readProgress({ userId, lang: readLang(lang) }) };
  }

  return { saveProgress, recordEvents, readProgress };
}
