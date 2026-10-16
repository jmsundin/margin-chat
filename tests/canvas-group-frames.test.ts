import { describe, expect, test } from "bun:test";
import { createChildConversation, createMainConversation } from "../client/src/initialState";
import { buildCanvasGroupFrames, canvasFrameAt, canvasGroupBuckets, canvasGroupDropChanges, canvasGroupOf, NOT_PLACED_FRAME_ID } from "../client/src/lib/canvasGroupFrames";
import { buildCategoryOrganizedGraphLayouts } from "../client/src/lib/graphCategories";
import type { ConversationGraphNodePlacement } from "../client/src/lib/conversationGraph";
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

describe("Canvas group frames", () => {
  test("children sit in their main document's group unless they have their own", () => {
    const { conversations, groups } = vault();
    expect(canvasGroupOf(conversations, groups, "signals")).toBe("work");
    groups.personal.conversationIds.push("signals");
    expect(canvasGroupOf(conversations, groups, "signals")).toBe("personal");
    expect(canvasGroupOf(conversations, groups, "loose")).toBeNull();
  });

  test("each group becomes a frame, and never-placed documents get a Not placed yet frame once something is placed", () => {
    const { conversations, groups } = vault();
    const frames = buildCanvasGroupFrames({ nodes, conversations, groups, unplacedRootIds: ["loose"] });
    expect(frames.map((frame) => [frame.id, frame.nodes.map((item) => item.conversationId)])).toEqual([
      ["work", ["angular", "signals", "weekly"]],
      ["personal", ["trip"]],
      [NOT_PLACED_FRAME_ID, ["loose"]],
    ]);
    const fresh = buildCanvasGroupFrames({ nodes, conversations, groups: {}, unplacedRootIds: Object.keys(conversations) });
    expect(fresh).toEqual([]);
  });

  test("a dropped card joins the frame it lands in, or leaves its group outside every frame", () => {
    const { conversations, groups } = vault();
    const frames = buildCanvasGroupFrames({ nodes, conversations, groups, unplacedRootIds: ["loose"] });
    const personal = canvasFrameAt(frames, { x: 900, y: 30 }, 1, new Set(["loose"]));
    expect(personal?.id).toBe("personal");
    expect(canvasGroupDropChanges({ ids: ["loose"], conversations, groups, target: personal })).toEqual([["loose", "personal"]]);
    const nowhere = canvasFrameAt(frames, { x: 2000, y: 2000 }, 1, new Set(["weekly"]));
    expect(nowhere).toBeNull();
    expect(canvasGroupDropChanges({ ids: ["weekly"], conversations, groups, target: nowhere })).toEqual([["weekly", null]]);
    // A group of one keeps its card when the card is nudged, and loses it when moved well away.
    expect(canvasFrameAt(frames, { x: 950, y: 60 }, 1, new Set(["trip"]))?.id).toBe("personal");
    expect(canvasFrameAt(frames, { x: 1400, y: 60 }, 1, new Set(["trip"]))).toBeNull();
    // A child that only shares its main document's group is not taken out of it.
    expect(canvasGroupDropChanges({ ids: ["signals"], conversations, groups, target: null })).toEqual([]);
    // Moving a main document with its child changes the group once, for the main document.
    expect(canvasGroupDropChanges({ ids: ["angular", "signals"], conversations, groups, target: personal })).toEqual([["angular", "personal"]]);
    // Dropping into the Not placed yet frame counts as no group.
    const waiting = frames.find((frame) => frame.id === NOT_PLACED_FRAME_ID)!;
    expect(canvasGroupDropChanges({ ids: ["trip"], conversations, groups, target: waiting })).toEqual([["trip", null]]);
  });

  test("Gather groups puts each group's documents together", () => {
    const { conversations, groups } = vault();
    const buckets = canvasGroupBuckets(conversations, groups);
    expect(buckets).toEqual([["angular", "weekly"], ["trip"], ["loose"]]);
    const layouts = buildCategoryOrganizedGraphLayouts({ conversations, graphLayouts: {}, threads: [], buckets });
    const x = (id: string) => layouts[id].x;
    expect(x("angular")).toBe(x("weekly"));
    expect(x("trip")).not.toBe(x("angular"));
    // A child moves with its main document; both started at the same spot here.
    expect(x("signals")).toBe(x("angular"));
  });
});
