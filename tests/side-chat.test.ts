import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CHILD_CHAT_TITLE,
  DEFAULT_SIDE_CHAT_TITLE,
  createChildConversation,
  createEmptyState,
  createMainConversation,
  createSideConversation,
} from "../client/src/initialState";
import { normalizeAppState } from "../server/db/validation.mjs";

describe("side chats", () => {
  test("creates a direct child of a main chat without a text anchor", () => {
    const root = createMainConversation({ id: "root" });
    const side = createSideConversation({
      createdAt: "2026-08-13T12:00:00.000Z",
      id: "side",
      sourceConversation: root,
    });

    expect(side.parentId).toBe("root");
    expect(side.branchAnchor).toBeNull();
    expect(side.messages).toEqual([]);
    expect(side.title).toBe(DEFAULT_SIDE_CHAT_TITLE);
    expect(side.modelId).toBe(root.modelId);
    expect(side.serviceId).toBe(root.serviceId);
  });

  test("creates a peer beside a branch by reusing its parent", () => {
    const root = createMainConversation({ id: "root" });
    const branch = createSideConversation({
      id: "branch",
      sourceConversation: root,
    });
    const peer = createSideConversation({
      id: "peer",
      sourceConversation: branch,
    });

    expect(peer.parentId).toBe("root");
    expect(peer.branchAnchor).toBeNull();
  });

  test("creates a direct child from any graph node", () => {
    const root = createMainConversation({ id: "root" });
    const branch = createSideConversation({
      id: "branch",
      sourceConversation: root,
    });
    const child = createChildConversation({
      id: "child",
      parentConversation: branch,
    });

    expect(child.parentId).toBe("branch");
    expect(child.branchAnchor).toBeNull();
    expect(child.messages).toEqual([]);
    expect(child.title).toBe(DEFAULT_CHILD_CHAT_TITLE);
    expect(child.modelId).toBe(branch.modelId);
    expect(child.serviceId).toBe(branch.serviceId);
  });

  test("allows an unanchored child chat in cloud workspace state", () => {
    const state = createEmptyState();
    const root = state.conversations[state.rootId];
    const child = createChildConversation({
      id: "conversation-unanchored-child",
      parentConversation: root,
    });
    const normalized = normalizeAppState({
      ...state,
      activeConversationId: child.id,
      conversations: {
        ...state.conversations,
        [root.id]: {
          ...root,
          childIds: [child.id],
        },
        [child.id]: child,
      },
    });

    expect(
      normalized.conversations.find(
        (conversation) => conversation.id === child.id,
      )?.branchAnchor,
    ).toBeNull();
  });
});
