import { randomBytes } from "node:crypto";
import { MINI_STORY_VARIANTS, isBuiltInLessonId, isCourseLanguage, isLearningLevel, sentenceTranslations, tokenizeLesson } from "@margin-chat/workspace-contracts/languageCourses";
import { HttpError } from "../lib/errors.mjs";

/** Language courses: where a learner is in each lesson, and what they studied each day. */

export const LEARN_BODY_LIMIT = 64 * 1024;
/** Lessons made from a document, a pasted text or a page: the whole text comes up at once. */
export const LESSONS_BODY_LIMIT = 2 * 1024 * 1024;
const MAX_LESSONS = 300;
const MAX_LESSON_CHARS = 60_000;
const newId = (prefix) => `${prefix}_${randomBytes(12).toString("base64url")}`;
const text = (value, max) => (typeof value === "string" ? value.replace(/\s+/gu, " ").trim().slice(0, max) : "");
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

  /**
   * Everything the library shows for one language that lives in the account: the learner's
   * profiles, their own courses and lessons (without tokens), enrollments and progress.
   * Mini stories shipped with the app come with the app.
   */
  async function library({ userId, lang: value }) {
    const lang = readLang(value);
    const [profiles, courses, lessons, enrollments, progress] = await Promise.all([
      database.readLearningProfiles({ userId }), database.listCourses({ userId, lang }), database.listLessons({ userId, lang }),
      database.readEnrollments({ userId, lang }), database.readProgress({ userId, lang }),
    ]);
    return { lang, profiles, profile: profiles.find((profile) => profile.lang === lang) ?? null, courses, lessons, enrollments, progress };
  }

  async function profiles({ userId }) {
    return { profiles: await database.readLearningProfiles({ userId }) };
  }

  async function saveProfile({ userId, body }) {
    if (!body || typeof body !== "object") throw new HttpError(400, "Send the profile as JSON.");
    const lang = readLang(body.lang);
    if (body.level !== undefined && !isLearningLevel(body.level)) throw new HttpError(400, "Pick a level from A1 to C2.");
    if (body.nativeLang !== undefined && !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(body.nativeLang)) throw new HttpError(400, "Pick the language meanings should be in.");
    if (body.nativeLang === lang) throw new HttpError(400, "Meanings need to be in a different language from the one you're learning.");
    const goal = body.dailyGoalWords === undefined ? undefined : count(body.dailyGoalWords, 100_000);
    let settings;
    if (body.settings !== undefined) {
      if (!body.settings || typeof body.settings !== "object" || Array.isArray(body.settings) || JSON.stringify(body.settings).length > 4000) throw new HttpError(400, "Settings must be a small JSON object.");
      settings = body.settings;
    }
    return { profile: await database.saveLearningProfile({ userId, lang, nativeLang: body.nativeLang, level: body.level, dailyGoalWords: goal, settings }) };
  }

  async function lesson({ userId, lessonId: id }) {
    const found = isBuiltInLessonId(id) ? null : await database.readLesson({ userId, lessonId: lessonId(id) });
    if (!found) throw new HttpError(404, "That lesson isn't here.");
    return { lesson: found };
  }

  async function enroll({ userId, courseId, body }) {
    if (typeof courseId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/u.test(courseId)) throw new HttpError(404, "That course isn't here.");
    return { enrollment: await database.enroll({ userId, courseId, lang: readLang(body?.lang) }) };
  }

  /**
   * Makes lessons the learner reads: from one of their documents (one course per document, which a
   * refresh brings up to date), from a pasted text or a web page (a course of its own), or a lesson
   * simplified to their level (beside the lesson it came from). The server cuts every lesson's tokens.
   */
  async function createLessons({ userId, body }) {
    if (!body || typeof body !== "object") throw new HttpError(400, "Send the lessons as JSON.");
    const lang = readLang(body.lang);
    if (!Array.isArray(body.lessons) || !body.lessons.length) throw new HttpError(400, "There's no text to make lessons from.");
    if (body.lessons.length > MAX_LESSONS) throw new HttpError(413, `A course can have at most ${MAX_LESSONS} lessons. Try a shorter text.`);
    const level = isLearningLevel(body.level) ? body.level : "A2";
    const documentId = typeof body.documentId === "string" && /^[A-Za-z0-9:._-]{1,120}$/u.test(body.documentId) ? body.documentId : null;
    const sourceHash = typeof body.sourceHash === "string" ? body.sourceHash.slice(0, 64) : null;
    const simplifiedFrom = isLessonId(body.simplifiedFrom) ? body.simplifiedFrom : null;
    const items = body.lessons.flatMap((item, index) => {
      if (!item || typeof item.body !== "string") return [];
      if (item.body.length > MAX_LESSON_CHARS) throw new HttpError(413, "One part of that text is too long for a lesson. Add headings to split it.");
      const cut = tokenizeLesson(item.body, lang);
      if (!cut.wordCount) return [];
      // A translation is kept only when it has a line for every sentence, as the reader shows them side by side.
      const translation = typeof item.translation === "string" && item.translation.length <= MAX_LESSON_CHARS && sentenceTranslations(item.translation.trim(), cut.sentenceCount)
        ? item.translation.trim() : null;
      const variant = MINI_STORY_VARIANTS.includes(item.variant) ? item.variant : null;
      return [{ title: text(item.title, 200) || `Part ${index + 1}`, body: item.body.trim(), cut, translation, variant }];
    });
    if (!items.length) throw new HttpError(400, "There's no text to make lessons from.");
    const title = text(body.title, 200) || items[0].title;
    // A mini story the AI wrote: its story, retelling and questions, told apart by their variant and kept together.
    const story = body.story === true;
    const source = simplifiedFrom || story ? "generated" : documentId ? "document" : "import";
    const storyGroup = story ? newId("grp") : null;
    const row = (item, courseId, pos, id = newId("lsn")) => ({
      id, courseId, lang, pos, title: item.title, level, source, documentId, sourceHash, body: item.body, tokens: item.cut.tokens, norms: item.cut.norms,
      wordCount: item.cut.wordCount, uniqueWordCount: item.cut.uniqueWordCount, variant: story ? item.variant : null, storyGroup, simplifiedFrom,
      translation: item.translation, audioUrl: null,
    });

    if (story) {
      if (items.length !== 3 || items.some((item, index) => item.variant !== MINI_STORY_VARIANTS[index])) throw new HttpError(400, "A mini story comes as its story, retelling and questions.");
      // The learner's stories in a language go in one course of their own, made the first time.
      const courses = await database.listCourses({ userId, lang });
      let course = courses.find((item) => item.kind === "user" && item.tags.includes("mini-stories")) ?? null;
      if (!course) {
        course = await database.saveCourse({ userId, course: { id: newId("crs"), lang, title: "My mini stories", level, kind: "user", tags: ["mini-stories"],
          description: "Stories the AI wrote for you, each told three ways: the story, the same story retold, and questions." } });
        if (!course) throw new HttpError(409, "That course couldn't be made. Try again.");
        await database.enroll({ userId, courseId: course.id, lang });
      }
      const siblings = await database.listLessons({ userId, lang, courseId: course.id });
      const start = siblings.reduce((most, lesson) => Math.max(most, lesson.pos), -1) + 1;
      const lessons = await database.saveLessons({ userId, lessons: items.map((item, index) => row(item, course.id, start + index)) });
      return { course, lessons, created: true };
    }

    // A lesson made simpler goes beside the one it came from, in the same course.
    if (simplifiedFrom) {
      const original = isBuiltInLessonId(simplifiedFrom) ? null : await database.readLesson({ userId, lessonId: simplifiedFrom });
      const courseId = original?.courseId ?? null;
      const siblings = courseId ? await database.listLessons({ userId, lang, courseId }) : [];
      const pos = siblings.reduce((most, lesson) => Math.max(most, lesson.pos), -1) + 1;
      const lessons = await database.saveLessons({ userId, lessons: items.slice(0, 1).map((item) => row(item, courseId, pos)) });
      return { course: null, lessons, created: true };
    }

    let course = documentId ? await database.findCourseForDocument({ userId, documentId, lang }) : null;
    if (course && body.replace !== true) {
      // Already studied: the learner chooses whether to bring it up to date, nothing is rewritten silently.
      const lessons = await database.listLessons({ userId, lang, courseId: course.id });
      return { course, lessons, created: false, stale: Boolean(sourceHash) && lessons.some((lesson) => lesson.sourceHash !== sourceHash) };
    }
    if (!course) {
      course = await database.saveCourse({ userId, course: { id: newId("crs"), lang, title, level, kind: "user", documentId, description: "" } });
      if (!course) throw new HttpError(409, "That course couldn't be made. Try again.");
      await database.enroll({ userId, courseId: course.id, lang });
      const lessons = await database.saveLessons({ userId, lessons: items.map((item, pos) => row(item, course.id, pos)) });
      return { course, lessons, created: true };
    }

    // A refresh: each part keeps its lesson (and the learner's place in it); parts that are gone go,
    // unless the learner has read them.
    const before = await database.listLessons({ userId, lang, courseId: course.id });
    const read = new Set((await database.readProgress({ userId, lang, lessonIds: before.map((lesson) => lesson.id) })).map((progress) => progress.lessonId));
    const fresh = [];
    for (const [pos, item] of items.entries()) {
      const existing = before[pos];
      if (existing) await database.replaceLessonText({ userId, lessonId: existing.id, title: item.title, body: item.body, tokens: item.cut.tokens, norms: item.cut.norms, wordCount: item.cut.wordCount, uniqueWordCount: item.cut.uniqueWordCount, sourceHash });
      else fresh.push(row(item, course.id, pos));
    }
    if (fresh.length) await database.saveLessons({ userId, lessons: fresh });
    for (const extra of before.slice(items.length)) if (!read.has(extra.id)) await database.deleteLesson({ userId, lessonId: extra.id });
    course = await database.saveCourse({ userId, course: { ...course, title, level: course.level } }) ?? course;
    return { course, lessons: await database.listLessons({ userId, lang, courseId: course.id }), created: false, refreshed: true };
  }

  /** The last 30 days of study in a language, each day in the learner's own time zone, and the words they know. */
  async function stats({ userId, lang: value, offsetMinutes }) {
    const lang = readLang(value);
    const offset = Number.isFinite(offsetMinutes) ? Math.max(-14 * 60, Math.min(14 * 60, Math.round(offsetMinutes))) : 0;
    const since = new Date(Date.now() - 31 * 86_400_000).toISOString();
    const [days, words] = await Promise.all([database.readDailyStats({ userId, lang, since, offsetMinutes: offset }), database.readWordCounts({ userId, lang })]);
    return { lang, days, words };
  }

  async function removeLesson({ userId, lessonId: id }) {
    if (isBuiltInLessonId(id)) throw new HttpError(400, "Lessons that come with the app can't be deleted.");
    return { deleted: await database.deleteLesson({ userId, lessonId: lessonId(id) }) };
  }

  return { saveProgress, recordEvents, readProgress, library, profiles, saveProfile, lesson, enroll, createLessons, removeLesson, stats };
}
