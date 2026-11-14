/**
 * Multiple-choice cards. A card whose front ends in a task list with one ticked
 * item is a quiz: the lines above the list are the question, the items are the
 * choices and the ticked one is right. The back explains the answer.
 *
 *   Which map is safe to share between threads?
 *   - [ ] HashMap
 *   - [x] ConcurrentHashMap
 *   - [ ] TreeMap
 *   ?
 *   HashMap isn't thread-safe; ConcurrentHashMap locks per bin.
 *
 * It is stored as an ordinary card (its front holds the list as written), so
 * editing, syncing and history work as they do for any card.
 */

export interface QuizCard {
  question: string;
  choices: string[];
  answer: number;
}

const CHOICE = /^\s{0,3}[-*+]\s+\[([ xX])\]\s+(\S.*)$/u;

/** The question, choices and answer of a card's front, or null when it isn't a quiz. */
export function quizParts(front: string): QuizCard | null {
  const lines = front.replace(/\s+$/u, "").split("\n");
  let start = lines.length;
  while (start > 0 && CHOICE.test(lines[start - 1])) start -= 1;
  const items = lines.slice(start).map((line) => CHOICE.exec(line)!);
  if (items.length < 2 || items.length > 8) return null;
  const ticked = items.flatMap((item, index) => (item[1] === " " ? [] : [index]));
  const question = lines.slice(0, start).join("\n").trim();
  if (ticked.length !== 1 || !question) return null;
  return { question, choices: items.map((item) => item[2].trim()), answer: ticked[0] };
}

const LETTERS = "ABCDEFGH";
export const choiceLetter = (index: number) => LETTERS[index] ?? String(index + 1);

/** A quiz as plain question-and-answer sides, for places that only show two sides (Anki). */
export function quizAsSides(front: string, back: string): { front: string; back: string } | null {
  const quiz = quizParts(front);
  if (!quiz) return null;
  const choices = quiz.choices.map((choice, index) => `${choiceLetter(index)}. ${choice}`).join("\n\n");
  const answer = `**${choiceLetter(quiz.answer)}. ${quiz.choices[quiz.answer]}**`;
  return { front: `${quiz.question}\n\n${choices}`, back: back.trim() ? `${answer}\n\n${back}` : answer };
}
