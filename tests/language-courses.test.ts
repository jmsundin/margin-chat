import { afterEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { loadMigrations, migrateDatabase } from "../server/db/migrations.mjs";
import * as courses from "../server/db/languageCourseRepository.mjs";
import * as languageTermRepository from "../server/db/languageTermRepository.mjs";
import { createLanguageTermService, readLanguageTerm } from "../server/languageTerms/index.mjs";
import {
  LEARNING_LEVELS, builtInMiniStories, isBuiltInLessonId, isCourseLanguage, levelName, newWordsBand, nextLessonIn, percentNew, readStoryLines,
  sentenceTranslations, sourceFingerprint, splitIntoLessons, statusAfterReview, statusAfterSavingMeaning, suggestedStory, termKey, tokenizeLesson, wordsToMarkKnown,
} from "@margin-chat/workspace-contracts/languageCourses";
import germanStories from "@margin-chat/workspace-contracts/miniStories/de";
import { tokenize } from "../client/src/lib/languageReader";
import { LanguageTermStore } from "../client/src/lib/languageTerms";

const words = (body: string, lang = "de") => tokenizeLesson(body, lang).tokens.filter((token) => token.isWord);

describe("cutting a lesson into words", () => {
  test("keeps German capitals on screen but keys every word lowercase, and compounds stay one word", () => {
    const cut = words("Die Kaffeemaschine steht in der Küche. Ich mache Kaffee.");
    expect(cut.map((token) => token.text)).toEqual(["Die", "Kaffeemaschine", "steht", "in", "der", "Küche", "Ich", "mache", "Kaffee"]);
    expect(cut.map((token) => token.norm)).toEqual(["die", "kaffeemaschine", "steht", "in", "der", "küche", "ich", "mache", "kaffee"]);
    expect(cut.map((token) => token.sentence)).toEqual([0, 0, 0, 0, 0, 0, 1, 1, 1]);
  });

  test("punctuation, quotes and dashes aren't words; apostrophes and hyphens join one", () => {
    expect(words("„Wie geht's?“ — Gut, danke! U-Bahn, l'eau.").map((token) => token.norm)).toEqual(["wie", "geht's", "gut", "danke", "u-bahn", "l'eau"]);
    expect(words("Rock’n’Roll").map((token) => token.norm)).toEqual(["rock'n'roll"]);
    expect(termKey("  Straße! ")).toBe("straße");
    // One composed form, so a word typed with a combining accent is the same word.
    expect(termKey("Café")).toBe(termKey("Café"));
  });

  test("counts words, distinct words and sentences through paragraphs, and puts the text back together", () => {
    const body = "Das ist Lena. Lena hat eine Katze.\n\nDie Katze heißt Mimi.";
    const cut = tokenizeLesson(body, "de");
    expect(cut).toMatchObject({ wordCount: 11, uniqueWordCount: 9, sentenceCount: 3 });
    expect(cut.norms.slice(0, 4)).toEqual(["das", "ist", "lena", "hat"]);
    expect(cut.tokens.map((token) => token.text).join("")).toBe("Das ist Lena. Lena hat eine Katze. Die Katze heißt Mimi.");
    expect(cut.tokens.at(-1)?.paragraph).toBe(1);
    expect(cut.tokens.every((token, index) => token.i === index)).toBe(true);
  });

  test("the reader and the server cut words the same way, so a word's key matches", () => {
    const text = "Heute regnet's in der Stadt, aber Anna fährt trotzdem mit dem Fahrrad.";
    expect(tokenize(text, "de").filter((token) => token.key).map((token) => token.key)).toEqual(words(text).map((token) => token.norm));
  });

  test("only languages written with spaces between words can be courses for now", () => {
    expect(isCourseLanguage("de")).toBe(true);
    expect(isCourseLanguage("pt-BR")).toBe(true);
    expect(isCourseLanguage("ja")).toBe(false);
    expect(isCourseLanguage("zh-Hant")).toBe(false);
    expect(isCourseLanguage("German")).toBe(false);
    expect(LEARNING_LEVELS.map(levelName)).toEqual(["Beginner 1", "Beginner 2", "Intermediate 1", "Intermediate 2", "Advanced 1", "Advanced 2"]);
  });
});

describe("new words and statuses", () => {
  const statuses = new Map<string, number>([["das", 5], ["ist", 2], ["lena", -1], ["katze", 0]]);
  const statusOf = (norm: string) => statuses.get(norm);

  test("a lesson's share of new words counts words never rated; ignored and learning words aren't new", () => {
    expect(percentNew(["das", "ist", "lena", "katze", "hund"], statusOf)).toBe(40);
    expect(percentNew([], statusOf)).toBe(0);
    expect([newWordsBand(4), newWordsBand(10), newWordsBand(25), newWordsBand(26)]).toEqual(["easy", "fair", "fair", "hard"]);
  });

  test("turning a page marks only the words still new as known, each once", () => {
    expect(wordsToMarkKnown(["das", "katze", "hund", "katze", "ist", "lena", ""], statusOf)).toEqual(["katze", "hund"]);
  });

  test("saving a meaning starts a new word at 1; a known word keeps its status", () => {
    expect(statusAfterSavingMeaning(undefined)).toBe(1);
    expect(statusAfterSavingMeaning(0)).toBe(1);
    expect(statusAfterSavingMeaning(3)).toBe(3);
    expect(statusAfterSavingMeaning(5)).toBe(5);
  });

  test("Good on a word at 4 makes it known; Again sends it back to 1", () => {
    expect(statusAfterReview(4, 3)).toBe(5);
    expect(statusAfterReview(2, 3)).toBe(3);
    expect(statusAfterReview(3, 3)).toBe(4);
    expect(statusAfterReview(2, 4)).toBe(4);
    expect(statusAfterReview(3, 1)).toBe(1);
    expect(statusAfterReview(2, 2)).toBe(2);
    expect(statusAfterReview(-1, 4)).toBe(-1);
  });
});

describe("lessons from a document", () => {
  const paragraph = (n: number, word = "Wort") => Array.from({ length: n }, () => word).join(" ") + ".";

  test("cuts at headings when the parts are a fair size", () => {
    const parts = splitIntoLessons([
      { heading: "Eins", paragraphs: [paragraph(200), paragraph(150)] },
      { heading: "Zwei", paragraphs: [paragraph(300)] },
    ], { title: "Buch" });
    expect(parts.map((part) => [part.title, part.words])).toEqual([["Eins", 350], ["Zwei", 300]]);
  });

  test("a long stretch with no headings is cut about every 400 words at a paragraph's end, and a scrap joins the one before", () => {
    const parts = splitIntoLessons([{ paragraphs: Array.from({ length: 10 }, () => paragraph(90)).concat(paragraph(30)) }], { title: "Artikel" });
    expect(parts.map((part) => part.words)).toEqual([450, 480]);
    expect(parts.map((part) => part.title)).toEqual(["Artikel, part 1", "Artikel, part 2"]);
    expect(parts[0].body.split("\n\n")).toHaveLength(5);
  });

  test("a short document is one lesson named after it; a fingerprint notices a changed source", () => {
    expect(splitIntoLessons([{ paragraphs: [paragraph(40)] }], { title: "Notiz" }).map((part) => part.title)).toEqual(["Notiz"]);
    expect(sourceFingerprint("Hallo  Welt")).toBe(sourceFingerprint("Hallo Welt\n"));
    expect(sourceFingerprint("Hallo Welt")).not.toBe(sourceFingerprint("Hallo Welt!"));
  });
});

describe("Mini stories shipped with the app", () => {
  const { course, lessons } = builtInMiniStories("de", germanStories);

  test("about twenty German stories, each told three ways in order, all with their own ids", () => {
    expect(germanStories.length).toBeGreaterThanOrEqual(20);
    expect(lessons).toHaveLength(germanStories.length * 3);
    expect(lessons.slice(0, 3).map((lesson) => [lesson.id, lesson.variant, lesson.storyGroup, lesson.pos])).toEqual([
      ["de-ms-01-a", "a", "de-ms-01", 1], ["de-ms-01-b", "b", "de-ms-01", 2], ["de-ms-01-qa", "qa", "de-ms-01", 3],
    ]);
    expect(new Set(lessons.map((lesson) => lesson.id)).size).toBe(lessons.length);
    expect(lessons.every((lesson) => isBuiltInLessonId(lesson.id))).toBe(true);
    expect(isBuiltInLessonId("lsn_123")).toBe(false);
    expect(course).toMatchObject({ id: "de-mini-stories", kind: "mini_stories", levels: ["A1", "A2"], lessonsCount: lessons.length });
    expect(nextLessonIn(lessons, "de-ms-01-a")?.id).toBe("de-ms-01-b");
    expect(nextLessonIn(lessons, "de-ms-01-qa")?.id).toBe("de-ms-02-a");
    expect(nextLessonIn(lessons, lessons.at(-1)!.id)).toBeNull();
  });

  test("every sentence has its translation line, so Sentence mode can show it", () => {
    for (const lesson of lessons) {
      const lines = sentenceTranslations(lesson.translation, lesson.sentenceCount);
      expect({ id: lesson.id, aligned: Boolean(lines), empty: lines?.filter((line) => !line).length }).toEqual({ id: lesson.id, aligned: true, empty: 0 });
    }
  });

  test("stories get longer with the level, and the questions repeat the story's words", () => {
    for (const lesson of lessons.filter((item) => item.variant === "a")) {
      const [min, max] = lesson.level === "A1" ? [60, 130] : [100, 360];
      expect({ id: lesson.id, fits: lesson.wordCount >= min && lesson.wordCount <= max }).toEqual({ id: lesson.id, fits: true });
    }
    for (let story = 1; story <= germanStories.length; story++) {
      const group = lessons.filter((lesson) => lesson.storyNumber === story);
      const [a, b, qa] = group;
      const shared = (one: string[], other: string[]) => one.filter((word) => other.includes(word)).length / one.length;
      // The retelling uses the same words, and most of the questions' words come from the story.
      expect({ story, retold: shared(a.norms, b.norms) > 0.7, questions: shared(qa.norms, [...a.norms, ...b.norms]) > 0.6, longer: qa.wordCount > a.wordCount }).toEqual({ story, retold: true, questions: true, longer: true });
    }
  });

  test("each new story brings a modest number of words the earlier stories haven't used", () => {
    const seen = new Set<string>();
    for (let story = 1; story <= germanStories.length; story++) {
      const fresh = [...new Set(lessons.filter((lesson) => lesson.storyNumber === story).flatMap((lesson) => lesson.norms))].filter((word) => !seen.has(word));
      if (story > 1) expect({ story, fresh: fresh.length <= 80 }).toEqual({ story, fresh: true });
      fresh.forEach((word) => seen.add(word));
    }
  });

  test("written as German | English lines, with blank lines between paragraphs", () => {
    expect(readStoryLines("Das ist Lena. | This is Lena.\nSie wohnt in Berlin. | She lives in Berlin.\n\nLena hat eine Katze. | Lena has a cat.\n")).toEqual({
      body: "Das ist Lena. Sie wohnt in Berlin.\n\nLena hat eine Katze.", translation: "This is Lena.\nShe lives in Berlin.\nLena has a cat.",
    });
  });

  test("the next story suggested is the first whose questions aren't done, until its new words fall below 5%", () => {
    const done = new Set<string>();
    const known = new Set<string>();
    const statusOf = (norm: string) => (known.has(norm) ? 5 : 0);
    expect(suggestedStory(lessons, { completed: (id) => done.has(id), statusOf })?.group).toBe("de-ms-01");
    done.add("de-ms-01-a");
    expect(suggestedStory(lessons, { completed: (id) => done.has(id), statusOf })?.lesson.id).toBe("de-ms-01-b");
    done.add("de-ms-01-qa");
    expect(suggestedStory(lessons, { completed: (id) => done.has(id), statusOf })?.group).toBe("de-ms-02");
    // Knowing nearly every word of story 2 moves on too, even without its questions.
    for (const lesson of lessons.filter((item) => item.storyGroup === "de-ms-02")) lesson.norms.forEach((norm) => known.add(norm));
    expect(suggestedStory(lessons, { completed: (id) => done.has(id), statusOf })?.group).toBe("de-ms-03");
  });
});

const databases: PGlite[] = [];
afterEach(async () => { await Promise.all(databases.splice(0).map((database) => database.close())); });

async function database() {
  const pg = new PGlite({ extensions: { vector } });
  databases.push(pg);
  const client = { async query(sql: string, values?: unknown[]) {
    const result = values === undefined && sql.includes(";") ? (await pg.exec(sql)).at(-1)! : await pg.query(sql, values);
    return { ...result, rowCount: result.rows.length || (result as { affectedRows?: number }).affectedRows || 0 };
  } };
  await migrateDatabase(client, { migrations: await loadMigrations() });
  await pg.query("insert into marginchat_users (id,email,password_hash,display_name) values ('u1','u1@example.test','hash','U1'), ('u2','u2@example.test','hash','U2'), ('u3','u3@example.test','hash','U3')");
  return { pg, client };
}

const lessonRecord = (id: string, body: string, extra: Record<string, unknown> = {}) => {
  const cut = tokenizeLesson(body, "de");
  return { id, courseId: null, lang: "de", pos: 1, title: id, level: "A1", source: "import", body, tokens: cut.tokens, norms: cut.norms, wordCount: cut.wordCount, uniqueWordCount: cut.uniqueWordCount, ...extra };
};

describe("courses in the account", () => {
  test("a profile per language keeps its level and settings, and changes only what is sent", async () => {
    const { client } = await database();
    await courses.saveLearningProfile(client, { userId: "u1", lang: "de", level: "A1" });
    const changed = await courses.saveLearningProfile(client, { userId: "u1", lang: "de", dailyGoalWords: 50, settings: { autoKnown: false } });
    expect(changed).toMatchObject({ lang: "de", nativeLang: "en", level: "A1", dailyGoalWords: 50, settings: { autoKnown: false } });
    await courses.saveLearningProfile(client, { userId: "u1", lang: "es", level: "B1" });
    expect((await courses.readLearningProfiles(client, { userId: "u1" })).map((profile) => profile.lang).sort()).toEqual(["de", "es"]);
    expect(await courses.readLearningProfiles(client, { userId: "u2" })).toEqual([]);
    await expect(courses.saveLearningProfile(client, { userId: "u1", lang: "fr", level: "Z9" })).rejects.toThrow();
  });

  test("a document's course holds its lessons in order; another account sees none of them", async () => {
    const { client } = await database();
    const course = await courses.saveCourse(client, { userId: "u1", course: { id: "crs_1", lang: "de", title: "Mein Tagebuch", kind: "user", documentId: "doc1" } });
    expect(course).toMatchObject({ id: "crs_1", kind: "user", documentId: "doc1" });
    await courses.saveLessons(client, { userId: "u1", lessons: [
      lessonRecord("lsn_2", "Zweiter Teil.", { courseId: "crs_1", pos: 2, source: "document", documentId: "doc1" }),
      lessonRecord("lsn_1", "Erster Teil hier.", { courseId: "crs_1", pos: 1, source: "document", documentId: "doc1", sourceHash: "h1" }),
    ] });
    expect((await courses.listLessons(client, { userId: "u1", lang: "de", courseId: "crs_1" })).map((lesson) => [lesson.id, lesson.norms])).toEqual([["lsn_1", ["erster", "teil", "hier"]], ["lsn_2", ["zweiter", "teil"]]]);
    expect((await courses.listCourses(client, { userId: "u1", lang: "de" }))[0].lessonsCount).toBe(2);
    expect((await courses.findCourseForDocument(client, { userId: "u1", documentId: "doc1", lang: "de" }))?.id).toBe("crs_1");
    const full = await courses.readLesson(client, { userId: "u1", lessonId: "lsn_1" });
    expect(full?.tokens.filter((token: { isWord: boolean }) => token.isWord)).toHaveLength(3);
    expect(await courses.readLesson(client, { userId: "u2", lessonId: "lsn_1" })).toBeNull();
    expect(await courses.listLessons(client, { userId: "u2", lang: "de" })).toEqual([]);
    // Someone else can't take over a course by its id.
    expect(await courses.saveCourse(client, { userId: "u2", course: { id: "crs_1", lang: "de", title: "Mine now", kind: "user" } })).toBeNull();

    const refreshed = tokenizeLesson("Erster Teil, jetzt neu.", "de");
    await courses.replaceLessonText(client, { userId: "u1", lessonId: "lsn_1", title: "Teil 1", body: "Erster Teil, jetzt neu.", tokens: refreshed.tokens, norms: refreshed.norms, wordCount: refreshed.wordCount, uniqueWordCount: refreshed.uniqueWordCount, sourceHash: "h2" });
    expect(await courses.readLesson(client, { userId: "u1", lessonId: "lsn_1" })).toMatchObject({ title: "Teil 1", sourceHash: "h2", wordCount: 4 });
    expect(await courses.deleteLesson(client, { userId: "u1", lessonId: "lsn_2" })).toBe(true);
    expect(await courses.deleteLesson(client, { userId: "u2", lessonId: "lsn_1" })).toBe(false);
  });

  test("progress resumes where the learner was, and a finished lesson stays finished when read again", async () => {
    const { client } = await database();
    await courses.saveProgress(client, { userId: "u1", lessonId: "de-ms-01-a", lang: "de", percent: 40, lastTokenIndex: 52, seconds: 30, at: "2026-11-17T10:00:00Z" });
    expect((await courses.readProgress(client, { userId: "u1", lang: "de" }))[0]).toMatchObject({ status: "in_progress", percent: 40, lastTokenIndex: 52, readCount: 0, seconds: 30 });
    const done = await courses.saveProgress(client, { userId: "u1", lessonId: "de-ms-01-a", lang: "de", complete: true, seconds: 60, at: "2026-11-17T10:05:00Z" });
    expect(done).toMatchObject({ status: "completed", percent: 100, lastTokenIndex: 0, readCount: 1, seconds: 90, completedAt: "2026-11-17T10:05:00.000Z" });
    const reread = await courses.saveProgress(client, { userId: "u1", lessonId: "de-ms-01-a", lang: "de", percent: 10, lastTokenIndex: 8, at: "2026-11-18T09:00:00Z" });
    expect(reread).toMatchObject({ status: "completed", percent: 100, lastTokenIndex: 8, readCount: 1, openedAt: "2026-11-18T09:00:00.000Z" });
    await courses.saveProgress(client, { userId: "u1", lessonId: "de-ms-02-a", lang: "de", percent: 5, lastTokenIndex: 3, at: "2026-11-18T10:00:00Z" });
    expect((await courses.readProgress(client, { userId: "u1", lang: "de" })).map((row) => row.lessonId)).toEqual(["de-ms-02-a", "de-ms-01-a"]);
    expect((await courses.readProgress(client, { userId: "u1", lang: "de", lessonIds: ["de-ms-01-a"] })).map((row) => row.lessonId)).toEqual(["de-ms-01-a"]);
    expect(await courses.readProgress(client, { userId: "u2", lang: "de" })).toEqual([]);

    await courses.enroll(client, { userId: "u1", courseId: "de-mini-stories", lang: "de" });
    await courses.enroll(client, { userId: "u1", courseId: "de-mini-stories", lang: "de", lastLessonId: "de-ms-02-a" });
    expect(await courses.readEnrollments(client, { userId: "u1", lang: "de" })).toMatchObject([{ courseId: "de-mini-stories", lastLessonId: "de-ms-02-a" }]);
  });

  test("study events add up per day in the learner's time zone, and the word counts come from the word list", async () => {
    const { client } = await database();
    await courses.addLearningEvents(client, { userId: "u1", events: [
      { lang: "de", type: "words_read", count: 120, at: "2026-11-16T23:30:00Z" },
      { lang: "de", type: "words_known", count: 14, at: "2026-11-17T08:00:00Z" },
      { lang: "de", type: "words_read", count: 80, at: "2026-11-17T09:00:00Z" },
      { lang: "de", type: "made_up", count: 3 },
      { lang: "de", type: "words_read", count: 0 },
    ] });
    expect(await courses.readDailyStats(client, { userId: "u1", lang: "de", since: "2026-11-01T00:00:00Z", offsetMinutes: 0 })).toMatchObject([
      { day: "2026-11-16", words_read: 120 }, { day: "2026-11-17", words_read: 80, words_known: 14 },
    ]);
    // In Berlin (UTC+1) the late reading falls on the 17th.
    expect(await courses.readDailyStats(client, { userId: "u1", lang: "de", since: "2026-11-01T00:00:00Z", offsetMinutes: 60 })).toMatchObject([{ day: "2026-11-17", words_read: 200 }]);

    const now = "2026-11-17T10:00:00.000Z";
    await languageTermRepository.saveLanguageTerms(client, { userId: "u1", terms: [
      { language: "de", key: "katze", meaning: "", source: "", status: 5, tags: [], docIds: [], createdAt: now, updatedAt: now },
      { language: "de", key: "hund", meaning: "dog", source: "user", status: 2, tags: [], docIds: [], createdAt: now, updatedAt: now, srs: { state: "review", due: Date.parse("2026-11-01T00:00:00Z"), stability: 3, difficulty: 5, reps: 2, lapses: 0, lastReview: Date.parse("2026-10-29T00:00:00Z") } },
      { language: "de", key: "gute nacht", meaning: "", source: "", status: 5, tags: [], docIds: [], createdAt: now, updatedAt: now },
      { language: "es", key: "gato", meaning: "", source: "", status: 5, tags: [], docIds: [], createdAt: now, updatedAt: now },
    ] });
    expect(await courses.readWordCounts(client, { userId: "u1", lang: "de" })).toEqual({ known: 1, learning: 1, due: 1 });
    const exported = await courses.exportLanguageCourses(client, { userId: "u1" });
    expect(exported.events).toHaveLength(3);
  });
});

describe("a word's sentence and review schedule travel with it", () => {
  const memory = () => { const data = new Map<string, string>(); return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } }; };

  test("a device keeps the sentence a meaning was saved from; an empty one doesn't wipe it", () => {
    const store = new LanguageTermStore("u1", memory());
    store.set("de", "Katze", { meaning: "cat", fragment: "Lena hat eine Katze." }, "2026-11-17T10:00:00.000Z");
    store.set("de", "katze", { status: 3, fragment: "" }, "2026-11-17T10:00:01.000Z");
    expect(store.get("de", "katze")).toMatchObject({ status: 3, fragment: "Lena hat eine Katze." });
    const schedule = { state: "review" as const, due: 1, stability: 2, difficulty: 5, reps: 1, lapses: 0, lastReview: 0 };
    store.set("de", "katze", { srs: schedule }, "2026-11-17T10:00:02.000Z");
    expect(store.get("de", "katze")?.srs).toEqual(schedule);
    expect(store.set("de", "katze", { srs: { ...schedule } }, "2026-11-17T10:00:03.000Z")?.updatedAt).toBe("2026-11-17T10:00:02.000Z");
  });

  test("the account keeps them, and an older device that sends neither leaves them as they were", async () => {
    const { client } = await database();
    const service = createLanguageTermService({ database: {
      saveLanguageTerms: (args: any) => languageTermRepository.saveLanguageTerms(client, args),
      readLanguageTerms: (args: any) => languageTermRepository.readLanguageTerms(client, args),
    } });
    const term = { language: "de", key: "katze", meaning: "cat", status: 2, tags: [], docIds: [], createdAt: "2026-11-17T10:00:00Z" };
    const srs = { state: "review", due: Date.parse("2026-11-20T00:00:00Z"), stability: 3.1, difficulty: 5.2, reps: 2, lapses: 0, lastReview: Date.parse("2026-11-17T10:00:00Z") };
    await service.sync({ userId: "u1", body: { terms: [{ ...term, fragment: "Lena hat eine Katze.", srs, updatedAt: "2026-11-17T10:00:01Z" }] } });
    await service.sync({ userId: "u1", body: { terms: [{ ...term, status: 3, updatedAt: "2026-11-17T10:00:02Z" }] } });
    const { terms } = await service.sync({ userId: "u1", body: { terms: [], cursor: 0 } });
    expect(terms[0]).toMatchObject({ status: 3, fragment: "Lena hat eine Katze.", srs });
    // A schedule sent as null clears it, as when the word was marked known.
    await service.sync({ userId: "u1", body: { terms: [{ ...term, status: 5, srs: null, updatedAt: "2026-11-17T10:00:03Z" }] } });
    expect((await service.sync({ userId: "u1", body: { terms: [], cursor: 0 } })).terms[0]).toMatchObject({ status: 5, srs: null });
    expect(readLanguageTerm({ ...term, srs: { state: "soon" }, updatedAt: "2026-11-17T10:00:00Z" })?.srs).toBeUndefined();
  });
});

