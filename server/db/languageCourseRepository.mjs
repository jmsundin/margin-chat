/** Language courses: learning profiles, the learner's own courses and lessons, their progress and daily study (migration 0035). */

const iso = (value) => (value ? new Date(value).toISOString() : null);
const list = (value) => (Array.isArray(value) ? value : []);

const profileRow = (row) => ({
  lang: row.lang, nativeLang: row.native_lang, level: row.level, dailyGoalWords: Number(row.daily_goal_words),
  settings: row.settings && typeof row.settings === "object" ? row.settings : {}, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
});

const courseRow = (row) => ({
  id: row.id, lang: row.lang, title: row.title, description: row.description, level: row.level, kind: row.kind,
  documentId: row.document_id ?? null, coverUrl: row.cover_url ?? null, tags: list(row.tags),
  lessonsCount: row.lessons_count === undefined ? undefined : Number(row.lessons_count), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
});

/** A lesson as the library lists it: everything but its tokens (the reader cuts the body itself). */
const lessonRow = (row) => ({
  id: row.id, courseId: row.course_id ?? null, lang: row.lang, pos: Number(row.pos), title: row.title, level: row.level, source: row.source,
  documentId: row.document_id ?? null, sourceHash: row.source_hash ?? null, body: row.body, translation: row.translation ?? null,
  variant: row.variant ?? null, storyGroup: row.story_group ?? null, simplifiedFrom: row.simplified_from ?? null, audioUrl: row.audio_url ?? null,
  wordCount: Number(row.word_count), uniqueWordCount: Number(row.unique_word_count), norms: list(row.norms), tags: [],
  createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
});

const progressRow = (row) => ({
  lessonId: row.lesson_id, lang: row.lang, status: row.status, percent: Number(row.percent), lastTokenIndex: Number(row.last_token_index),
  readCount: Number(row.read_count), seconds: Number(row.seconds), openedAt: iso(row.opened_at), completedAt: iso(row.completed_at), updatedAt: iso(row.updated_at),
});

export async function readLearningProfiles(client, { userId }) {
  const result = await client.query(`select * from marginchat_learning_profiles where user_id = $1 order by updated_at desc`, [userId]);
  return result.rows.map(profileRow);
}

export async function saveLearningProfile(client, { userId, lang, nativeLang, level, dailyGoalWords, settings }) {
  const result = await client.query(
    `insert into marginchat_learning_profiles (user_id, lang, native_lang, level, daily_goal_words, settings)
     values ($1, $2, coalesce($3, 'en'), coalesce($4, 'A1'), coalesce($5, 20), coalesce($6::jsonb, '{}'::jsonb))
     on conflict (user_id, lang) do update set
       native_lang = coalesce($3, marginchat_learning_profiles.native_lang),
       level = coalesce($4, marginchat_learning_profiles.level),
       daily_goal_words = coalesce($5, marginchat_learning_profiles.daily_goal_words),
       settings = case when $6::jsonb is null then marginchat_learning_profiles.settings else marginchat_learning_profiles.settings || $6::jsonb end,
       updated_at = now()
     returning *`,
    [userId, lang, nativeLang ?? null, level ?? null, dailyGoalWords ?? null, settings ? JSON.stringify(settings) : null],
  );
  return profileRow(result.rows[0]);
}

export async function saveCourse(client, { userId, course }) {
  const result = await client.query(
    `insert into marginchat_courses (id, owner_user_id, lang, title, description, level, kind, document_id, cover_url, tags)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     on conflict (id) do update set title = excluded.title, description = excluded.description, level = excluded.level, tags = excluded.tags, updated_at = now()
     where marginchat_courses.owner_user_id = excluded.owner_user_id
     returning *`,
    [course.id, userId, course.lang, course.title, course.description ?? "", course.level ?? "A1", course.kind, course.documentId ?? null, course.coverUrl ?? null, JSON.stringify(course.tags ?? [])],
  );
  return result.rows[0] ? courseRow(result.rows[0]) : null;
}

/** The learner's own courses in a language, with how many lessons each has. */
export async function listCourses(client, { userId, lang }) {
  const result = await client.query(
    `select c.*, (select count(*) from marginchat_lessons l where l.course_id = c.id) as lessons_count
     from marginchat_courses c where c.owner_user_id = $1 and c.lang = $2 order by c.created_at`,
    [userId, lang],
  );
  return result.rows.map(courseRow);
}

export async function findCourseForDocument(client, { userId, documentId, lang }) {
  const result = await client.query(
    `select * from marginchat_courses where owner_user_id = $1 and document_id = $2 and lang = $3 and kind = 'user' order by created_at limit 1`,
    [userId, documentId, lang],
  );
  return result.rows[0] ? courseRow(result.rows[0]) : null;
}

