import { describe, expect, test } from "bun:test";
import { applyFlashcardEdit, flashcardDraftFor, formatFlashcard } from "../client/src/lib/flashcardEdit";
import { parseFlashcards } from "../client/src/lib/flashcards";
import { FlashcardStore } from "../client/src/lib/flashcardStore";
import { renameInSession, startSession } from "../client/src/lib/flashcardSession";

const blocks = (...contents: string[]) => contents.map((content, index) => ({ id: `b${index}`, content }));
const idOf = (markdown: string, front: string) => parseFlashcards("doc", markdown).find((card) => card.front === front)!.id;
const text = (result: ReturnType<typeof applyFlashcardEdit>) => {
  if ("error" in result) throw new Error(result.error);
  return result.blocks.map((block) => block.content);
};

describe("editing a card in its document", () => {
  test("opens with the card as it was written, both ways from its first side", () => {
    const doc = blocks("Capital of France ::: Paris");
    const reverse = parseFlashcards("doc", doc[0].content).find((card) => card.kind === "reverse")!;
    expect(flashcardDraftFor("doc", doc, reverse.id)).toEqual({ kind: "pair", front: "Capital of France", back: "Paris", both: true });
    const cloze = parseFlashcards("doc", "- The {{c1::heart}} pumps {{c2::blood}}")[1];
    expect(flashcardDraftFor("doc", blocks("- The {{c1::heart}} pumps {{c2::blood}}"), cloze.id)).toEqual({ kind: "cloze", text: "The {{c1::heart}} pumps {{c2::blood}}" });
  });

  test("writes the plainest form that reads back as the same card", () => {
    expect(formatFlashcard({ kind: "pair", front: "Q", back: "A", both: false })).toBe("Q :: A");
    expect(formatFlashcard({ kind: "pair", front: "Name it\n![[x.png]]", back: "**Heart**", both: true })).toBe("Name it\n![[x.png]]\n??\n**Heart**");
    expect(formatFlashcard({ kind: "pair", front: "First\n\nSecond", back: "```js\nlet a = b :: c;\n```", both: false }))
      .toBe(":::card\nFirst\n\nSecond\n?\n```js\nlet a = b :: c;\n```\n:::");
    expect(formatFlashcard({ kind: "cloze", text: "A {{c1::b}}\n\nmore" })).toBe(":::card\nA {{c1::b}}\n\nmore\n:::");
    // A front that already holds the marker can't go on one line.
    expect(formatFlashcard({ kind: "pair", front: "a :: b", back: "c", both: false })).toBe("a :: b\n?\nc");
  });

  test("changes only the card's own text, keeping the bullet and its neighbours", () => {
    const doc = blocks("# Biology", "- What makes ATP? :: Mitochondria\n- Capital of France :: Paris");
    const id = idOf(doc[1].content, "What makes ATP?");
    const result = applyFlashcardEdit("doc", doc, id, { kind: "pair", front: "What makes **ATP**?", back: "The mitochondria", both: false });
    expect(text(result)).toEqual(["# Biology", "- What makes **ATP**? :: The mitochondria\n- Capital of France :: Paris"]);
  });

  test("a card that grows paragraphs becomes its own card block between its neighbours", () => {
    const doc = blocks("- One :: 1\n- Two :: 2\n- Three :: 3");
    const id = idOf(doc[0].content, "Two");
    const result = applyFlashcardEdit("doc", doc, id, { kind: "pair", front: "Two", back: "The number\n\n![[two.png]]", both: false });
    expect(text(result)).toEqual(["- One :: 1\n\n:::card\nTwo\n?\nThe number\n\n![[two.png]]\n:::\n\n- Three :: 3"]);
    if ("error" in result) return;
    expect(result.cards.map((card) => card.front)).toEqual(["One", "Two", "Three"]);
    expect(result.renamed.get(id)).toBe(id); // the front didn't change, so neither did the id
    // And it edits again from the block.
    const again = applyFlashcardEdit("doc", result.blocks, id, { kind: "pair", front: "Two", back: "2", both: false });
    expect(text(again)).toEqual(["- One :: 1\n\nTwo :: 2\n\n- Three :: 3"]);
  });

  test("a card block written across blocks is rewritten as one block", () => {
    const doc = blocks("Intro", ":::card\nFront", "more front\n?\nBack\n:::", "After");
    const id = parseFlashcards("doc", doc.map((block) => block.content).join("\n\n"))[0].id;
    expect(flashcardDraftFor("doc", doc, id)).toEqual({ kind: "pair", front: "Front\n\nmore front", back: "Back", both: false });
    expect(text(applyFlashcardEdit("doc", doc, id, { kind: "pair", front: "New front", back: "Back", both: false }))).toEqual(["Intro", "New front :: Back", "After"]);
  });

  test("links each edited card to the one it replaces, and drops a direction taken away", () => {
    const doc = blocks("Capital of France ::: Paris");
    const [basic, reverse] = parseFlashcards("doc", doc[0].content);
    const result = applyFlashcardEdit("doc", doc, reverse.id, { kind: "pair", front: "France's capital city", back: "Paris", both: false });
    if ("error" in result) throw new Error(result.error);
    expect(result.renamed.size).toBe(1);
    const newId = result.renamed.get(basic.id)!;
    expect(result.links.get(newId)).toBe(basic.id);
  });

  test("refuses an edit that isn't a card, and a card that is gone", () => {
    const doc = blocks("Q :: A");
    const id = parseFlashcards("doc", "Q :: A")[0].id;
    expect(applyFlashcardEdit("doc", doc, id, { kind: "pair", front: "Q", back: " ", both: false })).toEqual({ error: "Write a back." });
    expect(applyFlashcardEdit("doc", doc, id, { kind: "cloze", text: "no blanks" })).toEqual({ error: "Hide at least one part with {{c1::…}}." });
    expect("error" in applyFlashcardEdit("doc", blocks("Other :: card"), id, { kind: "pair", front: "Q", back: "B", both: false })).toBe(true);
  });

  test("review history follows a card however much its text changed", async () => {
    const store = new FlashcardStore("edit-test", { memoryOnly: true });
    const doc = blocks("Q :: A");
    const [card] = parseFlashcards("doc", "Q :: A");
    store.syncDocument("doc", "Doc", [card]);
    await store.addReview({ id: "r1", cardId: card.id, rating: 3, reviewedAt: new Date().toISOString() });
    const result = applyFlashcardEdit("doc", doc, card.id, { kind: "pair", front: "Something entirely different", back: "Unrelated words", both: false });
    if ("error" in result) throw new Error(result.error);
    store.syncDocument("doc", "Doc", result.cards, undefined, result.links);
    const edited = store.getSnapshot().cards.get(result.renamed.get(card.id)!)!;
    expect(edited.historyFrom).toEqual([card.id]);
    expect(store.reviewsFor(edited).map((review) => review.id)).toEqual(["r1"]);
    expect(store.getSnapshot().cards.get(card.id)?.removed).toBe(true);
  });

  test("the card on screen keeps its place after its id changes", () => {
    const session = startSession(["a", "b"], Date.now());
    expect(renameInSession(session, new Map([["a", "a2"]]))).toMatchObject({ current: "a2", order: ["a2", "b"] });
  });
});
