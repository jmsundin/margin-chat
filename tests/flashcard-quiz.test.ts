import { describe, expect, test } from "bun:test";
import { parseFlashcards } from "../client/src/lib/flashcards";
import { quizAsSides, quizParts } from "../client/src/lib/flashcardQuiz";
import { applyFlashcardEdit, formatFlashcard } from "../client/src/lib/flashcardEdit";
import { parseFlashcardReply } from "../client/src/lib/flashcardAI";

const QUIZ = "Which map is thread-safe?\n- [ ] HashMap\n- [x] ConcurrentHashMap\n- [ ] TreeMap";

describe("quiz cards", () => {
  test("a front ending in a list with one ticked choice is a quiz", () => {
    expect(quizParts(QUIZ)).toEqual({ question: "Which map is thread-safe?", choices: ["HashMap", "ConcurrentHashMap", "TreeMap"], answer: 1 });
    expect(quizParts("Q?\n- [x] a\n- [x] b")).toBeNull();
    expect(quizParts("- [ ] a\n- [x] b")).toBeNull();
    expect(quizParts("Q?\n- [x] only one")).toBeNull();
  });

  test("written with ? it is a card, with or without an explanation", () => {
    const [explained] = parseFlashcards("d", `${QUIZ}\n?\nIt locks per bin.`);
    expect(explained.kind).toBe("basic");
    expect(quizParts(explained.front)?.answer).toBe(1);
    expect(explained.back).toBe("It locks per bin.");
    const [bare] = parseFlashcards("d", `${QUIZ}\n?`);
    expect(bare.back).toBe("");
    const [block] = parseFlashcards("d", `:::card\n${QUIZ}\n:::`);
    expect(quizParts(block.front)).not.toBeNull();
  });

  test("a to-do list is never a quiz", () => {
    expect(parseFlashcards("d", "Today\n- [x] buy milk\n- [ ] call mom")).toEqual([]);
  });

  test("editing keeps a quiz without an explanation", () => {
    expect(formatFlashcard({ kind: "pair", front: QUIZ, back: "", both: false })).toBe(`${QUIZ}\n?`);
    const blocks = [{ id: "b", content: `Intro\n\n${QUIZ}\n?\nWhy.` }];
    const [card] = parseFlashcards("d", blocks[0].content);
    const edited = applyFlashcardEdit("d", blocks, card.id, { kind: "pair", front: QUIZ.replace("TreeMap", "LinkedHashMap"), back: "", both: false });
    expect("blocks" in edited && edited.blocks[0].content).toBe(`Intro\n\n${QUIZ.replace("TreeMap", "LinkedHashMap")}\n?`);
  });

  test("Anki gets the choices lettered and the answer on the back", () => {
    expect(quizAsSides(QUIZ, "Why.")).toEqual({ front: "Which map is thread-safe?\n\nA. HashMap\n\nB. ConcurrentHashMap\n\nC. TreeMap", back: "**B. ConcurrentHashMap**\n\nWhy." });
  });

  test("AI replies keep a quiz's ticks", () => {
    const drafts = parseFlashcardReply(`1. ${QUIZ.replace(/\n/gu, "\n  ")}\n  ?\n  It locks per bin.\n\nHeart :: Pumps blood`, "d");
    expect(drafts).toHaveLength(2);
    expect(quizParts(drafts[0].cards[0].front)?.choices).toHaveLength(3);
  });
});

describe("quiz questions in their own paragraph", () => {
  test("a question paragraph above the choices is one quiz", () => {
    const markdown = `Intro words.\n\nWhich map is thread-safe?\n\n- [ ] HashMap\n- [x] ConcurrentHashMap\n?\nWhy.`;
    const cards = parseFlashcards("d", markdown);
    expect(cards).toHaveLength(1);
    expect(quizParts(cards[0].front)?.question).toBe("Which map is thread-safe?");
    const edited = applyFlashcardEdit("d", [{ id: "b", content: markdown }], cards[0].id, { kind: "pair", front: QUIZ, back: "Why.", both: false });
    expect("blocks" in edited && edited.blocks[0].content).toBe(`Intro words.\n\n${QUIZ}\n?\nWhy.`);
  });
});
