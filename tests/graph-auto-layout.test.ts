import { describe, expect, test } from "bun:test";
import {
  buildElkConversationGraph,
  hasGraphNodeSpacing,
  mapElkGraphToLayouts,
  resolveGraphNodeReflow,
  resolveGraphSelectionReflow,
} from "../client/src/lib/graphAutoLayout";
import type { ConversationGraphNodePlacement } from "../client/src/lib/conversationGraph";
import type { Conversation } from "../client/src/types";

const createdAt = "2026-08-14T12:00:00.000Z";

function conversation(
  id: string,
  parentId: string | null,
  childIds: string[],
): Conversation {
  return {
    branchAnchor: null,
    childIds,
    createdAt,
    id,
    kind: "chat",
    messages: [],
    modelId: "smart-routing",
    notes: [],
    parentId,
    serviceId: "backend-services",
    title: id,
    updatedAt: createdAt,
  };
}

function placement(
  conversationId: string,
  x: number,
  y: number,
): ConversationGraphNodePlacement {
  return {
    conversationId,
    depth: conversationId === "root" ? 0 : 1,
    height: 96,
    width: 200,
    x,
    y,
  };
}

const conversations = {
  root: conversation("root", null, ["peer-a", "peer-b"]),
  "peer-a": conversation("peer-a", "root", []),
  "peer-b": conversation("peer-b", "root", []),
};

describe("graph automatic layout and drag reflow", () => {
  test("configures ELK with compact peer spacing and moderate layer spacing", () => {
    const placements = [
      placement("root", 500, 500),
      placement("peer-a", 0, 0),
      placement("peer-b", 1200, 900),
    ];
    const graph = buildElkConversationGraph({
      conversations,
      placements,
    });

    expect(graph.layoutOptions).toMatchObject({
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.layered.spacing.nodeNodeBetweenLayers": "76",
      "elk.spacing.nodeNode": "34",
    });
    expect(graph.edges).toHaveLength(2);
    expect(graph.children?.map((node) => node.id)).toEqual([
      "peer-a",
      "peer-b",
      "root",
    ]);

    const mapped = mapElkGraphToLayouts({
      ...graph,
      children: graph.children?.map((node, index) => ({
        ...node,
        x: 48 + index * 276,
        y: 48 + index * 130,
      })),
    });

    expect(mapped.root).toMatchObject({ positioned: true, x: 600, y: 308 });
  });

  test("keeps the dragged node anchored while nearby nodes yield and distant nodes stay put", () => {
    const placements = [
      placement("anchor", 0, 0),
      placement("neighbor", 250, 0),
      placement("far", 1000, 700),
    ];
    const reflowed = resolveGraphNodeReflow({
      anchorConversationId: "anchor",
      placements,
      x: 220,
      y: 0,
    });
    const anchor = reflowed.find(
      (node) => node.conversationId === "anchor",
    )!;
    const neighbor = reflowed.find(
      (node) => node.conversationId === "neighbor",
    )!;
    const far = reflowed.find((node) => node.conversationId === "far")!;

    expect(anchor).toMatchObject({ x: 220, y: 0 });
    expect(neighbor).not.toMatchObject({ x: 250, y: 0 });
    expect(hasGraphNodeSpacing(anchor, neighbor)).toBe(true);
    expect(far).toMatchObject({ x: 1000, y: 700 });
  });

  test("moves a selection rigidly while unselected nodes yield", () => {
    const placements = [
      placement("selected-a", 0, 0),
      placement("selected-b", 0, 160),
      placement("neighbor", 300, 0),
      placement("far", 1000, 700),
    ];
    const reflowed = resolveGraphSelectionReflow({
      conversationIds: ["selected-a", "selected-b"],
      deltaX: 250,
      deltaY: 40,
      placements,
    });
    const selectedA = reflowed.find(
      (node) => node.conversationId === "selected-a",
    )!;
    const selectedB = reflowed.find(
      (node) => node.conversationId === "selected-b",
    )!;
    const neighbor = reflowed.find(
      (node) => node.conversationId === "neighbor",
    )!;
    const far = reflowed.find((node) => node.conversationId === "far")!;

    expect(selectedA).toMatchObject({ x: 250, y: 40 });
    expect(selectedB).toMatchObject({ x: 250, y: 200 });
    expect(neighbor).not.toMatchObject({ x: 300, y: 0 });
    expect(hasGraphNodeSpacing(selectedA, neighbor)).toBe(true);
    expect(far).toMatchObject({ x: 1000, y: 700 });
  });
});
