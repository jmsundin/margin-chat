import { describe, expect, test } from "bun:test";
import { createMainConversation } from "../client/src/initialState";
import { canvasTopicDropMoves, layoutCanvasGroupBoxes, NO_GROUP_BOX_ID, topicCanvasGroups, type CanvasTopic } from "../client/src/lib/canvasGroupBoxes";
import { planCollapsedLabels } from "../client/src/components/CanvasGroupBoxes";
import type { ConversationGraphNodePlacement } from "../client/src/lib/conversationGraph";
import type { Conversation } from "../client/src/types";

const topics: CanvasTopic[] = [
  { id: "c-graph", label: "Graph algorithms", color: "hsl(350 58% 52%)", hubId: "graph", memberIds: ["graph", "dijkstra", "flow"] },
  { id: "c-angular", label: "Angular", color: "hsl(190 58% 52%)", hubId: "angular", memberIds: ["angular", "signals"] },
  { id: "c-unlinked", label: "Unlinked", color: "var(--muted)", hubId: null, memberIds: ["loose", "trip"] },
];

describe("Map grouped by topic", () => {
  test("each topic with a hub becomes a box in name order; unfiled documents are left for the Unfiled box", () => {
    const groups = topicCanvasGroups(topics);
    expect(Object.values(groups).map((group) => group.name)).toEqual(["Angular", "Graph algorithms"]);
    expect(groups["c-graph"].conversationIds).toEqual(["graph", "dijkstra", "flow"]);

    const conversations: Record<string, Conversation> = {};
    for (const id of ["graph", "dijkstra", "flow", "angular", "signals", "loose", "trip"]) conversations[id] = createMainConversation({ id });
    const nodes = Object.keys(conversations).map((conversationId, index) => ({ conversationId, x: index * 10, y: 0, width: 200, height: 60 }) as ConversationGraphNodePlacement);
    const { boxes } = layoutCanvasGroupBoxes({ nodes, conversations, groups, noGroupLabel: "Unfiled" });
    expect(boxes.map((box) => box.label)).toEqual(["Angular", "Graph algorithms", "Unfiled"]);
    expect(boxes.find((box) => box.id === NO_GROUP_BOX_ID)!.conversationIds.sort()).toEqual(["loose", "trip"]);
  });

  test("dropping cards into another topic files them under that topic's hub", () => {
    expect(canvasTopicDropMoves({ ids: ["dijkstra"], topics, target: { id: "c-angular", kind: "group" } })).toEqual([["dijkstra", "angular"]]);
    // Moving the hub itself ties it to a member that stays.
    expect(canvasTopicDropMoves({ ids: ["angular", "graph"], topics, target: { id: "c-angular", kind: "group" } })).toEqual([["graph", "signals"]]);
  });

  test("dropping into the box a card is already in, or into Unfiled, changes nothing", () => {
    expect(canvasTopicDropMoves({ ids: ["signals"], topics, target: { id: "c-angular", kind: "group" } })).toEqual([]);
    expect(canvasTopicDropMoves({ ids: ["dijkstra"], topics, target: { id: NO_GROUP_BOX_ID, kind: "none" } })).toEqual([]);
  });

  test("zoomed out, names are never cut short, and a name that would cover a bigger box's name is left off", () => {
    const box = (id: string, label: string, x: number, count: number) => ({ id, label, color: "red", kind: "group" as const, x, y: 0, width: 300, height: 200,
      conversationIds: Array.from({ length: count }, (_, index) => `${id}-${index}`) });
    const boxes = [box("a", "Organ engineering", 0, 9), box("b", "Map writing", 360, 3), box("c", "Angular", 2000, 5)];
    // Far out, the first two boxes sit nearly on top of each other on screen.
    const far = planCollapsedLabels(boxes, { x: 0, y: 0, scale: 0.1 });
    expect(far.get("a")).not.toBeNull();
    expect(far.get("a")!.width).toBeGreaterThan(300 * 0.1);
    expect(far.get("b")).toBeNull();
    expect(far.get("c")).not.toBeNull();
    // Closer in, there's room for every name.
    const near = planCollapsedLabels(boxes, { x: 0, y: 0, scale: 0.5 });
    expect([...near.values()].every(Boolean)).toBe(true);
  });
});