describe("the reader's sentences line up with a lesson's", () => {
  test("a shipped lesson read in the reader has the same sentences, so each translation line meets its sentence", async () => {
    const { readerParagraphs } = await import("../client/src/lib/languageReader");
    for (const lesson of builtInMiniStories("de", germanStories).lessons) {
      const blocks = lesson.body.split("\n\n").map((content, index) => ({ id: `p${index}`, content }));
      const sentences = readerParagraphs(blocks, "de").flatMap((paragraph) => paragraph.sentences);
      const cut = tokenizeLesson(lesson.body, "de");
      expect({ id: lesson.id, sentences: sentences.length }).toEqual({ id: lesson.id, sentences: cut.sentenceCount });
      expect(sentences.flatMap((sentence) => sentence.tokens.flatMap((token) => token.key ? [token.key] : []))).toEqual(cut.tokens.filter((token) => token.isWord).map((token) => token.norm));
    }
  });
});

describe("study counted on this device until the account has it", () => {
  const memory = () => { const data = new Map<string, string>(); return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } }; };

  test("events of a kind add up within the hour, an undo takes back, and a reload keeps what's waiting", async () => {
    const { StudyQueue } = await import("../client/src/lib/languageCourses");
    const storage = memory();
    const sent: unknown[] = [];
    let status = 503;
    const fetcher = (async (_url: unknown, init?: RequestInit) => { sent.push(JSON.parse(String(init?.body))); return new Response("{}", { status }); }) as typeof fetch;
    const queue = new StudyQueue("u1", storage, fetcher, -1);
    const at = new Date("2026-11-17T10:05:00Z");
    queue.add({ lang: "de", type: "words_known", count: 12, lessonId: "de-ms-01-a" }, at);
    queue.add({ lang: "de", type: "words_known", count: 5, lessonId: "de-ms-01-a" }, new Date("2026-11-17T10:40:00Z"));
    queue.add({ lang: "de", type: "words_known", count: -5, lessonId: "de-ms-01-a" }, new Date("2026-11-17T10:41:00Z"));
    queue.add({ lang: "de", type: "words_read", count: 160 }, at);
    queue.add({ lang: "de", type: "words_read", count: -3 }, new Date("2026-11-17T12:00:00Z"));
    expect(queue.pending.map((event) => [event.type, event.count])).toEqual([["words_known", 12], ["words_read", 160]]);
    await queue.flush();
    // The account was down: nothing is lost, and a new page picks it up.
    expect(new StudyQueue("u1", storage, fetcher, -1).pending).toHaveLength(2);
    status = 200;
    await queue.flush();
    expect(queue.pending).toEqual([]);
    expect(new StudyQueue("u1", storage, fetcher, -1).pending).toEqual([]);
    expect((sent.at(-1) as { events: unknown[] }).events).toHaveLength(2);
  });

  test("a lesson's place is kept as a token index and read back as its sentence", async () => {
    const { sentenceOfTokenIndex, tokenIndexOfSentence } = await import("../client/src/lib/languageCourses");
    const { tokens } = tokenizeLesson("Das ist Lena. Sie wohnt in Berlin.\n\nLena hat eine Katze.", "de");
    const index = tokenIndexOfSentence(tokens, 2);
    expect(tokens[index].text).toBe("Lena");
    expect(sentenceOfTokenIndex(tokens, index)).toBe(2);
    expect(sentenceOfTokenIndex(tokens, 0)).toBe(0);
  });

  test("a page's words are rated together: one update and one save", () => {
    const writes: string[] = [];
    const store = new LanguageTermStore("u1", { getItem: () => null, setItem: (_key, value) => { writes.push(value); } });
    let updates = 0;
    store.subscribe(() => { updates++; });
    store.set("de", "katze", { status: 2 }, "2026-11-17T10:00:00.000Z");
    const changed = store.setMany("de", ["das", "ist", "lena", "katze"], { status: 5 }, "2026-11-17T10:00:01.000Z");
    expect(changed.map((term) => term.key)).toEqual(["das", "ist", "lena", "katze"]);
    expect([updates, writes.length]).toEqual([2, 2]);
    expect(store.setMany("de", ["das"], { status: 5 }, "2026-11-17T10:00:02.000Z")).toEqual([]);
    expect(updates).toBe(2);
  });
});

