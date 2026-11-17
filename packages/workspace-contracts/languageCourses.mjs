/**
 * Language courses: lessons cut into words a learner rates, shared by the
 * server (which stores lessons) and the reader (which shows them). A word's
 * `norm` here is the same key the reader rates words by, so a word known in one
 * lesson is known in every other.
 */

/** CEFR levels, easiest first, and how the library names them. */
export const LEARNING_LEVELS = Object.freeze(["A1", "A2", "B1", "B2", "C1", "C2"]);
const LEVEL_NAMES = Object.freeze({ A1: "Beginner 1", A2: "Beginner 2", B1: "Intermediate 1", B2: "Intermediate 2", C1: "Advanced 1", C2: "Advanced 2" });

export const isLearningLevel = (value) => typeof value === "string" && LEARNING_LEVELS.includes(value);
export const levelName = (level) => LEVEL_NAMES[level] ?? level;
export const levelRank = (level) => Math.max(0, LEARNING_LEVELS.indexOf(level));

/**
 * Languages a course can be in: written with spaces between words, so the
 * word breaker finds the words learners tap. Chinese, Japanese, Thai and the
 * like need a dictionary-based segmenter first.
 */
const SPACELESS = new Set(["zh", "ja", "th", "lo", "km", "my", "bo"]);
export const isCourseLanguage = (lang) => typeof lang === "string" && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(lang) && !SPACELESS.has(lang.split("-")[0]);

