import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { answerTopic, fallbackQuestion, SearchFallbackActions, SearchFallbackResults, wikipediaSearchUrl } from "../client/src/components/MapSearchFallbacks";
import { createEmptyState } from "../client/src/initialState";
import { createMapNote } from "../client/src/lib/graphWorkspaceEdits";

const member = { userId: "user-1", canAsk: true, isAdmin: false };
const free = { userId: "user-2", canAsk: false, isAdmin: false };

describe("map search fallbacks", () => {
  test("offer AI, Wikipedia and the web for the search text, marking member features for free accounts", () => {
    const freeMarkup = renderToStaticMarkup(<SearchFallbackActions query="  Mycorrhiza  " canAsk={false} onChoose={() => {}} />);
    expect(freeMarkup).toContain("Ask AI about “Mycorrhiza”");
    expect(freeMarkup).toContain("Search Wikipedia for “Mycorrhiza”");
    expect(freeMarkup).toContain("Search the web for “Mycorrhiza”");
    expect(freeMarkup.match(/>Members</g)?.length).toBe(2);
    expect(freeMarkup).toContain(">Free<");

    const memberMarkup = renderToStaticMarkup(<SearchFallbackActions query="Mycorrhiza" canAsk onChoose={() => {}} openWikipedia />);
    expect(memberMarkup).not.toContain(">Members<");
    // The public map already searches Wikipedia, so it opens Wikipedia's own search instead.
    expect(memberMarkup).toContain(`href="${wikipediaSearchUrl("Mycorrhiza").replaceAll("&", "&amp;")}"`);
    expect(memberMarkup).toContain('target="_blank"');
  });

  test("put the chosen source first and explain member features to free accounts", () => {
    const props = { query: "Mycorrhiza", onAddTopic() {}, topicActionLabel: "Add to my map" };
    const web = renderToStaticMarkup(<SearchFallbackResults {...props} source="web" account={free} />);
    expect(web.indexOf("Search the web")).toBeLessThan(web.indexOf("Wikipedia"));
    expect(web).toContain("Web search comes with a subscription or credit");
    expect(web).toContain("Members with a subscription or credit can ask AI");

    const ai = renderToStaticMarkup(<SearchFallbackResults {...props} source="ai" account={member} />);
    expect(ai.indexOf("Ask AI")).toBeLessThan(ai.indexOf("Wikipedia"));
    expect(ai).toContain("What is Mycorrhiza?");

    const signedOut = renderToStaticMarkup(<SearchFallbackResults {...props} source="wikipedia" />);
    expect(signedOut.indexOf("Wikipedia")).toBeLessThan(signedOut.indexOf("Search the web"));
    expect(signedOut).toContain("Open “Mycorrhiza” on Wikipedia");
  });

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

  test("turn an AI answer's related topic into a map topic", () => {
    expect(answerTopic({ id: "Q193186", label: "Mycorrhiza", description: "fungus–plant symbiosis", relation: "explains" }, "2026-10-09T00:00:00.000Z")).toEqual({
      id: "Q193186", aliases: [], label: "Mycorrhiza", description: "fungus–plant symbiosis",
      wikidataUrl: "https://www.wikidata.org/wiki/Q193186", wikipediaUrl: "https://en.wikipedia.org/wiki/Mycorrhiza", retrievedAt: "2026-10-09T00:00:00.000Z",
    });
  });

  test("save an answer as its own note when no note was selected", () => {
    const state = createMapNote(createEmptyState(), { id: "answer", noteId: "answer-note", createdAt: "2026-10-09T00:00:00.000Z", title: " What is Mycorrhiza? ", content: "> AI answer\n\nA symbiosis." });
    expect(state.conversations.answer.title).toBe("What is Mycorrhiza?");
    expect(state.conversations.answer.notes?.[0].content).toBe("> AI answer\n\nA symbiosis.");
    expect(state.conversations.answer.parentId).toBeNull();
  });
});
