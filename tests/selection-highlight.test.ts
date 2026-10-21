import { describe, expect, test } from "bun:test";
import { isMarkdownHighlighted, toggleMarkdownHighlight } from "../client/src/lib/selectionHighlight";

describe("selection highlight", () => {
  test("wraps the passage in a highlight mark", () => {
    expect(toggleMarkdownHighlight("Alpha selected passage omega.", 6, 22)).toBe("Alpha ==selected passage== omega.");
  });

  test("leaves the spaces a drag picks up outside the mark", () => {
    expect(toggleMarkdownHighlight("Alpha selected passage omega.", 5, 23)).toBe("Alpha ==selected passage== omega.");
  });

  test("removes the mark from a passage that already has one", () => {
    const content = "Alpha ==selected passage== omega.";
    expect(isMarkdownHighlighted(content, 8, 24)).toBe(true);
    expect(toggleMarkdownHighlight(content, 8, 24)).toBe("Alpha selected passage omega.");
  });

  test("marks each line on its own", () => {
    expect(toggleMarkdownHighlight("one\ntwo three", 0, 7)).toBe("==one==\n==two== three");
  });

  test("returns null for empty or out of range passages", () => {
    expect(toggleMarkdownHighlight("Alpha", 2, 2)).toBeNull();
    expect(toggleMarkdownHighlight("Alpha", 0, 9)).toBeNull();
    expect(toggleMarkdownHighlight("a   b", 1, 4)).toBeNull();
    expect(isMarkdownHighlighted("Alpha", 0, 5)).toBe(false);
  });
});
