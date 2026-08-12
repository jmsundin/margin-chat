import { describe, expect, test } from "bun:test";
import type { Conversation } from "../client/src/types";
import {
  getBranchNavigation,
  getConversationTreeLanes,
  getConversationTraversalCandidates,
  getConversationTraversalOrder,
} from "../client/src/lib/tree";

function conversation(
  id: string,
  parentId: string | null,
  childIds: string[],
  createdAt: string,
): Conversation {
  return {
    branchAnchor: parentId
      ? {
          createdAt,
          endOffset: 4,
          id: `anchor-${id}`,
          prompt: `Prompt ${id}`,
          quote: "text",
          sourceConversationId: parentId,
          sourceMessageId: `message-${parentId}`,
          startOffset: 0,
        }
      : null,
    childIds,
    createdAt,
    id,
    messages: [],
    modelId: "gpt-4.1-mini",
    parentId,
    serviceId: "openai-api",
    title: id,
    updatedAt: createdAt,
  };
}

describe("getBranchNavigation", () => {
  const conversations = {
    root: conversation("root", null, ["branch-b", "branch-a"], "2026-01-01"),
    "branch-a": conversation(
      "branch-a",
      "root",
      ["leaf"],
      "2026-01-02",
    ),
    "branch-b": conversation("branch-b", "root", [], "2026-01-03"),
    leaf: conversation("leaf", "branch-a", [], "2026-01-04"),
  };

  test("returns the full path, parent, siblings, and children", () => {
    const navigation = getBranchNavigation(conversations, "branch-a");

    expect(navigation.path.map(({ id }) => id)).toEqual(["root", "branch-a"]);
    expect(navigation.parent?.id).toBe("root");
    expect(navigation.siblings.map(({ id }) => id)).toEqual(["branch-b"]);
    expect(navigation.children.map(({ id }) => id)).toEqual(["leaf"]);
  });

  test("keeps leaf ancestry even when there are no children", () => {
    const navigation = getBranchNavigation(conversations, "leaf");

    expect(navigation.path.map(({ id }) => id)).toEqual([
      "root",
      "branch-a",
      "leaf",
    ]);
    expect(navigation.children).toEqual([]);
    expect(navigation.parent?.id).toBe("branch-a");
  });
});

describe("getConversationTraversalCandidates", () => {
  const conversations = {
    root: conversation(
      "root",
      null,
      ["branch-a", "branch-b", "branch-c"],
      "2026-01-01",
    ),
    "branch-a": conversation("branch-a", "root", [], "2026-01-02"),
    "branch-b": conversation(
      "branch-b",
      "root",
      ["leaf-a", "leaf-b"],
      "2026-01-03",
    ),
    "branch-c": conversation("branch-c", "root", [], "2026-01-04"),
    "leaf-a": conversation("leaf-a", "branch-b", [], "2026-01-05"),
    "leaf-b": conversation("leaf-b", "branch-b", [], "2026-01-06"),
  };

  test("offers children and later peers to the right", () => {
    expect(
      getConversationTraversalCandidates(
        conversations,
        "branch-b",
        "right",
      ).map(({ id }) => id),
    ).toEqual(["leaf-a", "leaf-b", "branch-c"]);
  });

  test("offers earlier peers and then the parent to the left", () => {
    expect(
      getConversationTraversalCandidates(
        conversations,
        "branch-b",
        "left",
      ).map(({ id }) => id),
    ).toEqual(["branch-a", "root"]);
  });

  test("stops at an outer edge", () => {
    expect(
      getConversationTraversalCandidates(conversations, "root", "left"),
    ).toEqual([]);
  });
});

describe("getConversationTraversalOrder", () => {
  test("keeps peer chats adjacent in a stable breadth-first strip", () => {
    const conversations = {
      root: conversation(
        "root",
        null,
        ["branch-b", "branch-a"],
        "2026-01-01",
      ),
      "branch-a": conversation(
        "branch-a",
        "root",
        ["leaf"],
        "2026-01-02",
      ),
      "branch-b": conversation("branch-b", "root", [], "2026-01-03"),
      leaf: conversation("leaf", "branch-a", [], "2026-01-04"),
    };

    expect(
      getConversationTraversalOrder(conversations, "root").map(({ id }) => id),
    ).toEqual(["root", "branch-a", "branch-b", "leaf"]);
  });
});

describe("getConversationTreeLanes", () => {
  test("builds one sibling lane per expanded depth and places the selection first", () => {
    const conversations = {
      root: conversation(
        "root",
        null,
        ["branch-a", "branch-b"],
        "2026-01-01",
      ),
      "branch-a": conversation("branch-a", "root", [], "2026-01-02"),
      "branch-b": conversation(
        "branch-b",
        "root",
        ["leaf-a", "leaf-b"],
        "2026-01-03",
      ),
      "leaf-a": conversation("leaf-a", "branch-b", [], "2026-01-04"),
      "leaf-b": conversation("leaf-b", "branch-b", [], "2026-01-05"),
    };

    expect(getConversationTreeLanes(conversations, "leaf-b")).toEqual([
      {
        conversationIds: ["branch-b", "branch-a"],
        parentId: "root",
        selectedConversationId: "branch-b",
      },
      {
        conversationIds: ["leaf-b", "leaf-a"],
        parentId: "branch-b",
        selectedConversationId: "leaf-b",
      },
    ]);
  });

  test("shows compact children for the current leaf of the expanded path", () => {
    const conversations = {
      root: conversation("root", null, ["branch"], "2026-01-01"),
      branch: conversation(
        "branch",
        "root",
        ["leaf"],
        "2026-01-02",
      ),
      leaf: conversation("leaf", "branch", [], "2026-01-03"),
    };

    expect(getConversationTreeLanes(conversations, "branch").at(-1)).toEqual({
      conversationIds: ["leaf"],
      parentId: "branch",
      selectedConversationId: null,
    });
  });
});
