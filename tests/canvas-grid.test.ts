import { describe, expect, test } from "bun:test";
import {
  buildConversationForestGraphScene,
  getUnplacedForestRootIds,
  type ConversationGraphNodePlacement,
} from "../client/src/lib/conversationGraph";
import { normalizeGraphLayouts } from "../client/src/lib/graphLayout";
import type { Conversation } from "../client/src/types";

function createConversation(
  partial: Partial<Conversation> & Pick<Conversation, "id">,
): Conversation {
  const createdAt = partial.createdAt ?? "2026-08-12T00:00:00.000Z";
  return {
    branchAnchor: null,
    childIds: [],
    createdAt,
    messages: [],
    modelId: "gpt-5",
    parentId: null,
    serviceId: "openai-api",
    title: partial.id,
    updatedAt: createdAt,
    ...partial,
  };
}

/** `count` single documents, one minute apart. */
function buildDocuments(count: number) {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => {
    const id = `doc-${String(index).padStart(4, "0")}`;
    return [id, createConversation({ id, createdAt: new Date(Date.UTC(2026, 7, 12, 0, index)).toISOString() })];
  }));
}

function overlaps(left: ConversationGraphNodePlacement, right: ConversationGraphNodePlacement) {
  return left.x < right.x + right.width && left.x + left.width > right.x
    && left.y < right.y + right.height && left.y + left.height > right.y;
}

function byId(nodes: ConversationGraphNodePlacement[]) {
  return new Map(nodes.map((node) => [node.conversationId, node]));
}

describe("Canvas grid for documents no one placed", () => {
  test("wraps saved default positions into rows about as wide as a screen", () => {
    const conversations = buildDocuments(400);
    // The positions every workspace saves for new documents: x 0, one under another.
    const treeLayouts = normalizeGraphLayouts(conversations, {});
    expect(new Set(Object.values(treeLayouts).map((layout) => layout.x))).toEqual(new Set([0]));

    const scene = buildConversationForestGraphScene({ conversations, selectedConversationId: "doc-0000", treeLayouts });
    const rows = new Set(scene.nodes.map((node) => node.y));
    const columns = new Set(scene.nodes.map((node) => node.x));

    expect(scene.nodes).toHaveLength(400);
    expect(columns.size).toBeGreaterThan(10);
    expect(rows.size).toBeLessThan(40);
    expect(scene.width / scene.height).toBeGreaterThan(1);
    expect(scene.width / scene.height).toBeLessThan(3.5);
    // Oldest first, reading left to right.
    const nodes = byId(scene.nodes);
    expect(nodes.get("doc-0000")).toMatchObject({ x: 0, y: 0 });
    expect(nodes.get("doc-0001")!.x).toBeGreaterThan(0);
    expect(nodes.get("doc-0001")!.y).toBe(0);
    for (let index = 0; index < scene.nodes.length; index++) {
      for (let other = index + 1; other < scene.nodes.length; other++) {
        expect(overlaps(scene.nodes[index], scene.nodes[other])).toBe(false);
      }
    }
  });

  test("adding a document keeps the others where they were", () => {
    const conversations = buildDocuments(60);
    const before = byId(buildConversationForestGraphScene({ conversations, selectedConversationId: "doc-0000" }).nodes);
    const added = createConversation({ id: "doc-9999", createdAt: "2026-08-13T00:00:00.000Z" });
    const after = byId(buildConversationForestGraphScene({
      conversations: { ...conversations, [added.id]: added },
      selectedConversationId: "doc-0000",
    }).nodes);

    for (const [id, placement] of before) {
      expect(after.get(id)).toMatchObject({ x: placement.x, y: placement.y });
    }
  });

  test("flows around documents someone placed", () => {
    const conversations = buildDocuments(80);
    const treeLayouts = {
      ...normalizeGraphLayouts(conversations, {}),
      // Dragged into the middle of where the grid would go.
      "doc-0079": { height: 96, positioned: true, treeOriginX: 0, treeOriginY: 0, width: 200, x: 700, y: 250 },
    };
    const scene = buildConversationForestGraphScene({ conversations, selectedConversationId: "doc-0000", treeLayouts });
    const nodes = byId(scene.nodes);
    const placed = nodes.get("doc-0079")!;

    expect(placed).toMatchObject({ x: 700, y: 250 });
    for (const node of scene.nodes) {
      if (node.conversationId !== "doc-0079") expect(overlaps(node, placed)).toBe(false);
    }
  });

  test("keeps arranged or partly moved trees at their saved spot", () => {
    const conversations: Record<string, Conversation> = {
      ...buildDocuments(12),
      parent: createConversation({ id: "parent", childIds: ["child"], createdAt: "2026-08-12T00:30:00.000Z" }),
      child: createConversation({ id: "child", parentId: "parent", createdAt: "2026-08-12T00:31:00.000Z" }),
      topic: createConversation({ id: "topic", createdAt: "2026-08-12T00:32:00.000Z" }),
    };
    const treeLayouts = {
      ...normalizeGraphLayouts(conversations, {}),
      // A child was dragged, so its tree keeps the root's saved spot.
      parent: { height: 96, width: 200, x: 0, y: 5000 },
      child: { height: 96, positioned: true, width: 200, x: 400, y: 5200 },
      // Arranged by topic: the root has its own spot.
      topic: { height: 96, width: 200, x: 3000, y: -400 },
    };
    const nodes = byId(buildConversationForestGraphScene({ conversations, selectedConversationId: "doc-0000", treeLayouts }).nodes);

    expect(nodes.get("parent")).toMatchObject({ x: 0, y: 5000 });
    expect(nodes.get("child")).toMatchObject({ x: 400, y: 5200 });
    expect(nodes.get("topic")).toMatchObject({ x: 3000, y: -400 });
    expect(nodes.get("doc-0001")!.y).toBe(0);
    // A move pins exactly the trees still in the grid.
    expect(getUnplacedForestRootIds(conversations, treeLayouts).sort()).toEqual(Object.keys(buildDocuments(12)).sort());
  });

  test("a tree pinned where the grid showed it stays there", () => {
    const conversations = buildDocuments(30);
    const shown = byId(buildConversationForestGraphScene({ conversations, selectedConversationId: "doc-0000" }).nodes).get("doc-0004")!;
    const treeLayouts = {
      ...normalizeGraphLayouts(conversations, {}),
      "doc-0004": { height: 96, width: 200, x: 0, y: 1300, treeOriginX: shown.x, treeOriginY: shown.y },
    };
    const nodes = byId(buildConversationForestGraphScene({ conversations, selectedConversationId: "doc-0000", treeLayouts }).nodes);

    expect(nodes.get("doc-0004")).toMatchObject({ x: shown.x, y: shown.y });
  });
});
