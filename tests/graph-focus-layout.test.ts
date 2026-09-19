import { describe, expect, test } from "bun:test";
import { resolveGraphFocusLayout } from "../client/src/lib/graphFocusLayout";
import { hasGraphNodeSpacing } from "../client/src/lib/graphAutoLayout";
import type { ConversationGraphNodePlacement } from "../client/src/lib/conversationGraph";

function node(conversationId: string, x: number, y: number, width = 200, height = 100): ConversationGraphNodePlacement {
  return { conversationId, x, y, width, height, depth: 0 };
}
function keyed(placements: ConversationGraphNodePlacement[]) {
  return Object.fromEntries(placements.map((placement) => [placement.conversationId, placement]));
}
function expectSeparated(placements: ConversationGraphNodePlacement[]) {
  for (let index = 0; index < placements.length; index += 1) {
    for (let other = index + 1; other < placements.length; other += 1) {
      expect(hasGraphNodeSpacing(placements[index], placements[other])).toBe(true);
    }
  }
}

describe("temporary focused graph layout", () => {
  test("pins the expanded selection and moves a fully contained compact card clear in one direction", () => {
    const placements = [node("selected", -200, -100, 700, 600), node("inside", 0, 70)];
    const before = structuredClone(placements);
    const result = resolveGraphFocusLayout({ placements, selectedConversationId: "selected" });
    expect(result[0]).toEqual(placements[0]);
    expect(result[1].width).toBe(200);
    expect(result[1].height).toBe(100);
    expectSeparated(result);
    expect(placements).toEqual(before);
  });
  test("propagates a collision chain without anchor drift", () => {
    const placements = [node("selected", 0, 0, 200, 500), node("first", 0, 450), node("second", 0, 610), node("third", 0, 740)];
    const result = keyed(resolveGraphFocusLayout({ placements, selectedConversationId: "selected" }));
    expect(result.selected).toEqual(placements[0]);
    expect(result.first.y).toBeGreaterThan(450);
    expect(result.second.y).toBeGreaterThan(610);
    expect(result.third.y).toBeGreaterThan(740);
    expectSeparated(Object.values(result));
  });
  test("leaves unrelated baseline overlaps untouched", () => {
    const placements = [node("selected", 0, 0, 400, 350), node("near", 250, 50), node("far-a", -9000, -5000), node("far-b", -8950, -4970)];
    const result = keyed(resolveGraphFocusLayout({ placements, selectedConversationId: "selected" }));
    expect(result["far-a"]).toEqual(placements[2]);
    expect(result["far-b"]).toEqual(placements[3]);
    expect(hasGraphNodeSpacing(result["far-a"], result["far-b"])).toBe(false);
    expect(hasGraphNodeSpacing(result.selected, result.near)).toBe(true);
  });
  test("is deterministic under input permutations and coincident positions", () => {
    const placements = [node("selected", -100, -50, 400, 300), node("z", 0, 0), node("a", 0, 0), node("b", 0, 200), node("c", 220, 0)];
    const first = resolveGraphFocusLayout({ placements, selectedConversationId: "selected" });
    const reversed = resolveGraphFocusLayout({ placements: [...placements].reverse(), selectedConversationId: "selected" });
    expect(keyed(reversed)).toEqual(keyed(first));
    expectSeparated(first);
    expect(first.map((placement) => placement.conversationId)).toEqual(placements.map((placement) => placement.conversationId));
  });
  test("does not change an already spaced layout or a missing selection", () => {
    const placements = [node("selected", -500, 50), node("other", 300, -700)];
    expect(resolveGraphFocusLayout({ placements, selectedConversationId: "selected" })).toEqual(placements);
    expect(resolveGraphFocusLayout({ placements, selectedConversationId: "missing" })).toEqual(placements);
  });
  test("bounds pair checks to local candidates in a large sparse map", () => {
    const placements = [node("selected", 0, 0, 450, 400), node("near", 260, 50),
      ...Array.from({ length: 5000 }, (_, index) => node(`far-${index}`, 5000 + (index % 100) * 1000, 5000 + Math.floor(index / 100) * 1000))];
    const work = { pairChecks: 0, movedNodes: 0 };
    const result = resolveGraphFocusLayout({ placements, selectedConversationId: "selected", work });
    expect(work.pairChecks).toBeLessThan(20);
    expect(work.movedNodes).toBe(1);
    expect(result.slice(2)).toEqual(placements.slice(2));
  });
  test("handles very large selection bounds without allocating every covered spatial cell", () => {
    const placements = [node("selected", -100000, -100000, 200000, 200000), node("contained", 30, 50)];
    const result = resolveGraphFocusLayout({ placements, selectedConversationId: "selected" });
    expectSeparated(result);
    expect(result[0]).toEqual(placements[0]);
  });
  test("respects explicit gaps and skips invalid geometry", () => {
    const placements = [node("selected", 0, 0, 300, 300), node("near", 250, 20), node("invalid", NaN, 0)];
    const result = resolveGraphFocusLayout({ placements, selectedConversationId: "selected", gapX: 80, gapY: 60 });
    expect(hasGraphNodeSpacing(result[0], result[1], 80, 60)).toBe(true);
    expect(Number.isNaN(result[2].x)).toBe(true);
  });
  test("settles dense multi-direction collision waves across offset layouts", () => {
    for (let variant = 0; variant < 8; variant += 1) {
      const placements = Array.from({ length: 25 }, (_, index) => node(`node-${index}`,
        (index % 5 - 2) * 310 + (index * 17 + variant * 13) % 25,
        (Math.floor(index / 5) - 2) * 180 + (index * 11 + variant * 7) % 20));
      const selected = placements[12];
      selected.width = 500 + variant * 29;
      selected.height = 430 + variant * 31;
      const result = resolveGraphFocusLayout({ placements, selectedConversationId: selected.conversationId });
      expect(result[12]).toEqual(selected);
      expectSeparated(result);
    }
  });
});