/** Saves lessons the learner made; each carries its tokens, cut on the server. */
export async function saveLessons(client, { userId, lessons }) {
  if (!lessons.length) return [];
  const result = await client.query(
    `insert into marginchat_lessons (id, owner_user_id, course_id, lang, pos, title, level, source, document_id, source_hash, body, tokens, norms,
       word_count, unique_word_count, variant, story_group, simplified_from, translation, audio_url)
     select t.id, $1, t."courseId", t.lang, t.pos, t.title, t.level, t.source, t."documentId", t."sourceHash", t.body, t.tokens, t.norms,
       t."wordCount", t."uniqueWordCount", t.variant, t."storyGroup", t."simplifiedFrom", t.translation, t."audioUrl"
     from jsonb_to_recordset($2::jsonb) as t(id text, "courseId" text, lang text, pos integer, title text, level text, source text, "documentId" text,
       "sourceHash" text, body text, tokens jsonb, norms jsonb, "wordCount" integer, "uniqueWordCount" integer, variant text, "storyGroup" text,
       "simplifiedFrom" text, translation text, "audioUrl" text)
     returning *`,
    [userId, JSON.stringify(lessons)],
  );
  return result.rows.map(lessonRow);
}

/** Replaces a lesson's text, as when its source document changed and the learner asked to refresh it. */
export async function replaceLessonText(client, { userId, lessonId, title, body, tokens, norms, wordCount, uniqueWordCount, sourceHash }) {
  const result = await client.query(
    `update marginchat_lessons set title = $3, body = $4, tokens = $5::jsonb, norms = $6::jsonb, word_count = $7, unique_word_count = $8, source_hash = $9, updated_at = now()
     where owner_user_id = $1 and id = $2 returning *`,
    [userId, lessonId, title, body, JSON.stringify(tokens), JSON.stringify(norms), wordCount, uniqueWordCount, sourceHash ?? null],
  );
  return result.rows[0] ? lessonRow(result.rows[0]) : null;
}

export async function readLesson(client, { userId, lessonId }) {
  const result = await client.query(`select * from marginchat_lessons where owner_user_id = $1 and id = $2`, [userId, lessonId]);
  return result.rows[0] ? { ...lessonRow(result.rows[0]), tokens: list(result.rows[0].tokens) } : null;
}

export async function listLessons(client, { userId, lang, courseId, documentId }) {
  const values = [userId, lang];
  let where = "owner_user_id = $1 and lang = $2";
  if (courseId) { values.push(courseId); where += ` and course_id = $${values.length}`; }
  if (documentId) { values.push(documentId); where += ` and document_id = $${values.length}`; }
  const result = await client.query(
    `select id, course_id, lang, pos, title, level, source, document_id, source_hash, body, norms, word_count, unique_word_count, variant, story_group,
       simplified_from, translation, audio_url, created_at, updated_at
     from marginchat_lessons where ${where} order by course_id nulls last, pos, created_at`,
    values,
  );
  return result.rows.map(lessonRow);
}

export async function deleteLesson(client, { userId, lessonId }) {
  const result = await client.query(`delete from marginchat_lessons where owner_user_id = $1 and id = $2`, [userId, lessonId]);
  await client.query(`delete from marginchat_lesson_progress where user_id = $1 and lesson_id = $2`, [userId, lessonId]);
  return result.rowCount > 0;
}

export async function enroll(client, { userId, courseId, lang, lastLessonId }) {
  const result = await client.query(
    `insert into marginchat_course_enrollments (user_id, course_id, lang, last_lesson_id) values ($1, $2, $3, $4)
     on conflict (user_id, course_id) do update set last_lesson_id = coalesce($4, marginchat_course_enrollments.last_lesson_id)
     returning *`,
    [userId, courseId, lang, lastLessonId ?? null],
  );
  const row = result.rows[0];
  return { courseId: row.course_id, lang: row.lang, enrolledAt: iso(row.enrolled_at), lastLessonId: row.last_lesson_id ?? null };
}

export async function readEnrollments(client, { userId, lang }) {
  const result = await client.query(`select * from marginchat_course_enrollments where user_id = $1 and lang = $2 order by enrolled_at`, [userId, lang]);
  return result.rows.map((row) => ({ courseId: row.course_id, lang: row.lang, enrolledAt: iso(row.enrolled_at), lastLessonId: row.last_lesson_id ?? null }));
}

/**
 * Where the learner is in a lesson. A finished lesson stays finished, and its
 * percent never falls, when it's opened again and read from the start.
 */
export async function saveProgress(client, { userId, lessonId, lang, percent, lastTokenIndex, seconds = 0, complete = false, at }) {
  const result = await client.query(
    `insert into marginchat_lesson_progress (user_id, lesson_id, lang, status, percent, last_token_index, read_count, seconds, opened_at, completed_at, updated_at)
     values ($1, $2, $3, case when $6 then 'completed' else 'in_progress' end, case when $6 then 100 else $4 end, $5, case when $6 then 1 else 0 end, $7,
       coalesce($8::timestamptz, now()), case when $6 then coalesce($8::timestamptz, now()) end, coalesce($8::timestamptz, now()))
     on conflict (user_id, lesson_id) do update set
       status = case when $6 or marginchat_lesson_progress.status = 'completed' then 'completed' else 'in_progress' end,
       percent = greatest(marginchat_lesson_progress.percent, case when $6 then 100 else $4 end),
       last_token_index = case when $6 then 0 else $5 end,
       read_count = marginchat_lesson_progress.read_count + case when $6 then 1 else 0 end,
       seconds = marginchat_lesson_progress.seconds + $7,
       opened_at = coalesce($8::timestamptz, now()),
       completed_at = case when $6 then coalesce($8::timestamptz, now()) else marginchat_lesson_progress.completed_at end,
       updated_at = coalesce($8::timestamptz, now())
     returning *`,
    [userId, lessonId, lang, percent ?? 0, lastTokenIndex ?? 0, Boolean(complete), Math.max(0, Math.round(seconds)), at ?? null],
  );
  return progressRow(result.rows[0]);
}

