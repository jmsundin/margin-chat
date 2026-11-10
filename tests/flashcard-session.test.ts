import { describe, expect, test } from "bun:test";
import { answerInSession, LEARN_AHEAD_MS, pickNextCard, refreshSession, removeFromSession, startSession } from "../client/src/lib/flashcardSession";
import { groupCardsByDeck, cardStatus } from "../client/src/components/FlashcardBrowser";

const MIN = 60_000;
const t0 = Date.UTC(2026, 10, 10, 12);

describe("review session order", () => {
  test("a learning card that comes due never replaces the card on screen", () => {
    let session = startSession(["a", "b", "c"], t0);
    expect(session.current).toBe("a");
    // Again on a: back in 1 minute. b is shown next.
    session = answerInSession(session, "a", t0 + MIN, t0);
    expect(session.current).toBe("b");
    // Two minutes pass while the person is still looking at b.
    const later = refreshSession(session, t0 + 3 * MIN);
    expect(later).toBe(session);
    expect(later.current).toBe("b");
    // Once b is answered, the overdue learning card a comes before c.
    session = answerInSession(later, "b", t0 + 4 * 24 * 60 * MIN, t0 + 3 * MIN);
    expect(session.current).toBe("a");
    session = answerInSession(session, "a", t0 + 13 * MIN, t0 + 4 * MIN);
    expect(session.current).toBe("c");
  });

  test("learning cards not yet due wait while other cards are left, then are shown early (learn ahead)", () => {
    let session = startSession(["a", "b"], t0);
    session = answerInSession(session, "a", t0 + 10 * MIN, t0);
    expect(session.current).toBe("b");
    session = answerInSession(session, "b", t0 + 5 * MIN, t0);
    // Nothing else is left: the soonest learning card is shown ahead of its time.
    expect(session.current).toBe("b");
    expect(pickNextCard({ order: [], later: [{ id: "x", due: t0 + LEARN_AHEAD_MS + 1 }] }, t0)).toBeNull();
  });

  test("the same card shown twice in a row counts as a new turn", () => {
    let session = startSession(["a"], t0);
    const first = session.turn;
    session = answerInSession(session, "a", t0 + MIN, t0);
    expect(session.current).toBe("a");
    expect(session.turn).toBe(first + 1);
  });

  test("long steps leave the session; an empty screen picks up a card once it comes due", () => {
    let session = startSession(["a"], t0);
    session = answerInSession(session, "a", t0 + 2 * 60 * MIN, t0);
    expect(session).toMatchObject({ current: null, later: [], order: [] });

    session = { order: [], later: [{ id: "b", due: t0 + 30 * MIN }], current: null, turn: 3 };
    expect(refreshSession(session, t0).current).toBeNull();
    expect(refreshSession(session, t0 + 11 * MIN)).toMatchObject({ current: "b", turn: 4 });
  });

  test("a card that disappears (removed from its document, or suspended) is replaced", () => {
    let session = startSession(["a", "b"], t0);
    expect(refreshSession(session, t0, (id) => id !== "a").current).toBe("b");
    session = removeFromSession(session, "a", t0);
    expect(session).toMatchObject({ current: "b", order: ["b"] });
  });
});

describe("card browser", () => {
  const card = (id: string, docId: string, docTitle: string, ordinal: number, extra: object = {}) => ({
    card: { id, docId, docTitle, ordinal, kind: "basic" as const, front: `Front ${id}`, back: `Back ${id}`, createdAt: "", updatedAt: "", ...extra },
    schedule: { state: "new", due: 0 } as never,
    reviews: [],
  });

  test("groups cards by deck in writing order and filters by search words", () => {
    const groups = groupCardsByDeck([card("b2", "d2", "Biology", 2), card("c1", "d1", "Chemistry", 1), card("b1", "d2", "Biology", 1)]);
    expect(groups.map((group) => [group.title, group.cards.map((entry) => entry.card.id)])).toEqual([["Biology", ["b1", "b2"]], ["Chemistry", ["c1"]]]);
    expect(groupCardsByDeck([card("b1", "d2", "Biology", 1), card("c1", "d1", "Chemistry", 1)], "back C1").map((group) => group.title)).toEqual(["Chemistry"]);
  });

  test("status says when a card comes up", () => {
    expect(cardStatus(card("a", "d", "D", 0, { suspended: true }) as never, t0).label).toBe("Suspended");
    expect(cardStatus({ ...card("a", "d", "D", 0), schedule: { state: "review", due: t0 - 1 } } as never, t0).label).toBe("Due now");
    expect(cardStatus({ ...card("a", "d", "D", 0), schedule: { state: "review", due: t0 + 3 * 24 * 60 * MIN } } as never, t0).label).toMatch(/^In 3/);
  });
});
