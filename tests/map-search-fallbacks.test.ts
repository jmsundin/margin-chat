import { describe, expect, test } from "bun:test";
import { fallbackQuestion, wikipediaSearchUrl } from "../client/src/components/MapSearchFallbacks";
import { createEmptyState } from "../client/src/initialState";
import { createMapNote } from "../client/src/lib/graphWorkspaceEdits";

describe("map search fallbacks", () => {
  test("ask AI a question as typed, or what a term is", () => {
    expect(fallbackQuestion("Mycorrhiza")).toBe("What is Mycorrhiza?");
    expect(fallbackQuestion("how do fungi  trade sugar")).toBe("how do fungi trade sugar");
    expect(fallbackQuestion("fungal networks?")).toBe("fungal networks?");
  });

  test("link to Wikipedia's full-text article search", () => {
    const url = new URL(wikipediaSearchUrl(" wood wide web "));
    expect(url.origin + url.pathname).toBe("https://en.wikipedia.org/w/index.php");
    expect(url.searchParams.get("search")).toBe("wood wide web");
    expect(url.searchParams.get("fulltext")).toBe("1");
  });

  test("save an answer as its own note when no note was selected", () => {
    const state = createMapNote(createEmptyState(), { id: "answer", noteId: "answer-note", createdAt: "2026-10-09T00:00:00.000Z", title: " What is Mycorrhiza? ", content: "> AI answer\n\nA symbiosis." });
    expect(state.conversations.answer.title).toBe("What is Mycorrhiza?");
    expect(state.conversations.answer.notes?.[0].content).toBe("> AI answer\n\nA symbiosis.");
    expect(state.conversations.answer.parentId).toBeNull();
  });
});