export async function readProgress(client, { userId, lang, lessonIds }) {
  const values = [userId, lang];
  let where = "user_id = $1 and lang = $2";
  if (lessonIds) { values.push(lessonIds); where += ` and lesson_id = any($${values.length}::text[])`; }
  const result = await client.query(`select * from marginchat_lesson_progress where ${where} order by opened_at desc`, values);
  return result.rows.map(progressRow);
}

const EVENT_TYPES = new Set(["words_read", "words_known", "meanings_saved", "reader_seconds", "lesson_completed", "reviewed"]);

export async function addLearningEvents(client, { userId, events }) {
  const rows = events.filter((event) => EVENT_TYPES.has(event.type) && Number.isFinite(event.count) && event.count > 0);
  if (!rows.length) return 0;
  await client.query(
    `insert into marginchat_learning_events (user_id, lang, type, lesson_id, count, at)
     select $1, t.lang, t.type, t."lessonId", t.count, coalesce(t.at, now())
     from jsonb_to_recordset($2::jsonb) as t(lang text, type text, "lessonId" text, count integer, at timestamptz)`,
    [userId, JSON.stringify(rows.map((event) => ({ ...event, count: Math.round(event.count) })))],
  );
  return rows.length;
}

/** Each day's study in a language since `since`, as totals per kind of event. `zone` is the learner's time zone offset in minutes. */
export async function readDailyStats(client, { userId, lang, since, offsetMinutes = 0 }) {
  const result = await client.query(
    `select to_char(date_trunc('day', at + make_interval(mins => $4)), 'YYYY-MM-DD') as day, type, sum(count)::bigint as total
     from marginchat_learning_events where user_id = $1 and lang = $2 and at >= $3
     group by 1, 2 order by 1`,
    [userId, lang, since, Math.round(offsetMinutes)],
  );
  const days = new Map();
  for (const row of result.rows) {
    if (!days.has(row.day)) days.set(row.day, { day: row.day, words_read: 0, words_known: 0, meanings_saved: 0, reader_seconds: 0, lesson_completed: 0, reviewed: 0 });
    days.get(row.day)[row.type] = Number(row.total);
  }
  return [...days.values()];
}

/** How many words the learner knows in a language, and how many they're learning. */
export async function readWordCounts(client, { userId, lang }) {
  const result = await client.query(
    `select count(*) filter (where status = 5 and position(' ' in term_key) = 0)::int as known,
            count(*) filter (where status between 1 and 4)::int as learning,
            count(*) filter (where srs_due_at is not null and srs_due_at <= now() and status between 1 and 4)::int as due
     from marginchat_language_terms where user_id = $1 and language = $2`,
    [userId, lang],
  );
  return { known: Number(result.rows[0]?.known ?? 0), learning: Number(result.rows[0]?.learning ?? 0), due: Number(result.rows[0]?.due ?? 0) };
}

/** Everything one account has stored about its language courses, for its data export. */
export async function exportLanguageCourses(client, { userId }) {
  const [profiles, courses, lessons, enrollments, progress, events] = await Promise.all([
    client.query(`select * from marginchat_learning_profiles where user_id = $1`, [userId]),
    client.query(`select * from marginchat_courses where owner_user_id = $1`, [userId]),
    client.query(`select id, course_id, lang, pos, title, level, source, document_id, body, translation, variant, story_group, simplified_from, created_at from marginchat_lessons where owner_user_id = $1`, [userId]),
    client.query(`select * from marginchat_course_enrollments where user_id = $1`, [userId]),
    client.query(`select * from marginchat_lesson_progress where user_id = $1`, [userId]),
    client.query(`select lang, type, lesson_id, count, at from marginchat_learning_events where user_id = $1 order by at`, [userId]),
  ]);
  return {
    profiles: profiles.rows.map(profileRow), courses: courses.rows.map(courseRow),
    lessons: lessons.rows.map((row) => ({ ...lessonRow({ ...row, norms: [], word_count: 0, unique_word_count: 0 }), norms: undefined, wordCount: undefined, uniqueWordCount: undefined })),
    enrollments: enrollments.rows.map((row) => ({ courseId: row.course_id, lang: row.lang, enrolledAt: iso(row.enrolled_at), lastLessonId: row.last_lesson_id ?? null })),
    progress: progress.rows.map(progressRow),
    events: events.rows.map((row) => ({ lang: row.lang, type: row.type, lessonId: row.lesson_id ?? null, count: Number(row.count), at: iso(row.at) })),
  };
}
