import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://margin-note-ink.test" });
for (const name of ["window", "document", "HTMLElement", "Element", "getComputedStyle"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === "getComputedStyle" ? value.bind(browser) : value });
}
const { noteTimeLabel } = await import("../client/src/components/DocumentMargin");
const { getDocumentTitleSource, MIN_MARGIN_NOTE_TITLE_CONTENT_LENGTH } = await import("../client/src/lib/documentTitle");

describe("an open margin note's time", () => {
  const now = new Date(2026, 10, 21, 15, 0);
  test("today and yesterday by name", () => {
    expect(noteTimeLabel(new Date(2026, 10, 21, 14, 45).toISOString(), now)).toMatch(/^Today, /);
    expect(noteTimeLabel(new Date(2026, 10, 20, 9, 10).toISOString(), now)).toMatch(/^Yesterday, /);
  });
  test("older dates by day, with the year only when it isn't this year", () => {
    expect(noteTimeLabel(new Date(2026, 10, 18, 9, 10).toISOString(), now)).not.toMatch(/2026/);
    expect(noteTimeLabel(new Date(2025, 2, 3, 9, 10).toISOString(), now)).toMatch(/2025/);
  });
  test("nothing for a missing or broken time", () => {
    expect(noteTimeLabel(undefined, now)).toBe("");
    expect(noteTimeLabel("not a date", now)).toBe("");
  });
});

describe("naming a margin note", () => {
  const note = (title: string, text: string) => ({ title, document: { blocks: [{ id: "b", content: text }] } }) as any;
  const sentence = "Look for the Mannick trial: weekly everolimus helped.";
  test("a sentence is enough for a margin note, not for a page", () => {
    expect(sentence.length).toBeGreaterThanOrEqual(MIN_MARGIN_NOTE_TITLE_CONTENT_LENGTH);
    expect(getDocumentTitleSource(note("Untitled margin note", sentence))).toBeNull();
    expect(getDocumentTitleSource(note("Untitled margin note", sentence), undefined, MIN_MARGIN_NOTE_TITLE_CONTENT_LENGTH)).toBe(sentence);
  });
  test("the passage's words stand in for a name until the AI names it", () => {
    expect(getDocumentTitleSource(note("a low weekly dose", sentence), "a low weekly dose", MIN_MARGIN_NOTE_TITLE_CONTENT_LENGTH)).toBe(sentence);
    expect(getDocumentTitleSource(note("My own name", sentence), "a low weekly dose", MIN_MARGIN_NOTE_TITLE_CONTENT_LENGTH)).toBeNull();
  });
});
