import { afterEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { clozeSides, parseFlashcards, relinkFlashcards } from "../client/src/lib/flashcards";
import { buildStudyQueue, formatInterval, previewRatings, scheduleFromReviews, type FlashcardReview } from "../client/src/lib/flashcardSchedule";
import { FlashcardStore } from "../client/src/lib/flashcardStore";
import { loadMigrations, migrateDatabase } from "../server/db/migrations.mjs";
import * as flashcardRepository from "../server/db/flashcardRepository.mjs";
import { createFlashcardService } from "../server/flashcards/index.mjs";

describe("writing cards in a document", () => {
  test("reads one-line, two-way, multi-line and cloze cards", () => {
    const cards = parseFlashcards("doc", [
      "# Biology",
      "",
      "- What makes ATP? :: The mitochondria",
      "Capital of France ::: Paris",
      "",
      "Name the stages",
      "of mitosis",
      "?",
      "Prophase, metaphase,",
      "anaphase, telophase",
      "",
      "The {{c1::heart}} pumps blood through the {{c2::aorta::vessel}}.",
    ].join("\n"));
    expect(cards.map((card) => [card.kind, card.front, card.back])).toEqual([
      ["basic", "What makes ATP?", "The mitochondria"],
      ["basic", "Capital of France", "Paris"],
      ["reverse", "Paris", "Capital of France"],
      ["basic", "Name the stages\nof mitosis", "Prophase, metaphase,\nanaphase, telophase"],
      ["cloze", "The **[...]** pumps blood through the aorta.", "The **heart** pumps blood through the aorta."],
      ["cloze", "The heart pumps blood through the **[vessel]**.", "The heart pumps blood through the **aorta**."],
    ]);
    expect(new Set(cards.map((card) => card.id)).size).toBe(cards.length);
  });

  test("leaves code, Rust paths and half-written cards alone", () => {
    expect(parseFlashcards("doc", [
      "```rust",
      "let a = x :: y;",
      "```",
      "Use std::io for input.",
      "Only a front ::",
      "`a :: b` in code",
      "?",
    ].join("\n"))).toEqual([]);
  });

  test("keeps images on either side of a card", () => {
    const [card] = parseFlashcards("doc", "Which organ is this?\n![[Attachments/heart.png]]\n?\nThe heart");
    expect(card.front).toBe("Which organ is this?\n![[Attachments/heart.png]]");
  });

  test("a card has the same id on every device and changes id when its front changes", () => {
    const a = parseFlashcards("doc", "Q :: A")[0];
    expect(parseFlashcards("doc", "Q   ::   A")[0].id).toBe(a.id);
    expect(parseFlashcards("doc", "Q :: A better answer")[0].id).toBe(a.id);
    expect(parseFlashcards("doc", "Q? :: A")[0].id).not.toBe(a.id);
    expect(parseFlashcards("other", "Q :: A")[0].id).not.toBe(a.id);
  });

  test("an edited card is paired with the card it replaced", () => {
    const before = parseFlashcards("doc", "What makes ATP in the cell? :: Mitochondria\nCapital of Peru :: Lima");
    const after = parseFlashcards("doc", "What makes most ATP in the cell? :: Mitochondria\nCapital of Peru :: Lima");
    expect(relinkFlashcards([before[0]], [after[0]]).get(after[0].id)).toBe(before[0].id);
    const unrelated = parseFlashcards("doc", "Speed of light :: 299,792 km/s");
    expect(relinkFlashcards([before[0]], unrelated).size).toBe(0);
  });

  test("cloze hints and other numbers", () => {
    expect(clozeSides("{{c1::a}} and {{c2::b::letter}}", 2)).toEqual({ front: "a and **[letter]**", back: "a and **b**" });
  });
});

describe("scheduling", () => {
  const day = 86_400_000;
  const start = Date.UTC(2026, 0, 1, 12);
  const review = (offset: number, rating: 1 | 2 | 3 | 4, id = String(offset)): FlashcardReview =>
    ({ id, cardId: "c", rating, reviewedAt: new Date(start + offset).toISOString() });

  test("good answers push a card further out; again brings it back", () => {
    const first = scheduleFromReviews([review(0, 3)], start);
    expect(first.state).toBe("learning");
    const reviews = [review(0, 3), review(10 * 60_000, 3), review(3 * day, 3)];
    const later = scheduleFromReviews(reviews, start);
    expect(later.state).toBe("review");
    expect(later.due - (start + 3 * day)).toBeGreaterThan(5 * day);
    const lapsed = scheduleFromReviews([...reviews, review(20 * day, 1)], start);
    expect(lapsed.state).toBe("relearning");
    expect(lapsed.lapses).toBe(1);
  });

  test("replaying the same reviews in any order gives the same schedule", () => {
    const reviews = [review(0, 3), review(600_000, 4), review(9 * day, 2), review(30 * day, 3)];
    expect(scheduleFromReviews([...reviews].reverse(), start)).toEqual(scheduleFromReviews(reviews, start));
  });

  test("the four buttons preview increasing intervals", () => {
    const preview = previewRatings([], start);
    expect(preview[1]).toBeLessThan(preview[2]);
    expect(preview[2]).toBeLessThanOrEqual(preview[3]);
    expect(preview[3]).toBeLessThan(preview[4]);
    expect(formatInterval(preview[1] - start)).toBe("1m");
  });

  test("study queue: learning first, then overdue reviews, then new cards up to the day's allowance", () => {
    const now = start + 10 * day;
    const entry = (id: string, state: "new" | "learning" | "review", due: number) =>
      ({ card: { id }, schedule: { state, due, stability: 1, difficulty: 5, reps: 1, lapses: 0, lastReview: null } });
    const queue = buildStudyQueue([
      entry("n1", "new", 0), entry("n2", "new", 0), entry("n3", "new", 0),
      entry("r-late", "review", now - 5 * day), entry("r-soon", "review", now - day), entry("r-future", "review", now + 5 * day),
      entry("l1", "learning", now - 1000), entry("l-later", "learning", now + 3_600_000),
    ], now, { newPerDay: 3, newStudiedToday: 1 });
    expect(queue.learning.map((item) => item.card.id)).toEqual(["l1"]);
    expect(queue.review.map((item) => item.card.id)).toEqual(["r-late", "r-soon"]);
    expect(queue.fresh.map((item) => item.card.id)).toEqual(["n1", "n2"]);
  });
});

describe("the device's card store", () => {
  test("follows the document's text, keeps history through edits and never deletes a card", () => {
    const store = new FlashcardStore("test", { memoryOnly: true });
    const v1 = parseFlashcards("doc", "What makes ATP in the cell? :: Mitochondria\nCapital of Peru :: Lima");
    store.syncDocument("doc", "Biology", v1, "2026-01-01T00:00:00.000Z");
    void store.addReview({ id: "r1", cardId: v1[0].id, rating: 3, reviewedAt: "2026-01-01T01:00:00.000Z" });

    const v2 = parseFlashcards("doc", "What makes most ATP in the cell? :: Mitochondria");
    store.syncDocument("doc", "Biology", v2, "2026-01-02T00:00:00.000Z");
    const { cards } = store.getSnapshot();
    const edited = cards.get(v2[0].id)!;
    expect(edited.historyFrom).toEqual([v1[0].id]);
    expect(store.reviewsFor(edited).map((review) => review.id)).toEqual(["r1"]);
    expect(cards.get(v1[1].id)?.removed).toBe(true);
    expect(cards.get(v1[0].id)?.removed).toBe(true);

    // Writing the card back brings it back with its state.
    store.syncDocument("doc", "Biology", parseFlashcards("doc", "Capital of Peru :: Lima"), "2026-01-03T00:00:00.000Z");
    expect(store.getSnapshot().cards.get(v1[1].id)?.removed).toBeUndefined();
  });

  test("sends only what changed, takes in newer remote copies and undoes an unsent answer", async () => {
    const store = new FlashcardStore("test", { memoryOnly: true });
    const [card] = parseFlashcards("doc", "Q :: A");
    store.syncDocument("doc", "Doc", [card], "2026-01-01T00:00:00.000Z");
    await store.addReview({ id: "r1", cardId: card.id, rating: 3, reviewedAt: "2026-01-01T01:00:00.000Z" });
    const pending = store.pendingChanges();
    expect(pending.cards).toHaveLength(1);
    expect(pending.reviews).toHaveLength(1);
    await store.markSent(pending);
    expect(store.pendingChanges()).toEqual({ cards: [], reviews: [] });
    expect(store.undoReview("r1")).toBe(false); // already in the account

    await store.addReview({ id: "r2", cardId: card.id, rating: 1, reviewedAt: "2026-01-02T01:00:00.000Z" });
    expect(store.undoReview("r2")).toBe(true);
    expect(store.getSnapshot().reviews.has("r2")).toBe(false);

    const stored = store.getSnapshot().cards.get(card.id)!;
    store.applyRemote({ cards: [{ ...stored, suspended: true, updatedAt: "2025-01-01T00:00:00.000Z" }], reviews: [{ id: "r3", cardId: card.id, rating: 4, reviewedAt: "2026-01-03T00:00:00.000Z" }] });
    expect(store.getSnapshot().cards.get(card.id)?.suspended).toBeUndefined(); // older copy ignored
    expect(store.getSnapshot().reviews.has("r3")).toBe(true);
    store.applyRemote({ cards: [{ ...stored, suspended: true, updatedAt: "2027-01-01T00:00:00.000Z" }] });
    expect(store.getSnapshot().cards.get(card.id)?.suspended).toBe(true);
  });
});

const databases: PGlite[] = [];
afterEach(async () => { await Promise.all(databases.splice(0).map((database) => database.close())); });

describe("flashcard sync on the server", () => {
  test("saves each device's changes once and hands them to the other devices", async () => {
    const pg = new PGlite({ extensions: { vector } });
    databases.push(pg);
    const client = { async query(sql: string, values?: unknown[]) {
      const result = values === undefined && sql.includes(";") ? (await pg.exec(sql)).at(-1)! : await pg.query(sql, values);
      return { ...result, rowCount: result.rows.length || (result as { affectedRows?: number }).affectedRows || 0 };
    } };
    await migrateDatabase(client, { migrations: await loadMigrations() });
    await pg.query("insert into marginchat_users (id,email,password_hash,display_name) values ('u1','u1@example.test','hash','U1'), ('u2','u2@example.test','hash','U2')");
    const database: any = {
      saveFlashcardChanges: (args: any) => flashcardRepository.saveFlashcardChanges(client, args),
      readFlashcardChanges: (args: any) => flashcardRepository.readFlashcardChanges(client, args),
    };
    const service = createFlashcardService({ database });
    const card = { id: "c1", docId: "d1", docTitle: "Bio", kind: "cloze", front: "The **[...]**", back: "The **heart**", cloze: 1, ordinal: 0,
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    const review = { id: "r1", cardId: "c1", rating: 3, reviewedAt: "2026-01-01T01:00:00.000Z", durationMs: 4200 };

    const phone = await service.sync({ userId: "u1", body: { cards: [card], reviews: [review] } });
    expect(phone.saved).toEqual({ cards: [{ id: "c1", updatedAt: card.updatedAt }], reviews: ["r1"] });

    // Sent again (a retry after a lost response): still one of each.
    await service.sync({ userId: "u1", body: { cards: [card], reviews: [review] } });
    const laptop = await service.sync({ userId: "u1", body: {} });
    expect(laptop.cards).toEqual([card]);
    expect(laptop.reviews).toEqual([review]);

    // An older copy of a card never replaces a newer one.
    await service.sync({ userId: "u1", body: { cards: [{ ...card, front: "stale", updatedAt: "2025-01-01T00:00:00.000Z" }] } });
    const newer = { ...card, suspended: true, updatedAt: "2026-02-01T00:00:00.000Z" };
    await service.sync({ userId: "u1", body: { cards: [newer] } });
    const next = await service.sync({ userId: "u1", body: { cardCursor: laptop.cardCursor, reviewCursor: laptop.reviewCursor } });
    expect(next.cards).toEqual([newer]);
    expect(next.reviews).toEqual([]);

    // Another account sees nothing of this one.
    expect((await service.sync({ userId: "u2", body: {} })).cards).toEqual([]);
    // A malformed review refuses the batch instead of losing it quietly.
    await expect(service.sync({ userId: "u1", body: { reviews: [{ ...review, id: "r2", rating: 7 }] } })).rejects.toThrow("not readable");
  });
});
