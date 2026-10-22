import { expect, test } from "bun:test";
import { ChangeSet, MapMode, Text } from "@codemirror/state";
import { blockSelection, layoutBlocks, liveBlockInfo, reflowBlocks, renderedTableSelection, snapOutOfGaps, splitSpan, visibleEnd } from "../client/src/lib/liveDocument";

const pieces = (value: string, keepTrailing = 0) => splitSpan(value, [], keepTrailing).map((span) => value.slice(span.from, span.to));

test("the editor text is the blocks joined by a blank line", () => {
  const { text, layout } = layoutBlocks([{ id: "a", content: "Hello" }, { id: "b", content: "" }, { id: "c", content: "World" }]);
  expect(text).toBe("Hello\n\n\n\nWorld");
  expect(layout.map((block) => text.slice(block.from, block.to))).toEqual(["Hello", "", "World"]);
});

test("blank lines between paragraphs split blocks; lists, code and saved passages stay whole", () => {
  for (const value of ["", "A\n\nB", "A\n\n\n\nB", "A\n\n\nB", "- a\n\n- b\n\nPara", "```\nx\n\ny\n```\n\nz", "a\nb\n\n# h"]) {
    expect(pieces(value).join("\n\n")).toBe(value);
  }
  expect(pieces("A\n\nB")).toEqual(["A", "B"]);
  expect(pieces("A\n\n\n\nB")).toEqual(["A", "", "B"]);
  expect(pieces("- a\n\n- b\n\nPara")).toEqual(["- a\n\n- b", "Para"]);
  expect(pieces("```\nx\n\ny\n```\n\nz")).toEqual(["```\nx\n\ny\n```", "z"]);
  expect(pieces("para\n\n", 2)).toEqual(["para\n\n"]);
  const passage = "First.\n\nSecond.";
  expect(splitSpan(passage, [{ from: 2, to: 12 }]).map((span) => passage.slice(span.from, span.to))).toEqual([passage]);
});

function edit(blocks: Array<{ id: string; content: string }>, spec: { from: number; to?: number; insert?: string }) {
  const { text, layout } = layoutBlocks(blocks);
  const doc = Text.of(text.split("\n"));
  const changes = ChangeSet.of(spec, doc.length);
  const newText = changes.apply(doc).toString();
  const ranges: Array<{ fromA: number; toA: number }> = [];
  changes.iterChangedRanges((fromA, toA) => ranges.push({ fromA, toA }));
  const result = reflowBlocks({ oldText: text, newText, layout, changes: ranges, keepTogether: [],
    mapping: { mapPos: (position, assoc = -1) => changes.mapPos(position, assoc), mapStart: (position) => changes.mapPos(position, 1, MapMode.TrackDel) } });
  return result.map((block) => ({ id: block.id, text: newText.slice(block.from, block.to), splitFrom: block.splitFrom ?? null }));
}

test("edits re-derive only the touched blocks and keep their IDs", () => {
  const blocks = [{ id: "a", content: "Hello World" }, { id: "b", content: "Second" }];
  const typed = edit(blocks, { from: 19, insert: "!" });
  expect(typed.map((block) => [block.id, block.text])).toEqual([["a", "Hello World"], ["b", "Second!"]]);

  const split = edit(blocks, { from: 5, insert: "\n\n" });
  expect(split.map((block) => block.text)).toEqual(["Hello", " World", "Second"]);
  expect(split[0].id).toBe("a");
  expect(split[1].splitFrom).toBe("a");
  expect(split[2].id).toBe("b");

  const joined = edit(blocks, { from: 11, to: 13 });
  expect(joined.map((block) => [block.id, block.text])).toEqual([["a", "Hello WorldSecond"]]);

  const cleared = edit(blocks, { from: 0, to: 19 });
  expect(cleared.map((block) => block.text)).toEqual([""]);
});

test("a selection across blocks is reported in the blocks joined with a blank line", () => {
  const { text, layout } = layoutBlocks([{ id: "a", content: "Hello World" }, { id: "b", content: "Second" }]);
  expect(blockSelection(text, layout, 6, 16)).toEqual({ index: 0, id: "a", markdown: "Hello World\n\nSecond", from: 6, to: 16, joinBlockIds: ["b"] });
  // Reaching only the start of the next block leaves it out.
  expect(blockSelection(text, layout, 6, 13)).toMatchObject({ id: "a", from: 6, to: 11, joinBlockIds: [] });
  expect(blockSelection(text, layout, 14, 17)).toMatchObject({ id: "b", from: 1, to: 4, joinBlockIds: [] });
});

test("blank lines saved at a block's end are hidden and the cursor steps over gaps", () => {
  const { text, layout } = layoutBlocks([{ id: "a", content: "Para\n\n" }, { id: "b", content: "Next" }]);
  expect(visibleEnd(text, layout[0])).toBe(4);
  expect(snapOutOfGaps(text, layout, 6, 1)).toBe(layout[1].from);
  expect(snapOutOfGaps(text, layout, 6, -1)).toBe(4);
});

test("media, drawings, tables and math render in place; text is edited inline", () => {
  expect(liveBlockInfo("Plain **text**").kind).toBe("text");
  expect(liveBlockInfo("| a | b |\n| --- | --- |\n| 1 | 2 |").kind).toBe("rendered");
  expect(liveBlockInfo("$$\nx^2\n$$").kind).toBe("rendered");
  expect(liveBlockInfo("First.\n\nSecond.").collapsed).toEqual([{ from: 6, to: 7 }]);
});

test("a long block renders only its tables and diagrams, each on its own", () => {
  const diagram = "```mermaid\nflowchart LR\n  A --> B\n```";
  const table = "| a | b |\n| --- | --- |\n| 1 | 2 |";
  const content = `# Title\n\nIntro.\n\n${diagram}\n\nMiddle.\n\n${table}`;
  const info = liveBlockInfo(content);
  expect(info.kind).toBe("text");
  expect(info.parts.map((part) => content.slice(part.from, part.to))).toEqual([diagram, table]);
  expect(info.collapsed.length).toBe(4);
  // A block that is only a diagram, or needs its reference definitions, still renders whole.
  expect(liveBlockInfo(diagram)).toMatchObject({ kind: "rendered", parts: [] });
  expect(liveBlockInfo("See [x][1].\n\n[1]: https://example.com").kind).toBe("rendered");
});

test("text selected in a rendered table maps to its Markdown", () => {
  const markdown = "| Name | Role |\n| --- | --- |\n| Alice **Smith** | Engineer &amp; lead |\n| - | Designer |";
  const rendered = "\nNameRole\n\nAlice Smith\tEngineer & lead\n-\tDesigner\n";
  const select = (text: string) => { const start = rendered.indexOf(text); return renderedTableSelection(markdown, rendered, start, start + text.length); };
  const quote = (text: string) => { const span = select(text); return span && markdown.slice(span.from, span.to); };
  expect(quote("Smith")).toBe("Smith");
  expect(quote("Alice Smith")).toBe("Alice **Smith");
  expect(quote("Engineer & lead")).toBe("Engineer &amp; lead");
  // A dash in a cell isn't mistaken for the delimiter row.
  expect(select("-")).toEqual({ from: markdown.indexOf("| - |") + 2, to: markdown.indexOf("| - |") + 3 });
  expect(quote("Role\n\nAlice")).toBe("Role |\n| --- | --- |\n| Alice");
  expect(select("\n\n")).toBeNull();
});
