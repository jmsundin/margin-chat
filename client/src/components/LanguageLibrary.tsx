import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  LEARNING_LEVELS, isCourseLanguage, levelName, levelRank, newWordsBand, nextLessonIn, percentNew, sentenceTranslations, suggestedStory, tokenizeLesson, variantName,
} from "@margin-chat/workspace-contracts/languageCourses";
import { LEARNING_LANGUAGES, languageName, type DocumentLanguageLearning, type LanguagePair } from "../lib/languageLearning";
import { termId, type LanguageTerm } from "../lib/languageReader";
import {
  enrollInCourse, fetchLibrary, fetchProfiles, hasShippedStories, loadShippedCourse, saveLessonProgress, saveProfile, sentenceOfTokenIndex, studyQueue, tokenIndexOfSentence,
  type Course, type CourseLesson, type LearningProfile, type LessonProgress, type LibraryData,
} from "../lib/languageCourses";
import { LanguageReader, type LessonSummary, type ReaderLesson } from "./LanguageReader";
import "./LanguageLibrary.css";

/** A document the learner reads in Language mode, offered as something to study. */
export interface StudyDocument { id: string; title: string; lang: string; words: number }

interface Props {
  userId: string;
  terms: ReadonlyMap<string, LanguageTerm>;
  /** What the reader needs to look words up and rate them, for a lesson in a language pair. */
  learningFor: (pair: LanguagePair, lessonId: string) => DocumentLanguageLearning;
  documents: ReadonlyArray<StudyDocument>;
  onOpenDocument: (id: string) => void;
  /** Extra shelves and actions later steps add (lessons from documents, new stories, review). */
  slots?: { documentAction?: (document: StudyDocument, lang: string, refresh: () => void) => ReactNode; header?: (lang: string, refresh: () => void) => ReactNode };
  onClose: () => void;
}

type View = { kind: "shelves" } | { kind: "course"; courseId: string } | { kind: "lesson"; lessonId: string; from: "shelves" | "course" };
const LAST_LANG_KEY = "margin-chat:learn-language";
const SWEET_SPOT = [5, 20] as const;

const readLastLang = () => { try { return localStorage.getItem(LAST_LANG_KEY); } catch { return null; } };
const rememberLang = (lang: string) => { try { localStorage.setItem(LAST_LANG_KEY, lang); } catch { /* Private windows forget it. */ } };
const COURSE_LANGUAGES = LEARNING_LANGUAGES.filter((language) => isCourseLanguage(language.code));

