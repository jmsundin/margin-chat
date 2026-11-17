import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  LEARNING_LEVELS, isCourseLanguage, sourceFingerprint, splitIntoLessons, levelName, levelRank, newWordsBand, nextLessonIn, percentNew, sentenceTranslations, suggestedStory, tokenizeLesson, variantName,
} from "@margin-chat/workspace-contracts/languageCourses";
import { LEARNING_LANGUAGES, languageName, type DocumentLanguageLearning, type LanguagePair } from "../lib/languageLearning";
import { termId, type LanguageTerm } from "../lib/languageReader";
import {
  createLessons, documentSections, dueWords, enrollInCourse, fetchLibrary, fetchProfiles, hasShippedStories, loadShippedCourse, saveLessonProgress, saveProfile, sentenceOfTokenIndex, studyQueue, tokenIndexOfSentence,
  type Course, type CourseLesson, type LearningProfile, type LessonProgress, type LibraryData,
} from "../lib/languageCourses";
import { LanguageReader, type LessonSummary, type ReaderLesson } from "./LanguageReader";
import { StudyStatsView, Vocabulary, WordReview } from "./LanguageStudy";
import "./LanguageLibrary.css";

/** A document the learner reads in Language mode, offered as something to study. */
export interface StudyDocument { id: string; title: string; lang: string; words: number; text: () => ReadonlyArray<string> }

/** A document's text cut into lessons at its headings, or every ~400 words, and a fingerprint of it to notice changes. */
export function documentLessons(document: StudyDocument) {
  const contents = document.text();
  return { lessons: splitIntoLessons(documentSections(contents), { title: document.title }).map(({ title, body }) => ({ title, body })), sourceHash: sourceFingerprint(contents.join("\n\n")) };
}

interface Props {
  userId: string;
  terms: ReadonlyMap<string, LanguageTerm>;
  /** Rates a word or gives it a meaning or a review schedule. */
  setTerm: (language: string, text: string, patch: import("../lib/languageTerms").TermPatch) => void;
  /** What the reader needs to look words up and rate them, for a lesson in a language pair. */
  learningFor: (pair: LanguagePair, lessonId: string) => DocumentLanguageLearning;
  documents: ReadonlyArray<StudyDocument>;
  onOpenDocument: (id: string) => void;
  /** Opens with this document's lessons, making them first if need be ("Study this"). */
  study?: { documentId: string; nonce: number } | null;
  /** Asks the AI for text (simplifying a lesson); missing when AI isn't available. */
  writeWithAI?: (prompt: string, signal: AbortSignal) => Promise<string>;
  /** A web page's readable text, for a lesson from a link. */
  readPage?: (url: string, signal: AbortSignal) => Promise<{ title: string; text: string }>;
  /** Extra shelves and actions later steps add (lessons from documents, new stories, review). */
  slots?: { documentAction?: (document: StudyDocument, lang: string, refresh: () => void) => ReactNode; header?: (lang: string, refresh: () => void) => ReactNode };
  onClose: () => void;
}

type View = { kind: "shelves" } | { kind: "course"; courseId: string } | { kind: "lesson"; lessonId: string; from: "shelves" | "course" }
  | { kind: "vocabulary" } | { kind: "review" } | { kind: "stats" };
const LAST_LANG_KEY = "margin-chat:learn-language";
const SWEET_SPOT = [5, 20] as const;

const readLastLang = () => { try { return localStorage.getItem(LAST_LANG_KEY); } catch { return null; } };
const rememberLang = (lang: string) => { try { localStorage.setItem(LAST_LANG_KEY, lang); } catch { /* Private windows forget it. */ } };
const COURSE_LANGUAGES = LEARNING_LANGUAGES.filter((language) => isCourseLanguage(language.code));

