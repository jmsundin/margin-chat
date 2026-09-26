import { describe, expect, test } from "bun:test";
import type { DocumentBlock } from "@margin-chat/workspace-contracts";
import { DocumentEditHistory } from "../client/src/lib/documentEditHistory";

const date = "2026-09-25T12:00:00.000Z";
const block = (content: string, id = "first"): DocumentBlock => ({ id, kind: "markdown", content, createdAt: date, updatedAt: date });
const focus = (blockId: string, offset: number) => ({ blockId, from: offset, to: offset });

describe("document editing history", () => {
  test("groups consecutive typing and restores the first and last selections", () => {
    const start = [block("")];
    const first = [block("H")];
    const final = [block("Hello")];
    const history = new DocumentEditHistory(start);
    history.record(start, first, { group: "first", beforeFocus: focus("first", 0), afterFocus: focus("first", 1) }, 0);
    history.record(first, final, { group: "first", beforeFocus: focus("first", 1), afterFocus: focus("first", 5) }, 500);
    expect(history.undo(final)).toEqual({ blocks: start, focus: focus("first", 0) });
    expect(history.undo(start)).toBeNull();
    expect(history.redo(start)).toEqual({ blocks: final, focus: focus("first", 5) });
    expect(history.redo(final)).toBeNull();
  });

  test("undo follows chronological edits across blocks, with pauses starting new groups", () => {
    const states = [
      [block("A"), block("B", "second")],
      [block("Aa"), block("B", "second")],
      [block("Aa"), block("Bb", "second")],
      [block("Aa"), block("Bbc", "second")],
    ];
    const history = new DocumentEditHistory(states[0]);
    history.record(states[0], states[1], { group: "first" }, 0);
    history.record(states[1], states[2], { group: "second" }, 100);
    history.record(states[2], states[3], { group: "second" }, 601);
    for (let index = states.length - 1; index > 0; index--) {
      expect(history.undo(states[index])?.blocks).toEqual(states[index - 1]);
    }
    for (let index = 0; index < states.length - 1; index++) {
      expect(history.redo(states[index])?.blocks).toEqual(states[index + 1]);
    }
  });

  test("moving the caret creates a new typing step even within the grouping delay", () => {
    const start = [block("one two")];
    const first = [block("one two!")];
    const second = [block("One two!")];
    const history = new DocumentEditHistory(start);
    history.record(start, first, { group: "first", beforeFocus: focus("first", 7), afterFocus: focus("first", 8) }, 0);
    history.record(first, second, { group: "first", beforeFocus: { blockId: "first", from: 0, to: 1 }, afterFocus: focus("first", 1) }, 100);
    expect(history.undo(second)?.blocks).toEqual(first);
    expect(history.undo(first)?.blocks).toEqual(start);
  });

  test("a split is a separate undo step and restores its deleted editor's focus", () => {
    const start = [block("Hello")];
    const typed = [block("Hello there")];
    const split = [block("Hello"), block(" there", "second")];
    const after = [block("Hello"), block(" there!", "second")];
    const history = new DocumentEditHistory(start);
    history.record(start, typed, { group: "first" }, 0);
    history.record(typed, split, { beforeFocus: focus("first", 5), afterFocus: focus("second", 0) }, 10);
    history.record(split, after, { group: "second" }, 20);
    expect(history.undo(after)?.blocks).toEqual(split);
    expect(history.undo(split)).toEqual({ blocks: typed, focus: focus("first", 5) });
    expect(history.undo(typed)?.blocks).toEqual(start);
  });

  test("external authored changes invalidate both undo and redo", () => {
    const start = [block("Original")];
    const edited = [block("Edited")];
    const external = [block("Edited"), block("AI response", "generated")];
    const history = new DocumentEditHistory(start);
    history.record(start, edited);
    expect(history.undo(external)).toBeNull();
    expect(history.redo(external)).toBeNull();
    history.record(external, [block("New edit"), external[1]]);
    expect(history.undo([block("New edit"), external[1]])?.blocks).toEqual(external);
    history.sync([block("Another source"), external[1]]);
    expect(history.redo([block("Another source"), external[1]])).toBeNull();
  });

  test("record synchronizes external edits before starting a new local history", () => {
    const start = [block("A")];
    const edited = [block("B")];
    const external = [block("Externally replaced")];
    const latest = [block("Externally replaced and edited")];
    const history = new DocumentEditHistory(start);
    history.record(start, edited);
    history.record(external, latest);
    expect(history.undo(latest)?.blocks).toEqual(external);
    expect(history.undo(external)).toBeNull();
  });

  test("timestamp refreshes and no-op saves do not create steps or discard redo", () => {
    const start = [block("A")];
    const edited = [block("B")];
    const refreshed = [{ ...edited[0], updatedAt: "2026-09-25T12:01:00.000Z" }];
    const history = new DocumentEditHistory(start);
    history.record(start, edited);
    history.sync(refreshed);
    expect(history.record(refreshed, edited)).toBe(false);
    expect(history.undo(refreshed)?.blocks).toEqual(start);
    expect(history.record(start, [{ ...start[0], updatedAt: refreshed[0].updatedAt }])).toBe(false);
    expect(history.redo(start)?.blocks).toEqual(edited);
  });

  test("a fresh edit after undo clears redo and cannot merge across the undo boundary", () => {
    const states = ["A", "B", "C", "D"].map((content) => [block(content)]);
    const history = new DocumentEditHistory(states[0]);
    history.record(states[0], states[1], { group: "first" }, 0);
    history.record(states[1], states[2], {}, 10);
    expect(history.undo(states[2])?.blocks).toEqual(states[1]);
    history.record(states[1], states[3], { group: "first" }, 20);
    expect(history.redo(states[3])).toBeNull();
    expect(history.undo(states[3])?.blocks).toEqual(states[1]);
    expect(history.undo(states[1])?.blocks).toEqual(states[0]);
  });

  test("caller mutations cannot alter stored snapshots or focus", () => {
    const start = [block("A")];
    const edited = [block("B")];
    const originalFocus = focus("first", 1);
    const history = new DocumentEditHistory(start);
    history.record(start, edited, { beforeFocus: originalFocus, afterFocus: originalFocus });
    start[0].content = "Mutated input";
    originalFocus.from = 900;
    const result = history.undo(edited)!;
    expect(result.blocks[0].content).toBe("A");
    expect(result.focus?.from).toBe(1);
    result.blocks[0].content = "Mutated output";
    result.focus!.from = 800;
    const redone = history.redo([block("A")])!;
    redone.blocks[0].content = "Mutated redo";
    expect(history.undo(edited)).toEqual({ blocks: [block("A")], focus: focus("first", 1) });
  });

  test("retains only the most recent 100 undo steps", () => {
    let current = [block("0")];
    const history = new DocumentEditHistory(current);
    for (let index = 1; index <= 105; index++) {
      const next = [block(String(index))];
      history.record(current, next);
      current = next;
    }
    for (let index = 104; index >= 5; index--) {
      current = history.undo(current)!.blocks;
      expect(current[0].content).toBe(String(index));
    }
    expect(history.undo(current)).toBeNull();
    expect(history.redo(current)?.blocks[0].content).toBe("6");
  });
});
