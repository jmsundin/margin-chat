import { describe, expect, test } from "bun:test";
import { parseFlashcards } from "../client/src/lib/flashcards";
import { htmlFrameDocument, readHtmlFrameMessage } from "../client/src/lib/htmlDocuments";
import { decodePlaySources, encodePlaySources, getPlayContent, hasPlayContent, playQuestions, playSourcesPath, setPlayContent, subscribePlayContent } from "../client/src/lib/playContent";
import { QUIZ_RUN_HTML } from "../client/src/lib/quizRunGame";
import { validVaultPath } from "../client/src/lib/vaultTypes";

const NOTE = [
  "What does volatile guarantee? :: Visibility, not atomicity",
  "",
  "Which map is safe to share between threads?",
  "- [ ] HashMap",
  "- [x] ConcurrentHashMap",
  "- [ ] TreeMap",
  "?",
  "ConcurrentHashMap locks per bin.",
].join("\n");

describe("games load their questions from the vault", () => {
  test("a document's cards become questions; a quiz card keeps its choices and which is right", () => {
    const cards = parseFlashcards("doc-1", NOTE);
    const { questions, decks } = playQuestions(cards, (id) => id === "doc-1" ? "Java concurrency" : undefined);
    expect(decks).toEqual(["Java concurrency"]);
    const plain = questions.find((question) => question.question.startsWith("What does volatile"))!;
    expect(plain).toMatchObject({ answer: "Visibility, not atomicity", deck: "Java concurrency" });
    expect(plain.choices).toBeUndefined();
    const quiz = questions.find((question) => question.choices)!;
    expect(quiz).toMatchObject({ question: "Which map is safe to share between threads?", choices: ["HashMap", "ConcurrentHashMap", "TreeMap"], correct: 1,
      answer: "ConcurrentHashMap locks per bin." });
    expect(questions.every((question) => cards.some((card) => card.id === question.id))).toBe(true);
  });

  test("which documents a game asks from is kept in the vault beside the game's own data", () => {
    const path = playSourcesPath("Games/Quiz Run.html");
    expect(path).toBe(".margin-chat/page-data/Games/Quiz Run.html.sources.json");
    expect(validVaultPath(path)).toBe(true);
    expect(decodePlaySources(encodePlaySources(["a", "b", "a"]))).toEqual(["a", "b"]);
    for (const text of [null, "", "nope", "[]", "{\"sources\":3}"]) expect(decodePlaySources(text)).toEqual([]);
    expect(decodePlaySources("{\"sources\":[\"a\",4,\"\"]}")).toEqual(["a"]);
  });

  test("a game is told when its questions are first known and when they change, not when they are the same", () => {
    let calls = 0;
    const stop = subscribePlayContent("game-1", () => { calls += 1; });
    expect(hasPlayContent("game-1")).toBe(false);
    setPlayContent("game-1", { questions: [], decks: [] });
    expect(hasPlayContent("game-1")).toBe(true);
    expect(calls).toBe(1);
    const content = playQuestions(parseFlashcards("doc-1", NOTE), () => "Deck");
    setPlayContent("game-1", content);
    setPlayContent("game-1", playQuestions(parseFlashcards("doc-1", NOTE), () => "Deck"));
    expect(calls).toBe(2);
    expect(getPlayContent("game-1").questions.length).toBe(content.questions.length);
    stop();
    setPlayContent("game-1", { questions: [], decks: [] });
    expect(calls).toBe(2);
  });

  test("the page gets marginChat.getQuestions and onQuestions, and its request for them is recognised", () => {
    const page = htmlFrameDocument("<html><head></head><body></body></html>");
    expect(page).toContain("marginChat");
    expect(page).toContain("getQuestions");
    expect(page).toContain("onQuestions");
    expect(readHtmlFrameMessage({ marginHtml: 1, type: "content-request" })).toEqual({ marginHtml: 1, type: "content-request" });
  });

  test("Quiz Run holds no questions of its own and asks Margin Chat for them", () => {
    expect(QUIZ_RUN_HTML).toContain("window.marginChat.getQuestions()");
    expect(QUIZ_RUN_HTML).toContain("window.marginChat.onQuestions(");
    expect(QUIZ_RUN_HTML.startsWith("<!DOCTYPE html>")).toBe(true);
    // Its script parses.
    const script = /<script>([\s\S]*)<\/script>/u.exec(QUIZ_RUN_HTML)![1];
    expect(() => new Function(script)).not.toThrow();
  });
});