describe("progress through the account", () => {
  test("saving a place, completing with study events, and refusing ids that aren't lessons", async () => {
    const { client } = await database();
    const { createLanguageCourseService } = await import("../server/languageCourses/index.mjs");
    const bound = (name: keyof typeof courses) => (args: any) => (courses[name] as any)(client, args);
    const service = createLanguageCourseService({ database: { saveProgress: bound("saveProgress"), addLearningEvents: bound("addLearningEvents"), enroll: bound("enroll"), readProgress: bound("readProgress") } });
    await service.saveProgress({ userId: "u1", lessonId: "de-ms-01-a", body: { lang: "de", percent: 50, lastTokenIndex: 40, seconds: 45, courseId: "de-mini-stories", events: [{ lang: "de", type: "words_known", count: 9 }] } });
    const done = await service.saveProgress({ userId: "u1", lessonId: "de-ms-01-a", body: { lang: "de", complete: true, events: [{ lang: "de", type: "words_read", count: 68 }] } });
    expect(done.progress).toMatchObject({ status: "completed", readCount: 1, seconds: 45 });
    const stats = await courses.readDailyStats(client, { userId: "u1", lang: "de", since: "2026-01-01T00:00:00Z" });
    expect(stats[0]).toMatchObject({ words_known: 9, words_read: 68, lesson_completed: 1 });
    expect(await courses.readEnrollments(client, { userId: "u1", lang: "de" })).toMatchObject([{ courseId: "de-mini-stories", lastLessonId: "de-ms-01-a" }]);
    expect((await service.readProgress({ userId: "u1", lang: "de" })).progress).toHaveLength(1);
    await expect(service.saveProgress({ userId: "u1", lessonId: "../etc", body: { lang: "de" } })).rejects.toThrow("isn't here");
    await expect(service.saveProgress({ userId: "u1", lessonId: "de-ms-01-a", body: { lang: "ja" } })).rejects.toThrow("spaces");
    await expect(service.recordEvents({ userId: "u1", body: { events: Array.from({ length: 201 }, () => ({ lang: "de", type: "words_read", count: 1 })) } })).rejects.toThrow("at most");
    expect(await service.recordEvents({ userId: "u1", body: { events: [{ lang: "de", type: "words_read", count: 3, at: "2999-01-01T00:00:00Z" }] } })).toEqual({ saved: 1 });
  });

  test("the library: a profile per language, enrolment, and only the learner's own lessons", async () => {
    const { createLanguageCourseService } = await import("../server/languageCourses/index.mjs");
    const { client } = await database();
    const service = createLanguageCourseService({ database: new Proxy({}, { get: (_target, name: string) => (args: any) => (courses as any)[name](client, args) }) });
    const { profile } = await service.saveProfile({ userId: "u2", body: { lang: "de", level: "A2", nativeLang: "en", dailyGoalWords: 30 } });
    expect(profile).toMatchObject({ lang: "de", level: "A2", nativeLang: "en", dailyGoalWords: 30 });
    // A later change keeps what it doesn't send.
    expect((await service.saveProfile({ userId: "u2", body: { lang: "de", level: "B1" } })).profile).toMatchObject({ level: "B1", dailyGoalWords: 30 });
    await expect(service.saveProfile({ userId: "u2", body: { lang: "de", level: "D9" } })).rejects.toThrow("A1 to C2");
    await expect(service.saveProfile({ userId: "u2", body: { lang: "de", nativeLang: "de" } })).rejects.toThrow("different language");
    await service.enroll({ userId: "u2", courseId: "de-mini-stories", body: { lang: "de" } });
    await expect(service.enroll({ userId: "u2", courseId: "../x", body: { lang: "de" } })).rejects.toThrow("isn't here");
    const library = await service.library({ userId: "u2", lang: "de" });
    expect(library.profile).toMatchObject({ level: "B1" });
    expect(library.enrollments).toMatchObject([{ courseId: "de-mini-stories" }]);
    expect(library.lessons).toEqual([]);
    // Shipped lessons come with the app, not from the account.
    await expect(service.lesson({ userId: "u2", lessonId: "de-ms-01-a" })).rejects.toThrow("isn't here");
    expect((await service.profiles({ userId: "u2" })).profiles).toHaveLength(1);
  });

  test("lessons from a document: made once, never rewritten unasked, and a refresh keeps each lesson and the place in it", async () => {
    const { createLanguageCourseService } = await import("../server/languageCourses/index.mjs");
    const { client } = await database();
    const service = createLanguageCourseService({ database: new Proxy({}, { get: (_target, name: string) => (args: any) => (courses as any)[name](client, args) }) });
    const parts = (n: number, word = "Hund") => Array.from({ length: n }, (_, i) => ({ title: `Teil ${i + 1}`, body: `Der ${word} läuft. Er ist ${i + 1} Jahre alt.` }));
    const made = await service.createLessons({ userId: "u3", body: { lang: "de", title: "Mein Text", level: "A2", documentId: "conversation-1", sourceHash: "h1", lessons: parts(3) } });
    expect(made).toMatchObject({ created: true, course: { kind: "user", documentId: "conversation-1", title: "Mein Text" } });
    expect(made.lessons.map((lesson: any) => [lesson.pos, lesson.source, lesson.wordCount])).toEqual([[0, "document", 8], [1, "document", 8], [2, "document", 8]]);
    expect((await service.library({ userId: "u3", lang: "de" })).enrollments).toMatchObject([{ courseId: made.course.id }]);
    const [first, second, third] = made.lessons;
    await service.saveProgress({ userId: "u3", lessonId: first.id, body: { lang: "de", percent: 40, lastTokenIndex: 5 } });
    await service.saveProgress({ userId: "u3", lessonId: third.id, body: { lang: "de", percent: 10, lastTokenIndex: 1 } });

    // The document changed: asking again only says so.
    const again = await service.createLessons({ userId: "u3", body: { lang: "de", documentId: "conversation-1", sourceHash: "h2", lessons: parts(1, "Katze") } });
    expect(again).toMatchObject({ created: false, stale: true });
    expect(again.lessons.map((lesson: any) => lesson.body)).toEqual(made.lessons.map((lesson: any) => lesson.body));

    // The learner asks to refresh: lesson 1 keeps its id and place; 2 (unread) goes; 3 (read) stays.
    const refreshed = await service.createLessons({ userId: "u3", body: { lang: "de", documentId: "conversation-1", sourceHash: "h2", lessons: parts(1, "Katze"), replace: true } });
    expect(refreshed.refreshed).toBe(true);
    expect(refreshed.lessons.map((lesson: any) => lesson.id)).toEqual([first.id, third.id]);
    expect(refreshed.lessons[0]).toMatchObject({ body: expect.stringContaining("Katze"), sourceHash: "h2" });
    expect(refreshed.lessons.map((lesson: any) => lesson.id)).not.toContain(second.id);
    expect((await service.readProgress({ userId: "u3", lang: "de" })).progress.find((row: any) => row.lessonId === first.id)).toMatchObject({ lastTokenIndex: 5 });

    // A simpler version goes beside its lesson; a pasted text is a course of its own.
    const simpler = await service.createLessons({ userId: "u3", body: { lang: "de", level: "A1", simplifiedFrom: first.id, lessons: [{ title: "Teil 1 (A1)", body: "Die Katze läuft." }] } });
    expect(simpler.lessons[0]).toMatchObject({ courseId: made.course.id, pos: 3, source: "generated", simplifiedFrom: first.id, level: "A1" });
    const pasted = await service.createLessons({ userId: "u3", body: { lang: "de", title: "Zeitung", lessons: [{ title: "", body: "Heute regnet es in Berlin." }] } });
    expect(pasted).toMatchObject({ created: true, course: { title: "Zeitung", documentId: null } });
    expect(pasted.lessons[0]).toMatchObject({ source: "import", title: "Part 1" });
    expect((await service.lesson({ userId: "u3", lessonId: pasted.lessons[0].id })).lesson.tokens.length).toBeGreaterThan(5);
    expect(await service.removeLesson({ userId: "u3", lessonId: pasted.lessons[0].id })).toEqual({ deleted: true });

    await expect(service.createLessons({ userId: "u3", body: { lang: "de", lessons: [{ body: "  …  " }] } })).rejects.toThrow("no text");
    await expect(service.createLessons({ userId: "u3", body: { lang: "de", lessons: Array.from({ length: 301 }, () => ({ body: "Ja." })) } })).rejects.toThrow("at most");
    await expect(service.removeLesson({ userId: "u3", lessonId: "de-ms-01-a" })).rejects.toThrow("come with the app");
  });
});

describe("a document read as lessons", () => {
  test("headings start sections; code, tables, images and front matter aren't reading", async () => {
    const { documentSections } = await import("../client/src/lib/languageCourses");
    const sections = documentSections(["---\nlearning-language: de\n---\n# Erster Teil\n\nDas ist **gut**.", "```js\nconst x = 1;\n```", "| a | b |\n|---|---|", "![Bild](x.png)", "## Zweiter Teil\n\nNoch ein [Satz](https://x).\n\nUnd mehr."]);
    expect(sections).toEqual([{ heading: "Erster Teil", paragraphs: ["Das ist gut."] }, { heading: "Zweiter Teil", paragraphs: ["Noch ein Satz.", "Und mehr."] }]);
  });
});
