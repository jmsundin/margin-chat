import { describe, expect, test } from "bun:test";
import { createChildConversation, createMainConversation } from "../client/src/initialState";
import { canvasBoxAt, canvasGroupDropChanges, canvasGroupOf, layoutCanvasGroupBoxes, layoutFamilyTrees, NO_GROUP_BOX_ID } from "../client/src/lib/canvasGroupBoxes";
import { createDefaultGraphNodeLayout, mergeGraphNodeLayouts } from "../client/src/lib/graphLayout";
import { getUnplacedForestRootIds, type ConversationGraphNodePlacement } from "../client/src/lib/conversationGraph";
import type { Conversation, ConversationGroup } from "../client/src/types";

function vault() {
  const conversations: Record<string, Conversation> = {};
  const angular = createMainConversation({ id: "angular" });
  const signals = createChildConversation({ id: "signals", parentConversation: angular });
  angular.childIds.push(signals.id);
  for (const conversation of [angular, signals, createMainConversation({ id: "weekly" }), createMainConversation({ id: "trip" }), createMainConversation({ id: "loose" })]) {
    conversations[conversation.id] = conversation;
  }
  const groups: Record<string, ConversationGroup> = {
    work: { id: "work", name: "Work", color: "#0f766e", collapsed: false, conversationIds: ["angular", "weekly"] },
    personal: { id: "personal", name: "Personal", color: "#b45309", collapsed: false, conversationIds: ["trip"] },
  };
  return { conversations, groups };
}

const node = (conversationId: string, x: number, y: number) => ({ conversationId, x, y, width: 200, height: 60 }) as ConversationGraphNodePlacement;
const nodes = [node("angular", 0, 0), node("signals", 260, 0), node("weekly", 0, 120), node("trip", 800, 0), node("loose", 0, 600)];

