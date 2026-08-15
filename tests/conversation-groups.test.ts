import { describe, expect, test } from "bun:test";
import {
  assignConversationToGroup,
  getConversationGroupId,
  normalizeConversationGroups,
} from "../client/src/lib/conversationGroups";
import type { Conversation } from "../client/src/types";
import { normalizeAppState } from "../server/db/validation.mjs";

const createdAt = "2026-08-14T00:00:00.000Z";
const conversations: Record<string, Conversation> = Object.fromEntries(
  ["root", "child"].map((id) => [
    id,
    {
      branchAnchor: null,
      childIds: id === "root" ? ["child"] : [],
      createdAt,
      id,
      messages: [],
      modelId: "smart-routing",
      notes: [],
      parentId: id === "root" ? null : "root",
      serviceId: "backend-services",
      title: id,
      updatedAt: createdAt,
    },
  ]),
);

describe("conversation groups", () => {
  test("keeps one primary group for each conversation", () => {
    const groups = normalizeConversationGroups(
      {
        first: {
          collapsed: false,
          color: "#4fbf9f",
          conversationIds: ["root"],
          id: "first",
          name: "First",
        },
        second: {
          collapsed: false,
          color: "#6f88ff",
          conversationIds: ["root", "child"],
          id: "second",
          name: "Second",
        },
      },
      conversations,
    );

    expect(groups.first.conversationIds).toEqual(["root"]);
    expect(groups.second.conversationIds).toEqual(["child"]);
  });

  test("moves a conversation between groups without duplicating it", () => {
    const groups = {
      first: {
        collapsed: false,
        color: "#4fbf9f",
        conversationIds: ["root"],
        id: "first",
        name: "First",
      },
      second: {
        collapsed: false,
        color: "#6f88ff",
        conversationIds: [] as string[],
        id: "second",
        name: "Second",
      },
    };
    const moved = assignConversationToGroup(groups, "root", "second");

    expect(getConversationGroupId(moved, "root")).toBe("second");
    expect(moved.first.conversationIds).toEqual([]);
  });

  test("normalizes groups as part of server-persisted app state", () => {
    const state = normalizeAppState({
      activeConversationId: "root",
      conversations: { root: conversations.root },
      defaultModelId: "smart-routing",
      defaultServiceId: "backend-services",
      graphLayouts: {},
      groups: {
        research: {
          collapsed: true,
          color: "#4FBF9F",
          conversationIds: ["root"],
          id: "research",
          name: " Research ",
        },
      },
      pinnedThreadIds: [],
      railOpen: false,
      rootId: "root",
    });

    expect(state.groups.research).toEqual({
      collapsed: true,
      color: "#4fbf9f",
      conversationIds: ["root"],
      id: "research",
      name: "Research",
    });
  });
});