/** The language library: courses, mini stories and the learner's own lessons, measured in words known. */
export function LanguageLibrary({ userId, terms, learningFor, documents, onOpenDocument, slots, onClose }: Props) {
  const [profiles, setProfiles] = useState<LearningProfile[] | null>(null);
  const [lang, setLang] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [data, setData] = useState<LibraryData | null>(null);
  const [shipped, setShipped] = useState<{ course: Course; lessons: CourseLesson[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: "shelves" });
  const [levels, setLevels] = useState<[number, number] | null>(null);
  const [reload, setReload] = useState(0);
  const refresh = useCallback(() => setReload((value) => value + 1), []);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => { dialog.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    const controller = new AbortController();
    fetchProfiles(userId, controller.signal).then((list) => {
      setProfiles(list);
      const last = readLastLang();
      setLang((current) => current ?? (list.find((profile) => profile.lang === last) ?? list[0])?.lang ?? null);
    }, (failure: unknown) => { if (!controller.signal.aborted) { setProfiles([]); setError(failure instanceof Error ? failure.message : "Your languages couldn't be loaded."); } });
    return () => controller.abort();
  }, [userId]);

  useEffect(() => {
    if (!lang) return undefined;
    const controller = new AbortController();
    fetchLibrary(userId, lang, controller.signal).then((library) => { setData(library); setError(null); },
      (failure: unknown) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Your lessons couldn't be loaded."); });
    return () => controller.abort();
  }, [userId, lang, reload]);
  useEffect(() => {
    let cancelled = false;
    setShipped(null);
    if (lang) void loadShippedCourse(lang).then((course) => { if (!cancelled) setShipped(course); });
    return () => { cancelled = true; };
  }, [lang]);

  const profile = data?.profile ?? profiles?.find((item) => item.lang === lang) ?? null;
  useEffect(() => {
    if (!profile) return;
    const at = levelRank(profile.level);
    setLevels([at, Math.min(LEARNING_LEVELS.length - 1, at + 1)]);
  }, [profile?.lang, profile?.level]);

  const statusOf = useCallback((norm: string) => (lang ? terms.get(termId(lang, norm))?.status : undefined), [terms, lang]);
  const allCourses = useMemo(() => [...(shipped ? [shipped.course] : []), ...(data?.courses ?? [])], [shipped, data]);
  const allLessons = useMemo(() => [...(shipped?.lessons ?? []), ...(data?.lessons ?? [])], [shipped, data]);
  const progressOf = useMemo(() => new Map((data?.progress ?? []).map((row) => [row.lessonId, row] as const)), [data]);
  const lessonsOf = useCallback((courseId: string) => allLessons.filter((lesson) => lesson.courseId === courseId).sort((a, b) => a.pos - b.pos), [allLessons]);
  const inRange = useCallback((level: string) => !levels || (levelRank(level) >= levels[0] && levelRank(level) <= levels[1]), [levels]);

  async function choose(next: { lang: string; level: string; nativeLang: string }) {
    try {
      const saved = await saveProfile(userId, next);
      setProfiles((list) => [...(list ?? []).filter((item) => item.lang !== saved.lang), saved]);
      setLang(saved.lang); rememberLang(saved.lang); setAdding(false); setData(null); setView({ kind: "shelves" }); refresh();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Your language couldn't be saved."); }
  }
  function switchLang(next: string) {
    if (next === "+") { setAdding(true); return; }
    setLang(next); rememberLang(next); setData(null); setView({ kind: "shelves" });
  }
  async function changeLevel(level: string) {
    if (!profile) return;
    const saved = await saveProfile(userId, { lang: profile.lang, level }).catch(() => null);
    if (saved) { setProfiles((list) => (list ?? []).map((item) => item.lang === saved.lang ? saved : item)); refresh(); }
  }

  // ----- reading a lesson -----
  const open = view.kind === "lesson" ? allLessons.find((lesson) => lesson.id === view.lessonId) ?? null : null;
  const openLesson = (lessonId: string) => setView((current) => ({ kind: "lesson", lessonId, from: current.kind === "course" ? "course" : "shelves" }));
  const lastCourse = useRef<string | null>(null);
  if (view.kind === "course") lastCourse.current = view.courseId;

  const header = <header className="language-library-head">
    {view.kind !== "shelves" ? <button type="button" className="language-library-back" onClick={() => setView(view.kind === "lesson" && view.from === "course" && lastCourse.current ? { kind: "course", courseId: lastCourse.current } : { kind: "shelves" })}>
      ‹ {view.kind === "lesson" && view.from === "course" ? "Course" : "Library"}</button> : <strong className="language-library-name">Languages</strong>}
    {profiles?.length && lang && view.kind === "shelves" ? <select className="language-library-lang" aria-label="Language" value={lang} onChange={(event) => switchLang(event.target.value)}>
      {profiles.map((item) => <option key={item.lang} value={item.lang}>{languageName(item.lang)}</option>)}
      <option value="+">Add a language…</option>
    </select> : null}
    {view.kind === "lesson" && open ? <span className="language-library-crumb">{open.title}</span> : null}
    <span className="language-library-spacer" />
    {lang && profile ? <KnownCount lang={lang} terms={terms} goal={profile.dailyGoalWords} /> : null}
    <button type="button" className="language-library-close" aria-label="Close the library" onClick={onClose}>×</button>
  </header>;

  let body: ReactNode;
  if (profiles === null) body = <p className="language-library-quiet" role="status">Loading your languages…</p>;
  else if (!profiles.length || adding) body = <Onboarding taken={profiles.map((item) => item.lang)} error={error} onChoose={(choice) => void choose(choice)} onCancel={profiles.length ? () => setAdding(false) : undefined} />;
  else if (!lang || !profile) body = <p className="language-library-quiet" role="status">Loading…</p>;
  else if (view.kind === "lesson" && open) {
    const course = allCourses.find((item) => item.id === open.courseId) ?? null;
    const siblings = course ? lessonsOf(course.id) : [open];
    const next = nextLessonIn(siblings, open.id);
    body = <LessonView key={open.id} userId={userId} lesson={open} course={course} progress={progressOf.get(open.id) ?? null} pair={{ target: lang, base: profile.nativeLang }}
      learning={learningFor({ target: lang, base: profile.nativeLang }, open.id)}
      next={next ? { title: `${next.title}${next.variant ? ` · ${variantName(next.variant)}` : ""}`, open: () => openLesson(next.id) } : null}
      onSaved={refresh} onClose={() => setView({ kind: "shelves" })} />;
  } else if (view.kind === "course") {
    const course = allCourses.find((item) => item.id === view.courseId);
    body = course ? <CoursePage course={course} lessons={lessonsOf(course.id)} progressOf={progressOf} statusOf={statusOf}
      enrolled={Boolean(data?.enrollments.some((item) => item.courseId === course.id))}
      onEnroll={() => void enrollInCourse(userId, course.id, lang).then(refresh, () => setError("The course couldn't be added. Try again."))} onOpen={openLesson} />
      : <p className="language-library-quiet">That course isn't here any more.</p>;
  } else {
    body = <Shelves lang={lang} profile={profile} data={data} shipped={shipped} allLessons={allLessons} allCourses={allCourses} levels={levels} inRange={inRange} statusOf={statusOf}
      progressOf={progressOf} lessonsOf={lessonsOf} documents={documents.filter((document) => document.lang === lang)} error={error}
      onLevels={setLevels} onLevel={(level) => void changeLevel(level)} onOpenLesson={openLesson} onOpenCourse={(courseId) => setView({ kind: "course", courseId })}
      onOpenDocument={(id) => { onOpenDocument(id); onClose(); }} documentAction={slots?.documentAction ? (document) => slots.documentAction!(document, lang, refresh) : undefined}
      extra={slots?.header?.(lang, refresh)} />;
  }

  return <div className="language-library" role="dialog" aria-modal="true" aria-label="Language library" tabIndex={-1} ref={dialog} data-view={view.kind}
    onKeyDown={(event) => { if (event.key === "Escape" && view.kind === "shelves" && !(event.target as HTMLElement).closest("input, textarea, select")) { event.preventDefault(); onClose(); } }}>
    {header}
    <div className="language-library-body">{body}</div>
  </div>;
}

/** Words known in the language, and how many became known today against the daily goal. */
function KnownCount({ lang, terms, goal }: { lang: string; terms: ReadonlyMap<string, LanguageTerm>; goal: number }) {
  const { known, today } = useMemo(() => {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const since = start.toISOString();
    let knownCount = 0, todayCount = 0;
    for (const term of terms.values()) {
      if (term.language !== lang || term.status !== 5 || term.key.includes(" ")) continue;
      knownCount++;
      if (term.updatedAt >= since) todayCount++;
    }
    return { known: knownCount, today: todayCount };
  }, [lang, terms]);
  return <span className="language-library-known" title="Words you know in this language">
    <b>{known.toLocaleString()}</b> known
    {goal ? <span className="language-library-goal" title={`${today} of today's ${goal} new known words`}>
      <span className="language-library-track"><i style={{ width: `${Math.min(100, (today / goal) * 100)}%` }} /></span>
      <small>{today}/{goal} today</small></span> : null}
  </span>;
}

function Onboarding({ taken, error, onChoose, onCancel }: { taken: string[]; error: string | null; onChoose: (choice: { lang: string; level: string; nativeLang: string }) => void; onCancel?: () => void }) {
  const choices = COURSE_LANGUAGES.filter((language) => !taken.includes(language.code));
  const [lang, setLang] = useState(choices.find((language) => hasShippedStories(language.code))?.code ?? choices[0]?.code ?? "de");
  const [level, setLevel] = useState("A1");
  const [nativeLang, setNativeLang] = useState(lang === "en" ? "de" : "en");
  return <form className="language-library-onboarding" onSubmit={(event) => { event.preventDefault(); onChoose({ lang, level, nativeLang: nativeLang === lang ? (lang === "en" ? "de" : "en") : nativeLang }); }}>
    <h2>What would you like to learn?</h2>
    <p className="language-library-quiet">Read short stories and your own documents, tap the words you don't know, and watch your known words grow.</p>
    <div className="language-library-choices" role="radiogroup" aria-label="Language">
      {choices.map((language) => <button key={language.code} type="button" role="radio" aria-checked={lang === language.code} onClick={() => setLang(language.code)}>
        {language.name}{hasShippedStories(language.code) ? <small>Mini stories</small> : null}</button>)}
    </div>
    <h3>Your level</h3>
    <div className="language-library-levels" role="radiogroup" aria-label="Level">
      {LEARNING_LEVELS.map((value) => <button key={value} type="button" role="radio" aria-checked={level === value} onClick={() => setLevel(value)}>
        <b>{levelName(value)}</b><small>{value}</small></button>)}
    </div>
    <label className="language-library-native">Meanings in <select value={nativeLang} onChange={(event) => setNativeLang(event.target.value)}>
      {LEARNING_LANGUAGES.filter((language) => language.code !== lang).map((language) => <option key={language.code} value={language.code}>{language.name}</option>)}
    </select></label>
    {error ? <p className="language-library-error" role="alert">{error}</p> : null}
    <div className="language-library-actions">
      <button type="submit" className="is-primary">Start learning {languageName(lang)}</button>
      {onCancel ? <button type="button" onClick={onCancel}>Cancel</button> : null}
    </div>
  </form>;
}

type StatusOf = (norm: string) => number | undefined;

function Shelves({ lang, profile, data, shipped, allLessons, allCourses, levels, inRange, statusOf, progressOf, lessonsOf, documents, error, onLevels, onLevel, onOpenLesson, onOpenCourse, onOpenDocument, documentAction, extra }: {
  lang: string; profile: LearningProfile; data: LibraryData | null; shipped: { course: Course; lessons: CourseLesson[] } | null; allLessons: CourseLesson[]; allCourses: Course[];
  levels: [number, number] | null; inRange: (level: string) => boolean; statusOf: StatusOf; progressOf: Map<string, LessonProgress>; lessonsOf: (courseId: string) => CourseLesson[];
  documents: ReadonlyArray<StudyDocument>; error: string | null; onLevels: (levels: [number, number]) => void; onLevel: (level: string) => void;
  onOpenLesson: (id: string) => void; onOpenCourse: (id: string) => void; onOpenDocument: (id: string) => void; documentAction?: (document: StudyDocument) => ReactNode; extra?: ReactNode;
}) {
  const byId = useMemo(() => new Map(allLessons.map((lesson) => [lesson.id, lesson] as const)), [allLessons]);
  const completed = useCallback((id: string) => progressOf.get(id)?.status === "completed", [progressOf]);
  const card = (lesson: CourseLesson) => <LessonCard key={lesson.id} lesson={lesson} course={allCourses.find((course) => course.id === lesson.courseId) ?? null}
    progress={progressOf.get(lesson.id) ?? null} statusOf={statusOf} onOpen={() => onOpenLesson(lesson.id)} />;

  // Continue studying: lessons started and not finished, newest first, then the next lesson of each course taken.
  const started = (data?.progress ?? []).filter((row) => row.status === "in_progress").map((row) => byId.get(row.lessonId)).filter((lesson): lesson is CourseLesson => Boolean(lesson));
  const nextOfCourses = (data?.enrollments ?? []).flatMap((enrollment) => {
    const lessons = lessonsOf(enrollment.courseId);
    const next = lessons.find((lesson) => !completed(lesson.id));
    return next && !started.includes(next) ? [next] : [];
  });
  const continuing = [...started, ...nextOfCourses].slice(0, 12);

  const stories = shipped ? shipped.lessons.filter((lesson) => inRange(lesson.level)) : [];
  const suggestion = shipped ? suggestedStory(stories, { completed, statusOf }) : null;
  const storyStart = suggestion ? Math.max(0, stories.findIndex((lesson) => lesson.storyGroup === suggestion.group)) : 0;
  const storyShelf = [...stories.slice(storyStart), ...stories.slice(0, storyStart)].slice(0, 15);

  const courses = allCourses.filter((course) => course.kind !== "mini_stories" ? inRange(course.level) || course.kind === "user" : true);
  const forYou = allLessons.filter((lesson) => inRange(lesson.level) && !completed(lesson.id) && !continuing.includes(lesson)).filter((lesson) => {
    const share = percentNew(lesson.norms, statusOf);
    return share >= SWEET_SPOT[0] && share <= SWEET_SPOT[1];
  }).slice(0, 12);

  return <div className="language-library-shelves">
    <div className="language-library-filter">
      <LevelRange levels={levels} onChange={onLevels} />
      <label className="language-library-mylevel">Your level <select value={profile.level} onChange={(event) => onLevel(event.target.value)}>
        {LEARNING_LEVELS.map((value) => <option key={value} value={value}>{levelName(value)} ({value})</option>)}</select></label>
      {extra}
    </div>
    {error ? <p className="language-library-error" role="alert">{error}</p> : null}
    {!data && !error ? <p className="language-library-quiet" role="status">Loading your lessons…</p> : null}

    {continuing.length ? <Shelf title="Continue studying">{continuing.map(card)}</Shelf> : null}
    {shipped ? <Shelf title="Mini stories" action={<button type="button" className="language-library-link" onClick={() => onOpenCourse(shipped.course.id)}>View all</button>}
      empty="No mini stories at these levels yet. Widen the level range.">{storyShelf.map(card)}</Shelf> : null}
    <Shelf title="Courses" empty="No courses at these levels yet.">{courses.map((course) => <CourseCard key={course.id} course={course} lessons={lessonsOf(course.id)} statusOf={statusOf}
      enrolled={Boolean(data?.enrollments.some((item) => item.courseId === course.id))} onOpen={() => onOpenCourse(course.id)} />)}</Shelf>
    <Shelf title="From your documents" empty={`Documents you read in ${languageName(lang)} show up here. Open one and pick Language in its mode button.`}>
      {documents.map((document) => <div key={document.id} className="language-library-card is-document">
        <button type="button" className="language-library-card-main" onClick={() => onOpenDocument(document.id)}>
          <span className="language-library-card-title">{document.title}</span>
          <span className="language-library-card-meta">{document.words.toLocaleString()} words</span>
        </button>
        {documentAction?.(document)}
      </div>)}
    </Shelf>
    {forYou.length ? <Shelf title="For you" hint={`Lessons where ${SWEET_SPOT[0]}–${SWEET_SPOT[1]}% of the words are new to you: enough to learn from, not so many that it's a struggle.`}>{forYou.map(card)}</Shelf> : null}
  </div>;
}

function Shelf({ title, hint, action, empty, children }: { title: string; hint?: string; action?: ReactNode; empty?: string; children: ReactNode }) {
  const has = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return <section className="language-library-shelf" aria-label={title}>
    <header><h2>{title}</h2>{action}</header>
    {hint ? <p className="language-library-quiet">{hint}</p> : null}
    {has ? <div className="language-library-row">{children}</div> : empty ? <p className="language-library-quiet">{empty}</p> : null}
  </section>;
}

/** Two ends of a range of levels; every shelf shows only what falls inside. */
function LevelRange({ levels, onChange }: { levels: [number, number] | null; onChange: (levels: [number, number]) => void }) {
  const [low, high] = levels ?? [0, LEARNING_LEVELS.length - 1];
  return <div className="language-library-range" role="group" aria-label="Levels shown">
    <span>Levels</span>
    <select aria-label="Easiest level shown" value={low} onChange={(event) => { const value = Number(event.target.value); onChange([value, Math.max(value, high)]); }}>
      {LEARNING_LEVELS.map((value, index) => <option key={value} value={index}>{levelName(value)}</option>)}</select>
    <span aria-hidden="true">→</span>
    <select aria-label="Hardest level shown" value={high} onChange={(event) => { const value = Number(event.target.value); onChange([Math.min(low, value), value]); }}>
      {LEARNING_LEVELS.map((value, index) => <option key={value} value={index}>{levelName(value)}</option>)}</select>
  </div>;
}

/** A lesson's share of new words, coloured: easy under 10%, a stretch over 25%. */
function NewWords({ lesson, statusOf }: { lesson: CourseLesson; statusOf: StatusOf }) {
  const share = percentNew(lesson.norms, statusOf);
  const fresh = Math.round((share / 100) * lesson.norms.length);
  return <span className="language-library-new" data-band={newWordsBand(share)} title={`${fresh} of its ${lesson.norms.length} different words are new to you`}>{share}% new words</span>;
}

function LessonCard({ lesson, course, progress, statusOf, onOpen }: { lesson: CourseLesson; course: Course | null; progress: LessonProgress | null; statusOf: StatusOf; onOpen: () => void }) {
  const percent = progress?.status === "completed" ? 100 : progress?.percent ?? 0;
  return <button type="button" className="language-library-card" onClick={onOpen} data-done={progress?.status === "completed" || undefined}>
    <span className="language-library-cover" data-variant={lesson.variant ?? undefined} aria-hidden="true">
      {lesson.storyNumber ? <b>{lesson.storyNumber}</b> : null}{lesson.variant ? <small>{variantName(lesson.variant)}</small> : null}</span>
    <span className="language-library-card-title">{lesson.title}</span>
    <span className="language-library-card-meta">{course?.title ?? "Your lessons"} · {levelName(lesson.level)}</span>
    <NewWords lesson={lesson} statusOf={statusOf} />
    <span className="language-library-card-meta">{lesson.wordCount} words{progress?.status === "completed" ? " · done" : ""}</span>
    <span className="language-library-bar" role="progressbar" aria-label="Read" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><i style={{ width: `${percent}%` }} /></span>
  </button>;
}

function CourseCard({ course, lessons, statusOf, enrolled, onOpen }: { course: Course; lessons: CourseLesson[]; statusOf: StatusOf; enrolled: boolean; onOpen: () => void }) {
  const words = useMemo(() => [...new Set(lessons.flatMap((lesson) => lesson.norms))], [lessons]);
  const share = percentNew(words, statusOf);
  return <button type="button" className="language-library-card is-course" onClick={onOpen}>
    <span className="language-library-card-title">{course.title}</span>
    <span className="language-library-card-meta">{course.kind === "mini_stories" ? "Mini stories" : course.kind === "user" ? "Your course" : "Course"} · {(course.levels ?? [course.level]).map(levelName).join(", ")}</span>
    <span className="language-library-card-meta">{lessons.length} lesson{lessons.length === 1 ? "" : "s"}{enrolled ? " · taking" : ""}</span>
    <span className="language-library-new" data-band={newWordsBand(share)}>{share}% new words</span>
  </button>;
}

function CoursePage({ course, lessons, progressOf, statusOf, enrolled, onEnroll, onOpen }: {
  course: Course; lessons: CourseLesson[]; progressOf: Map<string, LessonProgress>; statusOf: StatusOf; enrolled: boolean; onEnroll: () => void; onOpen: (id: string) => void;
}) {
  // Mini stories come in threes: the story, the same story retold, and questions.
  const groups = useMemo(() => {
    const list: Array<{ key: string; lessons: CourseLesson[] }> = [];
    for (const lesson of lessons) {
      const key = lesson.storyGroup ?? lesson.id;
      const last = list.at(-1);
      if (last && last.key === key) last.lessons.push(lesson); else list.push({ key, lessons: [lesson] });
    }
    return list;
  }, [lessons]);
  return <div className="language-library-course">
    <header>
      <h2>{course.title}</h2>
      <p className="language-library-card-meta">{(course.levels ?? [course.level]).map(levelName).join(", ")} · {lessons.length} lessons</p>
      {course.description ? <p>{course.description}</p> : null}
      {enrolled ? <span className="language-library-pill">You're taking this course</span>
        : <button type="button" className="is-primary" onClick={onEnroll}>Take this course</button>}
    </header>
    <ol className="language-library-lessons">
      {groups.map((group) => <li key={group.key}>
        {group.lessons.length > 1 || group.lessons[0].storyGroup ? <h3>{group.lessons[0].storyNumber ? `${group.lessons[0].storyNumber}. ` : ""}{group.lessons[0].title}{group.lessons[0].titleTranslation ? <small>{group.lessons[0].titleTranslation}</small> : null}</h3> : null}
        <div className="language-library-versions">
          {group.lessons.map((lesson) => {
            const progress = progressOf.get(lesson.id);
            return <button key={lesson.id} type="button" onClick={() => onOpen(lesson.id)} data-done={progress?.status === "completed" || undefined}>
              <span>{lesson.variant ? variantName(lesson.variant) : lesson.title}</span>
              <NewWords lesson={lesson} statusOf={statusOf} />
              <small>{lesson.wordCount} words{progress?.status === "completed" ? " · done ✓" : progress ? ` · ${progress.percent}%` : ""}</small>
            </button>;
          })}
        </div>
      </li>)}
    </ol>
  </div>;
}

/** One lesson in the reader, keeping its place in the account as the learner goes. */
function LessonView({ userId, lesson, course, progress, pair, learning, next, onSaved, onClose }: {
  userId: string; lesson: CourseLesson; course: Course | null; progress: LessonProgress | null; pair: LanguagePair; learning: DocumentLanguageLearning;
  next: ReaderLesson["next"]; onSaved: () => void; onClose: () => void;
}) {
  const blocks = useMemo(() => lesson.body.split(/\n\s*\n/u).map((content, index) => ({ id: `${lesson.id}:${index}`, content })), [lesson.id, lesson.body]);
  const cut = useMemo(() => tokenizeLesson(lesson.body, lesson.lang), [lesson.body, lesson.lang]);
  const translations = useMemo(() => sentenceTranslations(lesson.translation, cut.sentenceCount), [lesson.translation, cut.sentenceCount]);
  const resume = progress && progress.status !== "completed" && progress.lastTokenIndex ? sentenceOfTokenIndex(cut.tokens, progress.lastTokenIndex) : undefined;
  const [round, setRound] = useState(0);
  const reader = useMemo<ReaderLesson>(() => ({
    id: lesson.id, translations, resumeSentence: round ? undefined : resume,
    onPlace: ({ sentence, percent, seconds }) => { void saveLessonProgress(userId, lesson.id, { lang: lesson.lang, percent, lastTokenIndex: tokenIndexOfSentence(cut.tokens, sentence), seconds, courseId: lesson.courseId ?? undefined }).catch(() => undefined); },
    onComplete: (summary: LessonSummary) => {
      // The study counted so far goes up first, so the day's totals include this lesson.
      void studyQueue(userId).flush().finally(() => saveLessonProgress(userId, lesson.id, { lang: lesson.lang, percent: 100, lastTokenIndex: 0, seconds: summary.seconds, courseId: lesson.courseId ?? undefined, complete: true })
        .then(onSaved, () => undefined));
    },
    next, onReadAgain: () => setRound((value) => value + 1), onClose,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [lesson.id, translations, round, next?.title]);
  return <div className="language-library-lesson panel-slot">
    <div className="language-library-lesson-head">
      <p className="language-library-card-meta">{course?.title ?? "Your lessons"}{lesson.variant ? ` · ${variantName(lesson.variant)}` : ""} · {levelName(lesson.level)}</p>
      <h2 lang={lesson.lang}>{lesson.title}</h2>
      {lesson.titleTranslation ? <p className="language-library-quiet">{lesson.titleTranslation}</p> : null}
    </div>
    <div className="language-library-reader">
      <LanguageReader key={round} blocks={blocks} pair={pair} learning={learning} lesson={reader} />
    </div>
  </div>;
}