describe("Canvas group boxes", () => {
  test("children sit in their main document's group unless they have their own", () => {
    const { conversations, groups } = vault();
    expect(canvasGroupOf(conversations, groups, "signals")).toBe("work");
    groups.personal.conversationIds.push("signals");
    expect(canvasGroupOf(conversations, groups, "signals")).toBe("personal");
    expect(canvasGroupOf(conversations, groups, "loose")).toBeNull();
  });

  test("each group gets its own box, sized by how many documents it holds, and boxes never overlap", () => {
    const { conversations, groups } = vault();
    const { boxes, nodes: placed } = layoutCanvasGroupBoxes({ nodes, conversations, groups });
    expect(boxes.map((box) => [box.id, box.conversationIds])).toEqual([
      ["work", ["angular", "signals", "weekly"]],
      ["personal", ["trip"]],
      [NO_GROUP_BOX_ID, ["loose"]],
    ]);
    const area = (id: string) => { const box = boxes.find((item) => item.id === id)!; return box.width * box.height; };
    expect(area("work")).toBeGreaterThan(area("personal"));
    for (const [index, a] of boxes.entries()) for (const b of boxes.slice(index + 1)) {
      const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
      expect(apart).toBe(true);
    }
    // Every card sits inside its own box, and no two cards share a spot.
    for (const node of placed) {
      const box = boxes.find((item) => item.conversationIds.includes(node.conversationId))!;
      expect(node.x >= box.x && node.y >= box.y && node.x + node.width <= box.x + box.width && node.y + node.height <= box.y + box.height).toBe(true);
    }
    expect(new Set(placed.map((node) => `${node.x},${node.y}`)).size).toBe(placed.length);
    // An empty group keeps a box, so cards can be dropped into it.
    const withEmpty = { ...groups, later: { id: "later", name: "Later", color: "#555", collapsed: false, conversationIds: [] } };
    const empty = layoutCanvasGroupBoxes({ nodes, conversations, groups: withEmpty }).boxes.find((box) => box.id === "later")!;
    expect(empty.conversationIds).toEqual([]);
    expect(empty.height).toBeGreaterThan(0);
    // A child with a group of its own sits in that group's box.
    groups.personal.conversationIds.push("signals");
    expect(layoutCanvasGroupBoxes({ nodes, conversations, groups }).boxes.find((box) => box.id === "personal")?.conversationIds).toEqual(["signals", "trip"]);
  });

  test("families sit as lineage trees: children in the next column, the parent level with their middle", () => {
    const { conversations } = vault();
    const angular = conversations.angular;
    for (const id of ["routing", "forms"]) {
      const child = createChildConversation({ id, parentConversation: angular });
      angular.childIds.push(id);
      conversations[id] = child;
    }
    const grand = createChildConversation({ id: "guards", parentConversation: conversations.routing });
    conversations.routing.childIds.push("guards");
    conversations.guards = grand;
    const { cells } = layoutFamilyTrees(["angular", "signals", "routing", "guards", "forms", "weekly"], conversations);
    expect(cells.get("angular")!.column).toBe(0);
    expect(["signals", "routing", "forms"].map((id) => cells.get(id)!.column)).toEqual([1, 1, 1]);
    expect(cells.get("guards")).toEqual({ column: 2, row: cells.get("routing")!.row });
    expect(cells.get("angular")!.row).toBe((cells.get("signals")!.row + cells.get("forms")!.row) / 2);
    // The single document doesn't sit inside the tree's cells.
    const spots = [...cells.values()].map((cell) => `${cell.column},${cell.row}`);
    expect(new Set(spots).size).toBe(spots.length);
    // A child whose parent is in another box starts its own tree.
    expect(layoutFamilyTrees(["guards"], conversations).cells.get("guards")).toEqual({ column: 0, row: 0 });
  });

  test("a card dropped into another box changes its group", () => {
    const { conversations, groups } = vault();
    const { boxes } = layoutCanvasGroupBoxes({ nodes, conversations, groups });
    const personal = boxes.find((box) => box.id === "personal")!;
    expect(canvasBoxAt(boxes, { x: personal.x + 5, y: personal.y + 5 })?.id).toBe("personal");
    expect(canvasBoxAt(boxes, { x: -500, y: -500 })).toBeNull();
    expect(canvasGroupDropChanges({ ids: ["loose"], conversations, groups, target: personal })).toEqual([["loose", "personal"]]);
    const none = boxes.find((box) => box.id === NO_GROUP_BOX_ID)!;
    expect(canvasGroupDropChanges({ ids: ["weekly"], conversations, groups, target: none })).toEqual([["weekly", null]]);
    // A child that only shares its main document's group is not taken out of it.
    expect(canvasGroupDropChanges({ ids: ["signals"], conversations, groups, target: none })).toEqual([]);
    // Moving a main document with its child changes the group once, for the main document.
    expect(canvasGroupDropChanges({ ids: ["angular", "signals"], conversations, groups, target: personal })).toEqual([["angular", "personal"]]);
    // Dropping a card back into its own box changes nothing.
    expect(canvasGroupDropChanges({ ids: ["weekly"], conversations, groups, target: boxes[0] })).toEqual([]);
  });
});

describe("Undo tidy up", () => {
  test("returns never-placed documents to the Not placed yet grid", () => {
    const { conversations } = vault();
    const tidied = mergeGraphNodeLayouts(conversations, {}, { loose: { x: 400, y: 300, positioned: true } });
    expect(getUnplacedForestRootIds(conversations, tidied)).not.toContain("loose");
    const undone = mergeGraphNodeLayouts(conversations, tidied, { loose: createDefaultGraphNodeLayout() }, { replace: true });
    expect(getUnplacedForestRootIds(conversations, undone)).toContain("loose");
    // A plain update keeps the tree's origin, which is what used to pin it at the left edge.
    const merged = mergeGraphNodeLayouts(conversations, tidied, { loose: createDefaultGraphNodeLayout() });
    expect(getUnplacedForestRootIds(conversations, merged)).not.toContain("loose");
  });
});
