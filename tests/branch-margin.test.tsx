import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "../client/node_modules/react-dom/server";
import ChatPanel from "../client/src/components/ChatPanel";
import type { Conversation, MessageAnchorLink } from "../client/src/types";

describe("branch margin thread", () => {
  test("pairs an anchored source message with an explicit branch card", () => {
    const createdAt = "2026-08-12T00:00:00.000Z";
    const conversation: Conversation = {
      branchAnchor: null,
      childIds: ["branch"],
      createdAt,
      id: "root",
      messages: [
        {
          content: "Keep the source visible while exploring an idea.",
          createdAt,
          id: "message-root",
          role: "user",
        },
      ],
      modelId: "gpt-5",
      parentId: null,
      serviceId: "openai-api",
      title: "Navigation model",
      updatedAt: createdAt,
    };
    const link: MessageAnchorLink = {
      anchor: {
        createdAt,
        endOffset: 15,
        id: "anchor-branch",
        prompt: "Should the source remain beside the branch?",
        quote: "Keep the source",
        sourceConversationId: conversation.id,
        sourceMessageId: "message-root",
        startOffset: 0,
      },
      branchConversationId: "branch",
      title: "Split presentation",
    };

    const markup = renderToStaticMarkup(
      <ChatPanel
        anchorsByMessageId={{ "message-root": [link] }}
        conversation={conversation}
        draft=""
        isActive
        isSubmitting={false}
        onActivate={() => {}}
        onDraftChange={() => {}}
        onModelChange={() => {}}
        onOpenBranch={() => {}}
        onStopStreaming={() => {}}
        onStopTypewriter={() => {}}
        onSubmit={() => {}}
        onTypewriterComplete={() => {}}
        onTypewriterProgress={() => {}}
        recentModelSelections={[]}
        registerAnchorRef={() => {}}
        registerComposerSurfaceRef={() => {}}
        registerPanelRef={() => {}}
        selectionPreview={null}
        theme="dark"
        typingMessageIds={{}}
        typingProgressByMessageId={{}}
      />,
    );

    expect(markup).toContain('aria-label="Branches from this message"');
    expect(markup).toContain("Split presentation");
    expect(markup).toContain("Open branch →");
  });
});
