import { afterEach, describe, expect, test } from "bun:test";
import {
  ApiError,
  requestChatReply,
  requestChatTitle,
} from "../client/src/lib/api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function createRequestArgs(onDelta: (delta: string) => void) {
  return {
    conversation: {
      ancestorContext: [],
      branchAnchor: null,
      id: "conversation-1",
      parentId: null,
      title: "Client stream test",
    },
    messages: [
      {
        content: "Say hello.",
        createdAt: new Date().toISOString(),
        id: "message-1",
        role: "user" as const,
      },
    ],
    modelId: "gpt-5.6",
    onDelta,
    serviceId: "openai-api" as const,
  };
}

function streamedResponse(lines: string[], splitAt: number[]) {
  const encoded = new TextEncoder().encode(`${lines.join("\n")}\n`);
  const chunks: Uint8Array[] = [];
  let start = 0;

  for (const end of [...splitAt, encoded.length]) {
    chunks.push(encoded.slice(start, end));
    start = end;
  }

  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }

        controller.close();
      },
    }),
    { headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } },
  );
}

describe("client chat stream", () => {
  test("parses fragmented NDJSON events without losing multibyte text", async () => {
    const metadata = {
      model: "gpt-5.6",
      requestedServiceId: "openai-api",
      resolvedServiceId: "openai-api",
    };
    const lines = [
      JSON.stringify({ metadata, type: "metadata" }),
      JSON.stringify({ delta: "Hello ", type: "delta" }),
      JSON.stringify({ delta: "🌍", type: "delta" }),
      JSON.stringify({ metadata, type: "done" }),
    ];
    const deltas: string[] = [];

    globalThis.fetch = (async () =>
      streamedResponse(lines, [3, 17, 61, 109])) as typeof fetch;

    const response = await requestChatReply(createRequestArgs((delta) => {
      deltas.push(delta);
    }));

    expect(deltas).toEqual(["Hello ", "🌍"]);
    expect(response.reply).toBe("Hello 🌍");
    expect(response.metadata.resolvedServiceId).toBe("openai-api");
  });

  test("surfaces an error sent after streaming has begun", async () => {
    const metadata = {
      model: "gpt-5.6",
      requestedServiceId: "openai-api",
      resolvedServiceId: "openai-api",
    };

    globalThis.fetch = (async () =>
      streamedResponse(
        [
          JSON.stringify({ metadata, type: "metadata" }),
          JSON.stringify({ delta: "Partial", type: "delta" }),
          JSON.stringify({
            error: "Provider disconnected.",
            statusCode: 502,
            type: "error",
          }),
        ],
        [8, 35],
      )) as typeof fetch;

    await expect(
      requestChatReply(createRequestArgs(() => undefined)),
    ).rejects.toEqual(
      expect.objectContaining<ApiError>({
        message: "Provider disconnected.",
        statusCode: 502,
      }),
    );
  });

  test("requests a semantic title independently from the chat stream", async () => {
    let requestBody: Record<string, unknown> | null = null;

    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({ title: "Postgres Hosting Tradeoffs" });
    }) as typeof fetch;

    const title = await requestChatTitle({
      modelId: "gpt-5.6",
      prompt: "Should I use Neon or host Postgres myself?",
      serviceId: "openai-api",
    });

    expect(title).toBe("Postgres Hosting Tradeoffs");
    expect(requestBody).toEqual({
      modelId: "gpt-5.6",
      prompt: "Should I use Neon or host Postgres myself?",
      serviceId: "openai-api",
    });
  });
});
