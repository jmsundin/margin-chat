import { describe, expect, test } from "bun:test";
import { buildSystemInstruction } from "../server/chat/systemPrompt.mjs";
import { validateChatRequest } from "../server/chat/validation.mjs";

describe("branch context", () => {
  test("validates and includes inherited ancestor messages", () => {
    const request = validateChatRequest({
      conversation: {
        ancestorContext: [
          {
            branchAnchor: null,
            id: "root",
            messages: [
              { content: "We are planning a launch.", role: "user" },
              { content: "Start with the onboarding flow.", role: "assistant" },
            ],
            title: "Launch plan",
          },
        ],
        branchAnchor: {
          prompt: "List the risks.",
          quote: "Start with the onboarding flow.",
        },
        id: "branch",
        parentId: "root",
        title: "Launch risks",
      },
      messages: [{ content: "List the risks.", role: "user" }],
      modelId: "smart-routing",
      serviceId: "backend-services",
    });
    const instruction = buildSystemInstruction(request);

    expect(request.conversation.ancestorContext).toHaveLength(1);
    expect(instruction).toContain("Conversation: Launch plan");
    expect(instruction).toContain("user: We are planning a launch.");
    expect(instruction).toContain("assistant: Start with the onboarding flow.");
  });
});
