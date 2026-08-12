import { afterEach, describe, expect, test } from "bun:test";
import { createChatService } from "../server/chat/index.mjs";
import { getDefaultModelIdForService } from "../server/lib/backendModels.mjs";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function createService() {
  return createChatService({
    database: {},
    env: {
      GEMINI_API_KEY: "gemini-test-key",
      HUGGINGFACE_API_KEY: "huggingface-test-key",
      OPENAI_API_KEY: "openai-test-key",
      XAI_API_KEY: "xai-test-key",
    },
    runtimeConfig: {
      defaultBackendProvider: "openai-api",
      geminiModel: "gemini-test-model",
      huggingFaceModel: "huggingface-test-model",
      openaiModel: "openai-test-model",
      xaiModel: "xai-test-model",
    },
  });
}

function createChatPayload(serviceId: string) {
  return {
    conversation: {
      ancestorContext: [],
      branchAnchor: null,
      id: "conversation-1",
      parentId: null,
      title: "Streaming test",
    },
    messages: [{ content: "Say hello.", role: "user" }],
    modelId: getDefaultModelIdForService(serviceId),
    serviceId,
  };
}

function sse(events: unknown[]) {
  return new Response(
    events
      .map((event) =>
        event === "[DONE]"
          ? "data: [DONE]\n\n"
          : `data: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

describe("streaming chat providers", () => {
  test("streams OpenAI Responses API deltas and final metadata", async () => {
    let requestBody: Record<string, unknown> | null = null;

    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));

      return sse([
        { delta: "Hello", type: "response.output_text.delta" },
        { delta: " world", type: "response.output_text.delta" },
        {
          response: { model: "resolved-openai-model", output: [] },
          type: "response.completed",
        },
      ]);
    }) as typeof fetch;

    const deltas: string[] = [];
    const metadata: unknown[] = [];
    const response = await createService().requestReplyStream(
      createChatPayload("openai-api"),
      {},
      {
        onDelta: (delta: string) => deltas.push(delta),
        onReady: (value: unknown) => metadata.push(value),
      },
    );

    expect(requestBody?.stream).toBe(true);
    expect(deltas).toEqual(["Hello", " world"]);
    expect(metadata).toHaveLength(1);
    expect(response.reply).toBe("Hello world");
    expect(response.metadata.model).toBe("resolved-openai-model");
  });

  test("streams Gemini and Hugging Face provider chunk formats", async () => {
    const providerResponses = [
      sse([
        { candidates: [{ content: { parts: [{ text: "Gemini" }] } }] },
        { candidates: [{ content: { parts: [{ text: " reply" }] } }] },
      ]),
      sse([
        {
          choices: [{ delta: { content: "Hugging" } }],
          model: "resolved-hf-model",
        },
        { choices: [{ delta: { content: " Face" } }] },
        "[DONE]",
      ]),
    ];

    globalThis.fetch = (async () => providerResponses.shift()!) as typeof fetch;

    const service = createService();
    const geminiDeltas: string[] = [];
    const gemini = await service.requestReplyStream(
      createChatPayload("gemini-api"),
      {},
      { onDelta: (delta: string) => geminiDeltas.push(delta) },
    );
    const huggingFaceDeltas: string[] = [];
    const huggingFace = await service.requestReplyStream(
      createChatPayload("huggingface-api"),
      {},
      { onDelta: (delta: string) => huggingFaceDeltas.push(delta) },
    );

    expect(geminiDeltas).toEqual(["Gemini", " reply"]);
    expect(gemini.reply).toBe("Gemini reply");
    expect(huggingFaceDeltas).toEqual(["Hugging", " Face"]);
    expect(huggingFace.reply).toBe("Hugging Face");
    expect(huggingFace.metadata.model).toBe("resolved-hf-model");
  });

  test("automatic routing falls back before opening the client stream", async () => {
    const urls: string[] = [];

    globalThis.fetch = (async (input) => {
      const url = String(input);
      urls.push(url);

      if (url.includes("api.openai.com")) {
        return sse([
          {
            response: { error: { message: "OpenAI unavailable." } },
            type: "response.failed",
          },
        ]);
      }

      return sse([
        { candidates: [{ content: { parts: [{ text: "Fallback worked" }] } }] },
      ]);
    }) as typeof fetch;

    const metadata: Array<{ resolvedServiceId: string }> = [];
    const response = await createService().requestReplyStream(
      createChatPayload("backend-services"),
      {},
      { onReady: (value: { resolvedServiceId: string }) => metadata.push(value) },
    );

    expect(urls).toHaveLength(2);
    expect(metadata).toEqual([
      expect.objectContaining({ resolvedServiceId: "gemini-api" }),
    ]);
    expect(response.reply).toBe("Fallback worked");
  });
});