/** The language library: courses, mini stories and the learner's own lessons, measured in words known. */
export function LanguageLibrary({ userId, terms, setTerm, learningFor, documents, onOpenDocument, study, writeWithAI, readPage, slots, onClose }: Props) {
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

  // ----- lessons from the learner's documents and texts -----
  const [making, setMaking] = useState<string | null>(null);
  const [adding2, setAddingLesson] = useState(false);
  const [writing, setWriting] = useState(false);
  async function studyDocument(document: StudyDocument, replace = false) {
    if (making) return;
    const { lessons, sourceHash } = documentLessons(document);
    if (!lessons.length) { setError("That document has no text to read yet."); return; }
    setMaking(document.id); setError(null);
    try {
      const made = await createLessons(userId, { lang: document.lang, title: document.title, level: profile?.level, documentId: document.id, sourceHash, lessons, replace });
      refresh();
      if (made.course) setView({ kind: "course", courseId: made.course.id });
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Those lessons couldn't be made."); }
    finally { setMaking(null); }
  }
  const studied = useRef(0);
  useEffect(() => {
    if (!study || studied.current === study.nonce || !data || !profile) return;
    const document = documents.find((item) => item.id === study.documentId);
    if (!document || document.lang !== lang) return;
    studied.current = study.nonce;
    void studyDocument(document);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [study?.nonce, data, profile?.lang, lang]);
  // "Study this" for a document in another language switches the library to it.
  useEffect(() => {
    const wanted = study ? documents.find((item) => item.id === study.documentId)?.lang : null;
    if (wanted && wanted !== lang && profiles?.some((item) => item.lang === wanted)) switchLang(wanted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [study?.nonce, profiles]);

  // ----- reading a lesson -----
  const open = view.kind === "lesson" ? allLessons.find((lesson) => lesson.id === view.lessonId) ?? null : null;
  const openLesson = (lessonId: string) => setView((current) => ({ kind: "lesson", lessonId, from: current.kind === "course" ? "course" : "shelves" }));
  const lastCourse = useRef<string | null>(null);
  if (view.kind === "course") lastCourse.current = view.courseId;

  const tabbed = view.kind === "shelves" || view.kind === "vocabulary" || view.kind === "stats";
  const due = useMemo(() => (lang ? dueWords(terms.values(), lang).length : 0), [terms, lang]);
  const header = <header className="language-library-head">
    {view.kind === "course" || view.kind === "lesson" || view.kind === "review" ? <button type="button" className="language-library-back"
      onClick={() => setView(view.kind === "review" ? { kind: "vocabulary" } : view.kind === "lesson" && view.from === "course" && lastCourse.current ? { kind: "course", courseId: lastCourse.current } : { kind: "shelves" })}>
      ‹ {view.kind === "review" ? "Vocabulary" : view.kind === "lesson" && view.from === "course" ? "Course" : "Library"}</button> : <strong className="language-library-name">Languages</strong>}
    {profiles?.length && lang && tabbed ? <select className="language-library-lang" aria-label="Language" value={lang} onChange={(event) => switchLang(event.target.value)}>
      {profiles.map((item) => <option key={item.lang} value={item.lang}>{languageName(item.lang)}</option>)}
      <option value="+">Add a language…</option>
    </select> : null}
    {lang && profile && tabbed ? <nav className="language-library-tabs" aria-label="Library">
      <button type="button" aria-current={view.kind === "shelves" ? "page" : undefined} onClick={() => setView({ kind: "shelves" })}>Lessons</button>
      <button type="button" aria-current={view.kind === "vocabulary" ? "page" : undefined} onClick={() => setView({ kind: "vocabulary" })}>Words{due ? <small title={`${due} to review`}>{due}</small> : null}</button>
      <button type="button" aria-current={view.kind === "stats" ? "page" : undefined} onClick={() => setView({ kind: "stats" })}>Stats</button>
    </nav> : null}
    {view.kind === "lesson" && open ? <span className="language-library-crumb">{open.title}</span> : null}
    <span className="language-library-spacer" />
    {lang && profile ? <KnownCount lang={lang} terms={terms} goal={profile.dailyGoalWords} /> : null}
    <button type="button" className="language-library-close" aria-label="Close the library" onClick={onClose}>×</button>
  </header>;

  let body: ReactNode;
  if (profiles === null) body = <p className="language-library-quiet" role="status">Loading your languages…</p>;
  else if (!profiles.length || adding) body = <Onboarding taken={profiles.map((item) => item.lang)} preferred={study ? documents.find((item) => item.id === study.documentId)?.lang : null} error={error} onChoose={(choice) => void choose(choice)} onCancel={profiles.length ? () => setAdding(false) : undefined} />;
  else if (!lang || !profile) body = <p className="language-library-quiet" role="status">Loading…</p>;
  else if (view.kind === "vocabulary") body = <Vocabulary lang={lang} terms={terms} setTerm={setTerm} onReview={() => setView({ kind: "review" })} />;
  else if (view.kind === "review") body = <WordReview lang={lang} terms={terms} setTerm={setTerm}
    onReviewed={() => studyQueue(userId).add({ lang, type: "reviewed", count: 1 })} onDone={() => setView({ kind: "vocabulary" })} />;
  else if (view.kind === "stats") body = <StudyStatsView userId={userId} lang={lang} terms={terms} />;
  else if (view.kind === "lesson" && open) {
    const course = allCourses.find((item) => item.id === open.courseId) ?? null;
    const siblings = course ? lessonsOf(course.id) : [open];
    const following = nextLessonIn(siblings, open.id);
    // Done with the last story there is: the next one can be written.
    const next = following ? { title: `${following.title}${following.variant ? ` · ${variantName(following.variant)}` : ""}`, open: () => openLesson(following.id) }
      : open.variant && writeWithAI ? { title: "Write a new story", open: () => { setView({ kind: "shelves" }); setWriting(true); } } : null;
    body = <LessonView key={open.id} userId={userId} lesson={open} course={course} progress={progressOf.get(open.id) ?? null} pair={{ target: lang, base: profile.nativeLang }}
      learning={learningFor({ target: lang, base: profile.nativeLang }, open.id)} level={profile.level} writeWithAI={writeWithAI}
      onSimplified={(lessonId) => { refresh(); setView({ kind: "lesson", lessonId, from: view.from }); }}
      next={next}
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
      onOpenDocument={(id) => { onOpenDocument(id); onClose(); }}
      documentAction={(document) => <DocumentStudy document={document} course={data?.courses.find((course) => course.documentId === document.id) ?? null}
        lessons={data?.lessons ?? []} busy={making === document.id} onStudy={(replace) => void studyDocument(document, replace)}
        onOpenCourse={(courseId) => setView({ kind: "course", courseId })} extra={slots?.documentAction?.(document, lang, refresh)} />}
      extra={<>{<button type="button" className="language-library-add" onClick={() => setAddingLesson(true)}>Add a lesson…</button>}{slots?.header?.(lang, refresh)}</>}
      onWriteStory={writeWithAI ? () => setWriting(true) : undefined} />;
    if (writing && writeWithAI) body = <>{body}<WriteStory lang={lang} base={profile.nativeLang} level={profile.level} userId={userId} write={writeWithAI} terms={terms}
      onDone={(made) => { setWriting(false); refresh(); const first = made?.lessons.find((lesson) => lesson.variant === "a"); if (first) setView({ kind: "lesson", lessonId: first.id, from: "shelves" }); }} /></>;
    if (adding2) body = <>{body}<AddLesson lang={lang} level={profile.level} userId={userId} readPage={readPage}
      onDone={(made) => { setAddingLesson(false); refresh(); if (made?.course) setView({ kind: "course", courseId: made.course.id }); }} /></>;
  }

  return <div className="language-library" role="dialog" aria-modal="true" aria-label="Language library" tabIndex={-1} ref={dialog} data-view={view.kind}
    onKeyDown={(event) => { if (event.key === "Escape" && tabbed && !(event.target as HTMLElement).closest("input, textarea, select")) { event.preventDefault(); onClose(); } }}>
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

function Onboarding({ taken, preferred, error, onChoose, onCancel }: { taken: string[]; preferred?: string | null; error: string | null; onChoose: (choice: { lang: string; level: string; nativeLang: string }) => void; onCancel?: () => void }) {
  const choices = COURSE_LANGUAGES.filter((language) => !taken.includes(language.code));
  // "Study this" on a Spanish page starts on Spanish, not on the first language with mini stories.
  const [lang, setLang] = useState(choices.find((language) => language.code === preferred)?.code ?? choices.find((language) => hasShippedStories(language.code))?.code ?? choices[0]?.code ?? "de");
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

function Shelves({ lang, profile, data, shipped, allLessons, allCourses, levels, inRange, statusOf, progressOf, lessonsOf, documents, error, onLevels, onLevel, onOpenLesson, onOpenCourse, onOpenDocument, documentAction, extra, onWriteStory }: {
  lang: string; profile: LearningProfile; data: LibraryData | null; shipped: { course: Course; lessons: CourseLesson[] } | null; allLessons: CourseLesson[]; allCourses: Course[];
  levels: [number, number] | null; inRange: (level: string) => boolean; statusOf: StatusOf; progressOf: Map<string, LessonProgress>; lessonsOf: (courseId: string) => CourseLesson[];
  documents: ReadonlyArray<StudyDocument>; error: string | null; onLevels: (levels: [number, number]) => void; onLevel: (level: string) => void;
  onOpenLesson: (id: string) => void; onOpenCourse: (id: string) => void; onOpenDocument: (id: string) => void; documentAction?: (document: StudyDocument) => ReactNode; extra?: ReactNode;
  onWriteStory?: () => void;
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

  // The learner's own stories first, newest first, then the ones that come with the app.
  const ownStoryCourse = allCourses.find((course) => course.kind === "user" && course.tags.includes("mini-stories")) ?? null;
  const ownStories = ownStoryCourse ? lessonsOf(ownStoryCourse.id).filter((lesson) => !completed(lesson.id)).reverse() : [];
  const stories = shipped ? shipped.lessons.filter((lesson) => inRange(lesson.level)) : [];
  const suggestion = shipped ? suggestedStory(stories, { completed, statusOf }) : null;
  const storyStart = suggestion ? Math.max(0, stories.findIndex((lesson) => lesson.storyGroup === suggestion.group)) : 0;
  const storyShelf = [...ownStories.filter((lesson) => lesson.variant === "a" || progressOf.has(lesson.id)).slice(0, 6),
    ...[...stories.slice(storyStart), ...stories.slice(0, storyStart)]].slice(0, 15);

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
    {shipped || ownStoryCourse || onWriteStory ? <Shelf title="Mini stories" action={<span className="language-library-shelf-actions">
      {onWriteStory ? <button type="button" className="language-library-link" onClick={onWriteStory}>Write a new story…</button> : null}
      {shipped ?? ownStoryCourse ? <button type="button" className="language-library-link" onClick={() => onOpenCourse((shipped?.course ?? ownStoryCourse)!.id)}>View all</button> : null}
    </span>} empty={shipped ? "No mini stories at these levels yet. Widen the level range." : "Short stories the AI writes at your level, each told three ways. Write your first one."}>{storyShelf.map(card)}</Shelf> : null}
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
      <b>{lesson.storyNumber ?? lesson.pos + 1}</b><small>{lesson.variant ? variantName(lesson.variant) : lesson.simplifiedFrom ? "Simplified" : lesson.source === "document" ? "Document" : "Lesson"}</small></span>
    <span className="language-library-card-title">{lesson.title}</span>
    {/* A one-lesson course made from a document shares its title; saying it twice only crowds a small card. */}
    <span className="language-library-card-meta">{course && course.title !== lesson.title ? `${course.title} · ` : course ? "" : "Your lessons · "}{levelName(lesson.level)}</span>
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
      <p className="language-library-card-meta">{(course.levels ?? [course.level]).map(levelName).join(", ")} · {lessons.length} lesson{lessons.length === 1 ? "" : "s"}</p>
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
function LessonView({ userId, lesson, course, progress, pair, learning, level, writeWithAI, next, onSaved, onSimplified, onClose }: {
  userId: string; lesson: CourseLesson; course: Course | null; progress: LessonProgress | null; pair: LanguagePair; learning: DocumentLanguageLearning;
  level: string; writeWithAI?: (prompt: string, signal: AbortSignal) => Promise<string>;
  next: ReaderLesson["next"]; onSaved: () => void; onSimplified: (lessonId: string) => void; onClose: () => void;
}) {
  const [simplifying, setSimplifying] = useState<AbortController | null>(null);
  const [simplifyError, setSimplifyError] = useState<string | null>(null);
  useEffect(() => () => simplifying?.abort(), [simplifying]);
  // Lessons that come with the app are already written for their level; the learner's own may not be.
  const canSimplify = Boolean(writeWithAI) && lesson.source !== "builtin" && !lesson.variant && levelRank(level) < levelRank("C2");
  async function simplify() {
    if (!writeWithAI || simplifying) return;
    const controller = new AbortController();
    setSimplifying(controller); setSimplifyError(null);
    try {
      const text = await writeWithAI(simplifyPrompt(lesson, level), controller.signal);
      const body = text.replace(/^```[a-z]*\n?|```$/gu, "").trim();
      if (!tokenizeLesson(body, lesson.lang).wordCount) throw new Error("The AI didn't write a simpler version. Try again.");
      const made = await createLessons(userId, { lang: lesson.lang, title: `${lesson.title} (${levelName(level)})`, level, simplifiedFrom: lesson.id, lessons: [{ title: `${lesson.title} (${levelName(level)})`, body }] });
      if (made.lessons[0]) onSimplified(made.lessons[0].id);
    } catch (failure) {
      if (!controller.signal.aborted) setSimplifyError(failure instanceof Error ? failure.message : "The simpler version couldn't be made.");
    } finally { setSimplifying(null); }
  }
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
      {lesson.simplifiedFrom ? <p className="language-library-quiet">Simplified to {levelName(lesson.level)} by AI.</p> : null}
      {canSimplify ? <div className="language-library-simplify">
        <button type="button" onClick={() => void simplify()} disabled={Boolean(simplifying)} title={`The AI rewrites this lesson as a new one, for ${levelName(level)} (${level}). This one stays as it is.`}>
          {simplifying ? "Simplifying…" : "Simplify to my level"}</button>
        {simplifying ? <button type="button" className="language-library-link" onClick={() => simplifying.abort()}>Stop</button> : null}
        {simplifyError ? <span className="language-library-error" role="alert">{simplifyError}</span> : null}
      </div> : null}
    </div>
    <div className="language-library-reader">
      <LanguageReader key={round} blocks={blocks} pair={pair} learning={learning} lesson={reader} />
    </div>
  </div>;
}

function simplifyPrompt(lesson: CourseLesson, level: string): string {
  const language = languageName(lesson.lang);
  return [
    `Rewrite this ${language} text for a learner at CEFR level ${level} (${levelName(level)}).`,
    `Keep what happens and the order it happens in. Use short sentences and common words a ${level} learner knows; explain or leave out rare details.`,
    `Write only the rewritten text, in ${language}, with a blank line between paragraphs. No title, no notes, no translation.`,
    "",
    lesson.body,
  ].join("\n");
}

/** "Study this" on a document: makes its lessons, opens them, and offers a refresh when the document changed. */
function DocumentStudy({ document, course, lessons, busy, onStudy, onOpenCourse, extra }: {
  document: StudyDocument; course: Course | null; lessons: ReadonlyArray<CourseLesson>; busy: boolean;
  onStudy: (replace: boolean) => void; onOpenCourse: (courseId: string) => void; extra?: ReactNode;
}) {
  const stale = useMemo(() => {
    if (!course) return false;
    const own = lessons.filter((lesson) => lesson.courseId === course.id && lesson.source === "document");
    return own.length > 0 && own.some((lesson) => lesson.sourceHash !== documentLessons(document).sourceHash);
  }, [course, lessons, document]);
  return <div className="language-library-card-actions">
    {course ? <button type="button" onClick={() => onOpenCourse(course.id)}>Open lessons</button>
      : <button type="button" className="is-primary" disabled={busy} onClick={() => onStudy(false)}>{busy ? "Making lessons…" : "Study this"}</button>}
    {stale ? <button type="button" className="language-library-stale" disabled={busy} onClick={() => onStudy(true)}
      title="The document changed since its lessons were made. Refreshing keeps your place in each lesson.">{busy ? "Refreshing…" : "Source changed — refresh lessons?"}</button> : null}
    {extra}
  </div>;
}

/** A lesson from pasted text or a web page, cut at its headings or every ~400 words into a course of its own. */
function AddLesson({ lang, level, userId, readPage, onDone }: {
  lang: string; level: string; userId: string; readPage?: (url: string, signal: AbortSignal) => Promise<{ title: string; text: string }>;
  onDone: (made: import("../lib/languageCourses").MadeLessons | null) => void;
}) {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function submit() {
    setError(null);
    controller.current = new AbortController();
    try {
      let source = text, name = title.trim();
      if (!source.trim() && url.trim()) {
        if (!readPage) throw new Error("Paste the text instead.");
        setBusy("Reading the page…");
        const page = await readPage(url.trim(), controller.current.signal);
        source = page.text; name ||= page.title;
      }
      if (!source.trim()) throw new Error("Paste some text, or the address of a page.");
      name ||= source.trim().split(/\s+/u).slice(0, 6).join(" ");
      setBusy("Making lessons…");
      const lessons = splitIntoLessons(documentSections([source]), { title: name }).map(({ title: part, body }) => ({ title: part, body }));
      onDone(await createLessons(userId, { lang, title: name, level, lessons }));
    } catch (failure) {
      if (!controller.current?.signal.aborted) setError(failure instanceof Error ? failure.message : "That lesson couldn't be made.");
    } finally { setBusy(null); }
  }
  return <div className="language-library-sheet" role="dialog" aria-label="Add a lesson" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onDone(null); } }}>
    <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <h2>Add a lesson in {languageName(lang)}</h2>
      <p className="language-library-quiet">Paste a text, or the address of a page. Long texts become a course, one lesson per heading or about 400 words.</p>
      <label>Title <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Optional" maxLength={200} /></label>
      <label>Text <textarea value={text} onChange={(event) => setText(event.target.value)} rows={8} lang={lang} placeholder={`Paste ${languageName(lang)} text here`} autoFocus /></label>
      {readPage ? <label>or a web page <input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://" disabled={Boolean(text.trim())} /></label> : null}
      {error ? <p className="language-library-error" role="alert">{error}</p> : null}
      <div className="language-library-actions">
        <button type="submit" className="is-primary" disabled={Boolean(busy)}>{busy ?? "Make lesson"}</button>
        <button type="button" onClick={() => { controller.current?.abort(); onDone(null); }}>Cancel</button>
      </div>
    </form>
  </div>;
}

/** "Write a new story": the AI plans it, writes it, retells it and asks questions about it, checking each part. */
function WriteStory({ lang, base, level, userId, write, terms, onDone }: {
  lang: string; base: string; level: string; userId: string; write: (prompt: string, signal: AbortSignal) => Promise<string>;
  terms: ReadonlyMap<string, LanguageTerm>; onDone: (made: import("../lib/languageCourses").MadeLessons | null) => void;
}) {
  const [topic, setTopic] = useState("");
  const [storyLevel, setStoryLevel] = useState(level);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function submit() {
    setError(null);
    const running = new AbortController();
    controller.current = running;
    try {
      const known = [...terms.values()].filter((term) => term.language === lang && term.status >= 4 && !term.key.includes(" "))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((term) => term.key);
      const { writeMiniStory } = await import("../lib/miniStoryWriter");
      const story = await writeMiniStory({ lang, base, level: storyLevel, topic, known, ask: write, signal: running.signal, onProgress: setStep });
      setStep("Saving…");
      onDone(await createLessons(userId, { lang, title: story.title, level: storyLevel, story: true, lessons: (["a", "b", "qa"] as const).map((variant) => ({
        variant, title: variant === "qa" ? `${story.title}: ${variantName("qa")}` : story.title, body: story.parts[variant].body, translation: story.parts[variant].translation,
      })) }));
    } catch (failure) {
      if (!running.signal.aborted) setError(failure instanceof Error ? failure.message : "The story couldn't be written.");
    } finally { setStep(null); }
  }
  return <div className="language-library-sheet" role="dialog" aria-label="Write a new story" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); controller.current?.abort(); onDone(null); } }}>
    <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <h2>Write a new {languageName(lang)} story</h2>
      <p className="language-library-quiet">The AI writes a short original story at your level with 8 to 15 new words, the same story retold, and questions about it. Each part has its translation.</p>
      <label>About <input value={topic} onChange={(event) => setTopic(event.target.value)} placeholder="Anything, or leave empty for an everyday story" maxLength={300} autoFocus /></label>
      <label>Level <select value={storyLevel} onChange={(event) => setStoryLevel(event.target.value)}>
        {LEARNING_LEVELS.map((value) => <option key={value} value={value}>{levelName(value)} ({value})</option>)}</select></label>
      {step ? <p className="language-library-quiet" role="status">{step}</p> : null}
      {error ? <p className="language-library-error" role="alert">{error}</p> : null}
      <div className="language-library-actions">
        <button type="submit" className="is-primary" disabled={Boolean(step)}>{step ? "Writing…" : "Write story"}</button>
        <button type="button" onClick={() => { controller.current?.abort(); onDone(null); }}>{step ? "Stop" : "Cancel"}</button>
      </div>
    </form>
  </div>;
}
