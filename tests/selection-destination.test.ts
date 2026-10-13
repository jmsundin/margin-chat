import { describe, expect, test } from "bun:test";
import { defaultSelectionDestination, SIDE_DOCUMENT_MIN_OTHER_WORDS } from "../client/src/lib/selectionDestination";

const words = (count: number) => Array.from({ length: count }, (_, index) => `word${index}`).join(" ");
const blocks = (...contents: string[]) => contents.map((content, index) => ({ id: `b${index}`, content }));

describe("default destination for Ask AI on a selection", () => {
  test("answers in this document when the selection is nearly all there is", () => {
    expect(defaultSelectionDestination(blocks("Photosynthesis basics", "How do plants make sugar?", "Some notes here."),
      { sourceBlockId: "b1", quote: "plants make sugar" })).toBe("inline");
  });

  test("answers in this document when the selection is in the last line", () => {
    expect(defaultSelectionDestination(blocks(words(200), words(200), "The closing question?", "", "  "),
      { sourceBlockId: "b2", quote: "closing question" })).toBe("inline");
  });

  test("a passage that continues into the last line counts as at the end", () => {
    expect(defaultSelectionDestination(blocks(words(200), "first half", "second half"),
      { sourceBlockId: "b1", joinBlockIds: ["b2"], quote: "half\n\nsecond" })).toBe("inline");
  });

  test("opens a side document when there is a lot of other text", () => {
    expect(defaultSelectionDestination(blocks("Intro", "The selected line", words(SIDE_DOCUMENT_MIN_OTHER_WORDS)),
      { sourceBlockId: "b1", quote: "selected line" })).toBe("side");
  });

  test("keeps a side document for passages outside the document's lines", () => {
    expect(defaultSelectionDestination(blocks("Just one line"), { quote: "one line" })).toBe("side");
    expect(defaultSelectionDestination(blocks("Just one line"), { sourceBlockId: "missing", quote: "one line" })).toBe("side");
  });
});
