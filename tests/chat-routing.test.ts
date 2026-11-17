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
    // Exercise generation and rule fallback independently of the router API.
    autoRouter: async () => null,
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

// "The backend is temporarily overloaded. Please retry." reached the person straight from the provider.
describe("a busy provider for a model the person picked", () => {
  const overloaded = () => Response.json({ error: { message: "The backend is temporarily overloaded. Please retry." } }, { status: 503 });

  test("is asked again before anything is written, and its later answer is the reply", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls < 2 ? overloaded() : Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }] });
    }) as typeof fetch;
    const reply = await createService().requestReply(createChatPayload("openai-api"));
    expect([reply.reply, calls]).toEqual(["OK", 2]);
  }, 15000);

  test("still busy after the tries says whose service it is", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return overloaded(); }) as typeof fetch;
    const failure = await createService().requestReply(createChatPayload("openai-api")).catch((error) => error);
    expect(calls).toBe(3);
    expect(failure.statusCode).toBe(503);
    expect(failure.message).toContain("OpenAI is busy right now");
    expect(failure.message).toContain("temporarily overloaded");
  }, 15000);
});