/** A word as terms are keyed: lowercase, one composed form, no punctuation around it. German nouns are lowercase here too. */
export function termKey(text) {
  return String(text).normalize("NFC").toLocaleLowerCase().replace(/[^\p{L}\p{M}\p{N}'’\s-]+/gu, " ").replace(/’/gu, "'").replace(/\s+/gu, " ").trim();
}

const WORDISH = /[\p{L}\p{M}\p{N}]/u;
const hasSegmenter = () => typeof Intl !== "undefined" && "Segmenter" in Intl;

/** Text split into words and what lies between them: `{ text, key?, word? }`, where only words have a key. */
export function tokenizeWords(text, language) {
  const tokens = [];
  let word = 0;
  const push = (part, isWord) => {
    if (!part) return;
    if (isWord) tokens.push({ text: part, key: termKey(part), word: word++ });
    else if (tokens.length && tokens[tokens.length - 1].key === undefined) tokens[tokens.length - 1].text += part;
    else tokens.push({ text: part });
  };
  if (hasSegmenter()) {
    let pending = "";
    // Joined by an apostrophe or hyphen (l'eau, grand-mère) is one word to a learner; the word breaker splits some of these.
    const parts = [...new Intl.Segmenter(language, { granularity: "word" }).segment(text)];
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      // Not `isWordLike`: some engines (older Safari, Bun 1.3) say no for a word with a digit in it.
      if (WORDISH.test(part.segment)) { pending += part.segment; continue; }
      const next = parts[index + 1];
      if (pending && /^['’-]$/u.test(part.segment) && next && WORDISH.test(next.segment)) { pending += part.segment; continue; }
      push(pending, true); pending = "";
      push(part.segment, false);
    }
    push(pending, true);
    return tokens;
  }
  const pattern = /[\p{L}\p{M}\p{N}]+(?:['’-][\p{L}\p{M}\p{N}]+)*/gu;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    push(text.slice(last, match.index), false);
    push(match[0], true);
    last = match.index + match[0].length;
  }
  push(text.slice(last), false);
  return tokens;
}

/** A paragraph's sentences, each with its trailing space. */
export function splitSentences(text, language) {
  if (hasSegmenter()) return [...new Intl.Segmenter(language, { granularity: "sentence" }).segment(text)].map((part) => part.segment).filter((part) => part.trim());
  return text.match(/[^.!?。！？]+[.!?。！？]*["”»')\]]*\s*/gu)?.filter((part) => part.trim()) ?? [text];
}

/** A lesson's text as paragraphs: blank lines part them, and the lines inside one join with a space. */
export function lessonParagraphs(body) {
  return String(body ?? "").replace(/\r\n?/gu, "\n").split(/\n\s*\n/u).map((part) => part.replace(/\s+/gu, " ").trim()).filter((part) => WORDISH.test(part));
}

/**
 * A lesson's text cut into tokens: `{ i, text, norm, isWord, sentence, paragraph }`.
 * Sentences are counted through the whole lesson, the same way the reader counts them.
 */
export function tokenizeLesson(body, language) {
  const tokens = [];
  const norms = new Set();
  let sentence = 0, words = 0;
  lessonParagraphs(body).forEach((text, paragraph) => {
    for (const part of splitSentences(text, language)) {
      for (const token of tokenizeWords(part.trim(), language)) {
        const isWord = token.key !== undefined && token.key !== "";
        tokens.push({ i: tokens.length, text: token.text, norm: isWord ? token.key : "", isWord, sentence, paragraph });
        if (isWord) { words++; norms.add(token.key); }
      }
      // The space between sentences, so the tokens put back together read as the text did.
      tokens.push({ i: tokens.length, text: " ", norm: "", isWord: false, sentence, paragraph });
      sentence++;
    }
  });
  if (tokens.length && tokens[tokens.length - 1].text === " ") tokens.pop();
  return { tokens, wordCount: words, uniqueWordCount: norms.size, norms: [...norms], sentenceCount: sentence };
}

/** The distinct words of a lesson, in the order they first appear. */
export const lessonNorms = (body, language) => tokenizeLesson(body, language).norms;

/**
 * The share of a lesson's distinct words the learner has never rated, 0–100.
 * `statusOf` gives a word's status: 0 (or undefined) is new, -1 ignored, 1–4 learning, 5 known.
 */
export function percentNew(norms, statusOf) {
  if (!norms.length) return 0;
  let fresh = 0;
  for (const norm of norms) if (!statusOf(norm)) fresh++;
  return Math.round((fresh / norms.length) * 100);
}

/** How a lesson's share of new words reads at a glance: easy under 10%, a stretch over 25%. */
export const newWordsBand = (percent) => (percent < 10 ? "easy" : percent <= 25 ? "fair" : "hard");

/** The words to mark known when a page is turned or a lesson finished: only the ones still new, each once. */
export function wordsToMarkKnown(norms, statusOf) {
  const out = [];
  const seen = new Set();
  for (const norm of norms) {
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    if (!statusOf(norm)) out.push(norm);
  }
  return out;
}

/** The status a word takes when a meaning is saved for it: a new word starts being learned; any other keeps its status. */
export const statusAfterSavingMeaning = (status) => (!status ? 1 : status);

/** A review grade's effect on the word's status: Good or Easy on a word at 4 makes it known; Again sends it back to 1. */
export function statusAfterReview(status, grade) {
  if (status === 5 || status === -1) return status;
  if (grade === 1) return 1;
  if (grade >= 3 && status >= 4) return 5;
  if (grade === 4) return Math.min(5, Math.max(1, status) + 2);
  if (grade === 3) return Math.min(4, Math.max(1, status) + 1);
  return Math.max(1, status);
}

/**
 * A document's text cut into lessons: at headings when they give parts of a
 * sensible size, otherwise every ~`target` words at a paragraph's end.
 * `sections` are `{ heading, paragraphs }` in reading order.
 */
export function splitIntoLessons(sections, { target = 400, title = "Lesson" } = {}) {
  const count = (text) => (String(text).match(/[\p{L}\p{M}\p{N}]+/gu) ?? []).length;
  const parts = [];
  let current = null;
  const close = () => { if (current && current.paragraphs.length) parts.push(current); current = null; };
  for (const section of sections) {
    const words = section.paragraphs.reduce((sum, paragraph) => sum + count(paragraph), 0);
    if (!words) continue;
    // A heading starts a lesson unless the one before is still very short.
    if (section.heading && current && current.words >= target * 0.4) close();
    for (const paragraph of section.paragraphs) {
      const size = count(paragraph);
      if (!size) continue;
      if (current && current.words + size > target * 1.4 && current.words >= target * 0.5) close();
      if (!current) current = { title: section.heading || "", paragraphs: [], words: 0 };
      if (!current.title && section.heading) current.title = section.heading;
      current.paragraphs.push(paragraph);
      current.words += size;
      if (current.words >= target) close();
    }
  }
  close();
  // A last scrap of a few sentences joins the lesson before it.
  if (parts.length > 1 && parts[parts.length - 1].words < target * 0.25) {
    const last = parts.pop();
    parts[parts.length - 1].paragraphs.push(...last.paragraphs);
    parts[parts.length - 1].words += last.words;
  }
  const many = parts.length > 1;
  return parts.map((part, index) => ({
    title: part.title || (many ? `${title}, part ${index + 1}` : title),
    body: part.paragraphs.join("\n\n"),
    words: part.words,
  }));
}

/** A short, stable fingerprint of a lesson's source text, to notice when the document it came from has changed. */
export function sourceFingerprint(text) {
  let hash = 0x811c9dc5;
  const value = String(text).replace(/\s+/gu, " ").trim();
  for (let index = 0; index < value.length; index++) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return `${value.length.toString(36)}-${hash.toString(36)}`;
}

/**
 * Mini story text written as `German line | English line`, one sentence a line,
 * with a blank line between paragraphs, read into a lesson's body and its
 * sentence-by-sentence translation.
 */
export function readStoryLines(source) {
  const paragraphs = [];
  const translation = [];
  let current = [];
  for (const raw of String(source).split("\n")) {
    const line = raw.trim();
    if (!line) { if (current.length) paragraphs.push(current.join(" ")); current = []; continue; }
    const bar = line.indexOf(" | ");
    const text = (bar >= 0 ? line.slice(0, bar) : line).trim();
    current.push(text);
    translation.push(bar >= 0 ? line.slice(bar + 3).trim() : "");
  }
  if (current.length) paragraphs.push(current.join(" "));
  return { body: paragraphs.join("\n\n"), translation: translation.join("\n") };
}

/** The translation line for each sentence of a lesson, when its translation was written one sentence a line. */
export function sentenceTranslations(translation, sentenceCount) {
  const lines = String(translation ?? "").split("\n");
  return lines.length === sentenceCount ? lines : null;
}

export const MINI_STORY_VARIANTS = Object.freeze(["a", "b", "qa"]);
const VARIANT_NAMES = Object.freeze({ a: "Story", b: "Retold", qa: "Questions" });
export const variantName = (variant) => VARIANT_NAMES[variant] ?? "";

/** The id of the Mini stories course shipped with the app for a language. */
export const builtInMiniStoriesId = (lang) => `${lang}-mini-stories`;
export const isBuiltInLessonId = (id) => typeof id === "string" && /^[a-z]{2,3}-ms-\d{2,3}-(?:a|b|qa)$/u.test(id);

/**
 * The Mini stories course shipped with the app: each story's three versions in
 * order (story, retold, questions), all open at once.
 */
export function builtInMiniStories(lang, stories, { title = "Mini stories" } = {}) {
  const courseId = builtInMiniStoriesId(lang);
  const lessons = [];
  stories.forEach((story, index) => {
    const number = String(index + 1).padStart(2, "0");
    const group = `${lang}-ms-${number}`;
    for (const variant of MINI_STORY_VARIANTS) {
      const [lessonTitle, englishTitle, source] = story[variant];
      const { body, translation } = readStoryLines(source);
      const { wordCount, uniqueWordCount, norms, sentenceCount } = tokenizeLesson(body, lang);
      lessons.push({
        id: `${group}-${variant}`, courseId, lang, pos: lessons.length + 1, title: lessonTitle, titleTranslation: englishTitle,
        level: story.level, source: "builtin", body, translation, variant, storyGroup: group, storyNumber: index + 1, tags: story.topic ? [story.topic] : [],
        wordCount, uniqueWordCount, norms, sentenceCount,
      });
    }
  });
  const levels = [...new Set(stories.map((story) => story.level))].sort((a, b) => levelRank(a) - levelRank(b));
  return {
    course: {
      id: courseId, lang, title, kind: "mini_stories", builtIn: true, level: levels[0] ?? "A1", levels,
      description: "Short everyday stories, each told three ways: the story, the same story retold, and questions that walk you through it. The same words come back again and again.",
      lessonsCount: lessons.length, tags: [],
    },
    lessons,
  };
}

/** The lesson after this one in a course: the next by position. */
export function nextLessonIn(lessons, lessonId) {
  const ordered = [...lessons].sort((a, b) => a.pos - b.pos);
  const at = ordered.findIndex((lesson) => lesson.id === lessonId);
  return at >= 0 ? ordered[at + 1] ?? null : null;
}

/**
 * The story to suggest next in Mini stories: the first story whose questions
 * aren't finished and that still has new words. Nothing is ever locked.
 */
export function suggestedStory(lessons, { completed, statusOf }) {
  const groups = new Map();
  for (const lesson of [...lessons].sort((a, b) => a.pos - b.pos)) {
    if (!lesson.storyGroup) continue;
    if (!groups.has(lesson.storyGroup)) groups.set(lesson.storyGroup, []);
    groups.get(lesson.storyGroup).push(lesson);
  }
  for (const [group, versions] of groups) {
    const questions = versions.find((lesson) => lesson.variant === "qa");
    const done = questions && completed(questions.id);
    const words = [...new Set(versions.flatMap((lesson) => lesson.norms ?? []))];
    if (!done && percentNew(words, statusOf) >= 5) return { group, lesson: versions.find((lesson) => !completed(lesson.id)) ?? versions[0] };
  }
  return null;
}
