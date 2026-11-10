import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import initSqlJs from "sql.js";
import { ankiHtmlToMarkdown, buildAnkiPackage, planAnkiImport, readAnkiPackage, type ExportCard } from "../client/src/lib/ankiPackage";
import { parseFlashcards } from "../client/src/lib/flashcards";
import { scheduleFromReviews } from "../client/src/lib/flashcardSchedule";

const SQL = await initSqlJs();
const fixture = async (name: string) => new Uint8Array(await readFile(new URL(`./fixtures/anki/${name}`, import.meta.url)));
let ids = 0;
const createId = () => `doc-${++ids}`;
const embed = (name: string) => `![[Attachments/${name}]]`;

describe("reading Anki decks", () => {
  // Both files were exported by Anki itself (the `anki` Python package): three notes in
  // Biology::Cells, one card answered three times, the reversed Peru card suspended, one image.
  for (const file of ["anki-current-format.apkg", "anki-2.1-format.apkg"]) {
    test(`imports notes, decks, media, suspensions and review history from ${file}`, async () => {
      const collection = readAnkiPackage(await fixture(file), SQL);
      expect([...collection.media.keys()]).toEqual(["heart.png"]);
      expect(collection.media.get("heart.png")![1]).toBe(0x50); // PNG signature
      const plan = planAnkiImport(collection, { embed, createId });
      expect(plan.documents).toHaveLength(1);
      const [doc] = plan.documents;
      expect(doc.title).toBe("Biology › Cells");
      expect(doc.markdown).toBe([
        "What makes most of the cell's **ATP**?",
        "?",
        "The mitochondria",
        "![[Attachments/heart.png]]",
        "",
        "Capital of Peru ::: Lima",
        "",
        "The {{c1::heart}} pumps blood through the {{c2::aorta::vessel}}.",
        "",
        "Cardiology",
        "",
      ].join("\n"));
      // The document's own reading gives the same cards the history was moved onto.
      expect(parseFlashcards(doc.id, doc.markdown).map((card) => card.id)).toEqual(doc.cards.map((card) => card.id));
      expect(doc.cards.map((card) => card.kind)).toEqual(["basic", "basic", "reverse", "cloze", "cloze"]);
      expect(plan.reviews).toHaveLength(3);
      expect(new Set(plan.reviews.map((review) => review.cardId)).size).toBeGreaterThanOrEqual(1);
      expect(plan.reviews.every((review) => doc.cards.some((card) => card.id === review.cardId))).toBe(true);
      expect(plan.suspended).toEqual([doc.cards.find((card) => card.kind === "reverse")!.id]);
      expect(plan.skippedNotes).toBe(0);
    });
  }

  test("field HTML becomes Markdown", () => {
    expect(ankiHtmlToMarkdown("<div>One&nbsp;<i>two</i></div><div>three &amp; <span style=\"x\">four</span></div>[sound:a.mp3]", embed))
      .toBe("One *two*\nthree & four\n![[Attachments/a.mp3]]");
  });

  test("a file that isn't a deck says so", () => {
    expect(() => readAnkiPackage(new Uint8Array([1, 2, 3]), SQL)).toThrow("isn't an Anki deck");
  });
});

describe("writing Anki decks", () => {
  test("cards, scheduling, suspensions, history and images survive a round trip", async () => {
    const markdown = [
      "Which organ is this?\n![[Attachments/heart.png]]\n?\nThe heart",
      "Capital of Peru ::: Lima",
      "The {{c1::heart}} pumps blood through the {{c2::aorta}}.",
    ].join("\n\n");
    const cards = parseFlashcards("d1", markdown);
    const at = (day: number) => new Date(Date.UTC(2026, 0, day, 12)).toISOString();
    const entries: ExportCard[] = cards.map((card, index) => {
      const reviews = index === 0 ? [{ id: "r1", cardId: card.id, rating: 3 as const, reviewedAt: at(1) }, { id: "r2", cardId: card.id, rating: 3 as const, reviewedAt: at(3) }] : [];
      return { card: { ...card, docTitle: "Biology › Cells", ...(card.kind === "reverse" ? { suspended: true } : {}) }, schedule: scheduleFromReviews(reviews), reviews };
    });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const bytes = await buildAnkiPackage(entries, new Map([["Attachments/heart.png", png]]), SQL, Date.UTC(2026, 0, 10));

    const collection = readAnkiPackage(bytes, SQL);
    expect([...collection.decks.values()]).toContain("Biology::Cells");
    expect(collection.media.get("heart.png")).toEqual(png);
    expect(collection.notes.map((note) => note.cards.length)).toEqual([2, 2, 1]); // reversed pair, cloze c1+c2, basic
    expect(collection.revlog.map((entry) => entry.ease)).toEqual([3, 3]);

    const plan = planAnkiImport(collection, { embed, createId });
    const doc = plan.documents[0];
    expect(doc.title).toBe("Biology › Cells");
    expect(doc.cards.map((card) => [card.kind, card.front])).toEqual([
      ["basic", "Capital of Peru"], ["reverse", "Lima"],
      ["cloze", "The **[...]** pumps blood through the aorta."], ["cloze", "The heart pumps blood through the **[...]**."],
      ["basic", "Which organ is this?\n![[Attachments/heart.png]]"],
    ]);
    expect(plan.reviews.map((review) => [review.cardId, review.reviewedAt])).toEqual([
      [doc.cards[4].id, at(1)], [doc.cards[4].id, at(3)],
    ]);
    expect(plan.suspended).toEqual([doc.cards[1].id]);
  });
});
