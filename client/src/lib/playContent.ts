import type { Flashcard } from "./flashcards";
import { quizParts } from "./flashcardQuiz";

/**
 * Games load what to ask from the vault. A played page calls `marginChat.getQuestions()` and gets
 * the flashcards and quiz questions of the documents chosen for it, so a lesson is gamified by
 * writing (or having AI write) its questions in a note, never by changing the game's own code.
 * The same cards show in Review.
 */
export interface PlayQuestion {
  id: string;
  /** The question, as Markdown. */
  question: string;
  /** The answer or its explanation, as Markdown. */
  answer: string;
  /** A quiz question's choices and which one is right. */
  choices?: string[];
  correct?: number;
  /** The document the question is written in. */
  deck: string;
}

export interface PlayContent { questions: PlayQuestion[]; decks: string[] }

export const EMPTY_PLAY_CONTENT: PlayContent = { questions: [], decks: [] };
export const MAX_PLAY_QUESTIONS = 500;
const MAX_SIDE = 4_000;

/** The questions a game gets from cards: a quiz card keeps its choices, any other card is a question and its answer. */
export function playQuestions(cards: Iterable<Flashcard>, titleOf: (docId: string) => string | undefined): PlayContent {
  const questions: PlayQuestion[] = [];
  const decks = new Set<string>();
  for (const card of cards) {
    if (questions.length >= MAX_PLAY_QUESTIONS) break;
    const deck = titleOf(card.docId)?.trim() || "Untitled";
    const quiz = quizParts(card.front);
    const question = (quiz ? quiz.question : card.front).trim().slice(0, MAX_SIDE);
    const answer = card.back.trim().slice(0, MAX_SIDE);
    if (!question || (!quiz && !answer)) continue;
    decks.add(deck);
    questions.push({ id: card.id, question, answer, deck,
      ...(quiz ? { choices: quiz.choices.map((choice) => choice.slice(0, 500)), correct: quiz.answer } : {}) });
  }
  return { questions, decks: [...decks] };
}

/** Where a game's chosen documents are kept in the vault, beside what the game itself saved. */
export function playSourcesPath(pagePath: string) {
  return `.margin-chat/page-data/${pagePath.normalize("NFC")}.sources.json`;
}

export function encodePlaySources(documentIds: readonly string[]) {
  return JSON.stringify({ version: 1, sources: [...new Set(documentIds)] });
}

export function decodePlaySources(text: string | null | undefined): string[] {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as { sources?: unknown };
    return Array.isArray(parsed?.sources) ? [...new Set(parsed.sources.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 300))].slice(0, 200) : [];
  } catch { return []; }
}

/* What each open game is given; the page's frame listens and passes it on. */
const contents = new Map<string, PlayContent>();
const listeners = new Map<string, Set<() => void>>();

export function getPlayContent(documentId: string): PlayContent {
  return contents.get(documentId) ?? EMPTY_PLAY_CONTENT;
}

function same(a: PlayContent, b: PlayContent) {
  return a.questions.length === b.questions.length && a.questions.every((question, index) => {
    const other = b.questions[index];
    return question.id === other.id && question.question === other.question && question.answer === other.answer && question.deck === other.deck
      && question.correct === other.correct && (question.choices ?? []).join("\n") === (other.choices ?? []).join("\n");
  });
}

/** Whether the game's questions have been worked out yet; until then a game that asks is kept waiting, not told "none". */
export function hasPlayContent(documentId: string) {
  return contents.has(documentId);
}

export function setPlayContent(documentId: string, content: PlayContent) {
  if (contents.has(documentId) && same(getPlayContent(documentId), content)) return;
  contents.set(documentId, content);
  listeners.get(documentId)?.forEach((listener) => listener());
}

export function subscribePlayContent(documentId: string, listener: () => void) {
  const set = listeners.get(documentId) ?? new Set();
  listeners.set(documentId, set);
  set.add(listener);
  return () => { set.delete(listener); if (!set.size) listeners.delete(documentId); };
}
