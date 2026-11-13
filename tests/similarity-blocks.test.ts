import { describe, expect, test } from "bun:test";
import { createMainConversation } from "../client/src/initialState";
import { layoutCanvasGroupBoxes, layoutFamilyTrees } from "../client/src/lib/canvasGroupBoxes";
import type { ConversationGraphNodePlacement } from "../client/src/lib/conversationGraph";
import { documentSimilarity, similarityBlocks, titleSimilarity, titleWords } from "../client/src/lib/similarityBlocks";
import type { Conversation, ConversationGroup } from "../client/src/types";

/** Documents on three subjects (a, b, c) and two that match nothing (x, y). */
const subjectOf = (id: string) => id[0];
const alike = (a: string, b: string) => subjectOf(a) === subjectOf(b) && !"xy".includes(subjectOf(a)) ? 0.7 : 0.05;
const ids = ["a1", "b1", "x", "a2", "c1", "b2", "a3", "y", "c2"];

describe("similarity blocks", () => {
  test("alike documents form blocks, biggest first, and loners come last", () => {
    const { blocks, loners } = similarityBlocks(ids, alike);
    expect(blocks.map((block) => block.map(subjectOf).join(""))).toEqual(["aaa", "bb", "cc"]);
    expect([...loners].sort()).toEqual(["x", "y"]);
  });

  test("within a block each document sits next to the one most like it", () => {
    const score: Record<string, number> = { "p:q": 0.9, "q:r": 0.8, "p:r": 0.5 };
    const similarity = (a: string, b: string) => score[[a, b].sort().join(":")] ?? 0;
    const [block] = similarityBlocks(["r", "p", "q"], similarity, 0.45).blocks;
    // q is the most alike to the others, so it starts; p (0.9) then r
    expect(block).toEqual(["q", "p", "r"]);
  });

  test("in a box of loosely related documents the closest pairs still sit together", () => {
    // nothing reaches the usual bar, but these pairs are the closest in the box
    const loose = (a: string, b: string) => subjectOf(a) === subjectOf(b) ? 0.33 : 0.1;
    const { blocks } = similarityBlocks(["a1", "b1", "c1", "a2", "b2", "c2", "d1", "e1", "f1", "g1"], loose);
    expect(blocks.map((block) => [...block].sort().join(" "))).toEqual(["a1 a2", "b1 b2", "c1 c2"]);
  });

  test("a document alike to nothing never forms a block", () => {
    expect(similarityBlocks(["a", "b", "c"], () => 0)).toEqual({ blocks: [], loners: ["a", "b", "c"] });
  });

  test("shared title words count as alike when there are no meaning vectors", () => {
    expect(titleSimilarity(titleWords("Software engineering lessons"), titleWords("Software Engineering Is Becoming Factory Work"))).toBeGreaterThanOrEqual(0.45);
    expect(titleSimilarity(titleWords("Zone 2 training"), titleWords("Stripe webhooks"))).toBe(0);
    // filler words don't make documents alike
    expect(titleSimilarity(titleWords("Untitled document"), titleWords("Untitled document"))).toBe(0);
  });

  test("meaning vectors win over titles, and linked documents count as alike", () => {
    const conversations = { a: { title: "Rapamycin" }, b: { title: "mTOR dosing" }, c: { title: "Rapamycin" } };
    const unit = (values: number[]) => { const length = Math.hypot(...values); return Float32Array.from(values.map((value) => value / length)); };
    const similarity = documentSimilarity({ conversations, connections: [{ sourceId: "b", targetId: "c" }],
      vectors: new Map([["a", unit([1, 0])], ["b", unit([1, 1])]]) });
    expect(similarity("a", "b")).toBeCloseTo(Math.SQRT1_2, 5);
    expect(similarity("a", "c")).toBe(1);
    expect(similarity("b", "c")).toBe(0.6);
  });
});

describe("Map boxes by meaning", () => {
  const conversations: Record<string, Conversation> = {};
  for (const id of ids) conversations[id] = createMainConversation({ id });
  const node = (conversationId: string) => ({ conversationId, x: 0, y: 0, width: 200, height: 60 }) as ConversationGraphNodePlacement;

  test("alike documents in a box sit side by side, with space between subjects", () => {
    const { cells } = layoutFamilyTrees(ids, conversations, 0.5, { similarity: alike, aspect: 1.4 });
    const at = (id: string) => cells.get(id)!;
    const gap = (a: string, b: string) => Math.hypot(at(a).column - at(b).column, at(a).row - at(b).row);
    // each subject's documents are closer to each other than to any other subject's
    for (const [a, b] of [["a1", "a2"], ["a2", "a3"], ["b1", "b2"], ["c1", "c2"]]) {
      for (const other of ids.filter((id) => subjectOf(id) !== subjectOf(a))) expect(gap(a, b)).toBeLessThan(gap(a, other) + 1e-9);
    }
    // blocks sit apart by part of a cell, so the space between them shows
    const columns = [...cells.values()].map((cell) => cell.column);
    expect(columns.some((column) => !Number.isInteger(column))).toBe(true);
  });

  test("without a similarity, boxes keep their reading order on an even grid", () => {
    const { cells } = layoutFamilyTrees(ids, conversations, 0.5);
    expect([...cells.values()].every((cell) => Number.isInteger(cell.column) && Number.isInteger(cell.row))).toBe(true);
  });

  test("boxes take the shape that a phone or a desktop screen draws largest", () => {
    const many: Record<string, Conversation> = {};
    const groups: Record<string, ConversationGroup> = { g: { id: "g", name: "G", color: "#888", collapsed: false, conversationIds: [] } };
    for (let index = 0; index < 36; index++) { many[`d${index}`] = createMainConversation({ id: `d${index}` }); groups.g.conversationIds.push(`d${index}`); }
    const placements = Object.keys(many).map(node);
    const shape = (screenAspect: number) => {
      const [box] = layoutCanvasGroupBoxes({ nodes: placements, conversations: many, groups, screenAspect }).boxes;
      return box.width / box.height;
    };
    expect(shape(0.55)).toBeLessThan(1);
    expect(shape(1.6)).toBeGreaterThan(1.2);
  });
});
