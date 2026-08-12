import { afterEach, describe, expect, test } from "bun:test";
import { createChatService } from "../server/chat/index.mjs";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function createChatPayload(serviceId: "backend-services" | "openai-api") {
  return {
    conversation: {
      ancestorContext: [],
      branchAnchor: null,
      id: "conversation-1",
      parentId: null,
      title: "Routing test",
    },
    messages: [{ content: "Reply with OK.", role: "user" }],
    modelId: serviceId === "backend-services" ? "smart-routing" : "gpt-5.6",
    serviceId,
  };
}

function createService() {
  return createChatService({
    database: {},
    env: {
      GEMINI_API_KEY: "gemini-test-key",
      OPENAI_API_KEY: "openai-test-key",
    },
    runtimeConfig: {
      defaultBackendProvider: "openai-api",
      geminiModel: "gemini-3.1-pro-preview",
      huggingFaceModel: "openai/gpt-oss-120b",
      openaiModel: "gpt-5.6",
      xaiModel: "grok-4.5",
    },
  });
}

describe("automatic provider routing", () => {
  test("falls through provider failures but preserves direct provider errors", async () => {
    const requestedUrls: string[] = [];

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      requestedUrls.push(url);

      if (url.includes("api.openai.com")) {
        return Response.json(
          { error: { message: "OpenAI credits are exhausted." } },
          { status: 429 },
        );
      }

      if (url.includes("generativelanguage.googleapis.com")) {
        return Response.json({
          candidates: [{ content: { parts: [{ text: "OK" }] } }],
        });
      }

      return Response.json({ error: { message: "Unexpected provider." } }, { status: 500 });
    }) as typeof fetch;

    const chatService = createService();
    const automaticReply = await chatService.requestReply(
      createChatPayload("backend-services"),
    );

    expect(automaticReply.reply).toBe("OK");
    expect(automaticReply.metadata.resolvedServiceId).toBe("gemini-api");
    expect(requestedUrls).toHaveLength(2);

    requestedUrls.length = 0;

    await expect(
      chatService.requestReply(createChatPayload("openai-api")),
    ).rejects.toMatchObject({
      message: "OpenAI credits are exhausted.",
      statusCode: 429,
    });
    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0]).toContain("api.openai.com");
  });
});
