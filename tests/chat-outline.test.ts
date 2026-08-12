import { describe, expect, test } from "bun:test";
import { buildChatOutline } from "../client/src/lib/chatOutline";
import type { Conversation } from "../client/src/types";

function createConversation(): Conversation {
  const createdAt = "2026-08-12T00:00:00.000Z";

  return {
    branchAnchor: null,
    childIds: [],
    createdAt,
    id: "conversation",
    messages: [
      {
        content: "How should we launch the new workspace?",
        createdAt,
        id: "user-1",
        role: "user",
      },
      {
        content: "# Launch plan\nIntro.\n## First week\nDetails.",
        createdAt,
        id: "assistant-1",
        role: "assistant",
      },
    ],
    modelId: "gpt-5",
    parentId: null,
    serviceId: "openai-api",
    title: "Launch planning",
    updatedAt: createdAt,
  };
}

describe("chat outline", () => {
  test("uses user turns as sections and nests assistant headings", () => {
    expect(buildChatOutline(createConversation())).toEqual([
      {
        id: "message-user-1",
        kind: "prompt",
        label: "How should we launch the new workspace?",
        level: 0,
        messageId: "user-1",
      },
      {
        id: "heading-assistant-1-0",
        kind: "heading",
        label: "Launch plan",
        level: 1,
        messageId: "assistant-1",
      },
      {
        id: "heading-assistant-1-1",
        kind: "heading",
        label: "First week",
        level: 2,
        messageId: "assistant-1",
      },
    ]);
  });
});
