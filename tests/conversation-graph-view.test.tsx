import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "../client/node_modules/react-dom/server";
import ConversationGraphView from "../client/src/components/ConversationGraphView";
import {
  buildConversationGraphScene,
  getSelectedSourceAnchorY,
} from "../client/src/lib/conversationGraph";
import type { Conversation, ThreadSummary } from "../client/src/types";

const createdAt = "2026-08-12T00:00:00.000Z";

function createConversation(
  partial: Partial<Conversation> & Pick<Conversation, "id" | "title">,
): Conversation {
  return {
    branchAnchor: null,
    childIds: [],
    createdAt,
    messages: [],
    modelId: "gpt-5",
    parentId: null,
    serviceId: "openai-api",
    updatedAt: createdAt,
    ...partial,
  };
}

const conversations: Record<string, Conversation> = {
  root: createConversation({
    childIds: ["runtime", "privacy"],
    id: "root",
    messages: [
      {
        content: "I need help choosing how to run a model locally.",
        createdAt,
        id: "root-user",
        role: "user",
      },
    ],
    title: "Local AI options",
  }),
  runtime: createConversation({
    branchAnchor: {
      createdAt,
      endOffset: 36,
      id: "runtime-anchor",
      prompt: "Which runtime should I use?",
      quote: "choose a runtime for the hardware you own",
      sourceConversationId: "root",
      sourceMessageId: "root-user",
      startOffset: 0,
    },
    childIds: ["mac"],
    id: "runtime",
    messages: [
      {
        content: "Which runtime fits my Mac?",
        createdAt,
        id: "runtime-user",
        role: "user",
      },
      {
        content: "MLX and Ollama are the most approachable options.",
        createdAt,
        id: "runtime-assistant",
        role: "assistant",
      },
    ],
    parentId: "root",
    title: "Choosing a runtime",
  }),
  privacy: createConversation({
    branchAnchor: {
      createdAt,
      endOffset: 20,
      id: "privacy-anchor",
      prompt: "What stays private?",
      quote: "run the model locally",
      sourceConversationId: "root",
      sourceMessageId: "root-user",
      startOffset: 0,
    },
    id: "privacy",
    parentId: "root",
    title: "Privacy trade-offs",
  }),
  mac: createConversation({
    branchAnchor: {
      createdAt,
      endOffset: 18,
      id: "mac-anchor",
      prompt: "Show me the setup.",
      quote: "Apple Silicon → MLX or Ollama",
      sourceConversationId: "runtime",
      sourceMessageId: "runtime-assistant",
      startOffset: 0,
    },
    id: "mac",
    parentId: "runtime",
    title: "Apple Silicon setup",
  }),
};

const threads: ThreadSummary[] = [
  {
    categoryId: "research",
    categoryLabel: "Research",
    conversationCount: 4,
    id: "root",
    preview: "Local model options",
    title: "Local AI options",
    updatedAt: createdAt,
    updatedLabel: "Today",
  },
];

describe("conversation graph view", () => {
  test("starts as a complete overview without an explicit mode switch", () => {
    const markup = renderToStaticMarkup(
      <ConversationGraphView
        activeConversationId="runtime"
        conversations={conversations}
        onActivateConversation={() => {}}
        onOpenConversation={() => {}}
        threads={threads}
      />,
    );

    expect(markup).toContain("Whole discussion");
    expect(markup).toContain("Click a chat for a preview");
    expect(markup).not.toContain("Focused neighborhood");
    expect(markup).not.toContain("Graph detail");
    expect(markup).toContain('data-conversation-id="root"');
    expect(markup).toContain('data-conversation-id="runtime"');
    expect(markup).toContain('data-conversation-id="privacy"');
    expect(markup).toContain('data-conversation-id="mac"');
    expect(markup).toContain("Apple Silicon → MLX or Ollama");
    expect(markup).toContain("Current main");
    expect(markup).toContain("choose a runtime for the hardware you own");
  });

  test("grows a selected node progressively and preserves source-aligned edges", () => {
    const previewScene = buildConversationGraphScene({
      conversations,
      detailLevel: "preview",
      mode: "overview",
      selectedConversationId: "runtime",
    });
    const readerScene = buildConversationGraphScene({
      conversations,
      detailLevel: "reader",
      mode: "overview",
      selectedConversationId: "runtime",
    });
    const previewPlacement = previewScene.nodes.find(
      (node) => node.conversationId === "runtime",
    );
    const readerPlacement = readerScene.nodes.find(
      (node) => node.conversationId === "runtime",
    );
    const previewMacEdge = previewScene.edges.find(
      (edge) => edge.childConversationId === "mac",
    );
    const readerMacEdge = readerScene.edges.find(
      (edge) => edge.childConversationId === "mac",
    );

    expect(previewPlacement?.width).toBe(330);
    expect(readerPlacement?.width).toBe(430);
    expect(readerPlacement!.height).toBeGreaterThan(previewPlacement!.height);
    expect(previewMacEdge?.startY).toBe(
      getSelectedSourceAnchorY(previewPlacement!, 0, "preview"),
    );
    expect(readerMacEdge?.startY).toBe(
      getSelectedSourceAnchorY(readerPlacement!, 0, "reader"),
    );
  });

  test("keeps sibling branches in focus and the full thread in overview", () => {
    const focusScene = buildConversationGraphScene({
      conversations,
      mode: "focus",
      selectedConversationId: "runtime",
    });
    const overviewScene = buildConversationGraphScene({
      conversations,
      mode: "overview",
      selectedConversationId: "runtime",
    });

    expect(
      focusScene.nodes.map((node) => node.conversationId).sort(),
    ).toEqual(["mac", "privacy", "root", "runtime"]);
    expect(overviewScene.nodes).toHaveLength(4);
    expect(overviewScene.edges).toHaveLength(3);
    expect(
      overviewScene.nodes.every(
        (node) => node.height >= 96 && node.width >= 200,
      ),
    ).toBe(true);
  });
});
