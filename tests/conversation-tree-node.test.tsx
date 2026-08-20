import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "../client/node_modules/react-dom/server";
import ConversationTreeNode from "../client/src/components/ConversationTreeNode";
import type { Conversation } from "../client/src/types";

describe("conversation tree node", () => {
  test("presents a child chat as an expandable context bubble", () => {
    const createdAt = "2026-08-12T00:00:00.000Z";
    const conversation: Conversation = {
      branchAnchor: {
        createdAt,
        endOffset: 28,
        id: "anchor-child",
        prompt: "Compare the available approaches.",
        quote: "the selected source context",
        sourceConversationId: "root",
        sourceMessageId: "message-root",
        startOffset: 0,
      },
      childIds: ["grandchild"],
      createdAt,
      id: "child",
      messages: [
        {
          content: "Compare the available approaches.",
          createdAt,
          id: "message-child",
          role: "user",
        },
      ],
      modelId: "gpt-5",
      parentId: "root",
      serviceId: "openai-api",
      title: "Approach comparison",
      updatedAt: createdAt,
    };

    const markup = renderToStaticMarkup(
      <ConversationTreeNode
        conversation={conversation}
        onExpand={() => {}}
        registerNodeRef={() => {}}
      />,
    );

    expect(markup).toContain('aria-label="Expand Approach comparison"');
    expect(markup).toContain("Margin Chat");
    expect(markup).not.toContain("Child chat");
    expect(markup).toContain("the selected source context");
    expect(markup).toContain("1 message");
    expect(markup).toContain("1 child");
  });
});
