import { describe, expect, test } from "bun:test";
import { findVerdict, isQuestion, rankDocuments } from "../server/vault/findDocuments.mjs";

const NOW = Date.parse("2026-11-07T00:00:00Z");
const passage = (id: string, title: string, score: number, extra: Record<string, unknown> = {}) => ({
  id, sourceKind: "conversation", title, score, similarity: 0.5, matched: "both", heading: null, snippet: `${title} passage`, updatedAt: "2026-10-01T00:00:00Z", ...extra,
});

describe("ranking whole documents for Found it", () => {
  test("a document covering the topic in several sections beats one lucky passage", () => {
    const ranked = rankDocuments({ query: "rapamycin mice", now: NOW, passages: [
      passage("stray", "Reading list", 0.0164),
      passage("rapa", "Rapamycin", 0.0161), passage("rapa", "Rapamycin", 0.0158), passage("rapa", "Rapamycin", 0.0150),
    ] });
    expect(ranked.map((found) => found.id)).toEqual(["rapa", "stray"]);
    expect(ranked[0].why).toBe("Same words and meaning in 3 sections");
    expect(ranked[0].best.snippet).toBe("Rapamycin passage");
  });

  test("a title holding every word counts, and a hidden document is found by title alone", () => {
    const ranked = rankDocuments({ query: "longevity plan", now: NOW, passages: [passage("other", "Sleep", 0.0164)],
      titles: [{ id: "plan", title: "My longevity plan", updated: "2026-11-01T00:00:00Z", hiddenFromAI: true }] });
    expect(ranked[0]).toMatchObject({ id: "plan", titleMatch: true, hidden: true, why: "Title has every word", best: null });
  });

  test("a file's passages count toward the document it is attached to", () => {
    const ranked = rankDocuments({ query: "trial results", now: NOW,
      passages: [passage("file-1", "results.pdf", 0.016, { sourceKind: "attachment", attachedTo: "chat" })],
      titles: [{ id: "chat", title: "Trial results discussion" }] });
    expect(ranked[0]).toMatchObject({ id: "chat", title: "Trial results discussion", titleMatch: true });
  });

  test("the hub that links to other matches gets a boost", () => {
    const passages = [passage("a", "Alpha", 0.0164), passage("hub", "Hub", 0.0160), passage("b", "Beta", 0.0158)];
    const plain = rankDocuments({ query: "topic words", now: NOW, passages });
    expect(plain[0].id).toBe("a");
    const linked = rankDocuments({ query: "topic words", now: NOW, passages, related: (id: string) => (id === "hub" ? ["a", "b"] : []) });
    expect(linked[0]).toMatchObject({ id: "hub", why: "Same words and meaning in 1 section · links 2 other matches" });
  });
});

describe("Found it or answer", () => {
  test("questions are told apart from descriptions", () => {
    expect(isQuestion("how does rapamycin extend lifespan")).toBe(true);
    expect(isQuestion("rapamycin lifespan?")).toBe(true);
    expect(isQuestion("that drug trial in old mice")).toBe(false);
    expect(isQuestion("what")).toBe(false);
  });

  test("one clear document is found; a question about it asks for an answer", () => {
    const ranked = rankDocuments({ query: "rapamycin", now: NOW, passages: [
      passage("rapa", "Rapamycin", 0.0164, { similarity: 0.7 }), passage("rapa", "Rapamycin", 0.016, { similarity: 0.6 }),
      passage("other", "Other", 0.008, { similarity: 0.4 }),
    ] });
    expect(findVerdict("that rapamycin trial", ranked)).toMatchObject({ verdict: "found", question: false, documents: [{ id: "rapa" }] });
    expect(findVerdict("how does rapamycin work?", ranked)).toMatchObject({ verdict: "answer", question: true, documents: [{ id: "rapa" }] });
  });

  test("several close documents form a group; weak meaning-only matches find nothing", () => {
    const close = rankDocuments({ query: "sleep", now: NOW, passages: [passage("a", "A", 0.0164), passage("b", "B", 0.0160), passage("c", "C", 0.0155)] });
    expect(findVerdict("sleep notes", close)).toMatchObject({ verdict: "several" });
    expect(findVerdict("sleep notes", close).documents).toHaveLength(3);
    const weak = rankDocuments({ query: "quantum", now: NOW, passages: [passage("a", "A", 0.016, { matched: "meaning", similarity: 0.3 })] });
    expect(findVerdict("quantum", weak)).toEqual({ verdict: "none", question: false, documents: [] });
    expect(findVerdict("anything", [])).toEqual({ verdict: "none", question: false, documents: [] });
  });
});
