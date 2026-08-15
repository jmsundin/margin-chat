import { afterEach, describe, expect, test } from "bun:test";
import {
  ApiError,
  requestChatReply,
  requestChatTitle,
  requestConfirmCheckoutSession,
} from "../client/src/lib/api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function createRequestArgs(
  onDelta: (delta: string) => void,
  conversationId = "conversation-1",
) {
  return {
    conversation: {
      ancestorContext: [],
      branchAnchor: null,
      id: conversationId,
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

function controlledStreamedResponse() {
  const encoder = new TextEncoder();
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        streamController = controller;
      },
    }),
    { headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } },
  );

  return {
    close() {
      streamController.close();
    },
    response,
    write(event: Record<string, unknown>) {
      streamController.enqueue(
        encoder.encode(`${JSON.stringify(event)}\n`),
      );
    },
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

  test("reads interleaved responses for multiple conversations independently", async () => {
    const firstStream = controlledStreamedResponse();
    const secondStream = controlledStreamedResponse();
    const streams = new Map([
      ["conversation-1", firstStream],
      ["conversation-2", secondStream],
    ]);
    const requestSignals = new Map<string, AbortSignal | null | undefined>();
    const firstDeltas: string[] = [];
    const secondDeltas: string[] = [];

    globalThis.fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        conversation: { id: string };
      };
      requestSignals.set(body.conversation.id, init?.signal);
      return streams.get(body.conversation.id)!.response;
    }) as typeof fetch;

    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstReply = requestChatReply({
      ...createRequestArgs((delta) => firstDeltas.push(delta), "conversation-1"),
      signal: firstController.signal,
    });
    const secondReply = requestChatReply({
      ...createRequestArgs((delta) => secondDeltas.push(delta), "conversation-2"),
      signal: secondController.signal,
    });
    const firstMetadata = {
      model: "gpt-5.6",
      requestedServiceId: "openai-api",
      resolvedServiceId: "openai-api",
    };
    const secondMetadata = {
      model: "gemini-3.1-pro-preview",
      requestedServiceId: "gemini-api",
      resolvedServiceId: "gemini-api",
    };

    firstStream.write({ metadata: firstMetadata, type: "metadata" });
    secondStream.write({ metadata: secondMetadata, type: "metadata" });
    firstStream.write({ delta: "First ", type: "delta" });
    secondStream.write({ delta: "Second ", type: "delta" });
    secondStream.write({ delta: "done", type: "delta" });
    firstStream.write({ delta: "done", type: "delta" });
    secondStream.write({ metadata: secondMetadata, type: "done" });
    secondStream.close();
    firstStream.write({ metadata: firstMetadata, type: "done" });
    firstStream.close();

    const [firstResponse, secondResponse] = await Promise.all([
      firstReply,
      secondReply,
    ]);

    expect(firstDeltas).toEqual(["First ", "done"]);
    expect(secondDeltas).toEqual(["Second ", "done"]);
    expect(firstResponse.reply).toBe("First done");
    expect(secondResponse.reply).toBe("Second done");
    expect(requestSignals.get("conversation-1")).toBe(firstController.signal);
    expect(requestSignals.get("conversation-2")).toBe(secondController.signal);
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

  test("confirms a returned Stripe subscription session", async () => {
    let requestUrl = "";
    let requestBody: Record<string, unknown> | null = null;

    globalThis.fetch = (async (input, init) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body));
      return Response.json({ confirmed: true, status: "active" });
    }) as typeof fetch;

    const confirmation = await requestConfirmCheckoutSession("cs_test_marginchat");

    expect(requestUrl).toBe("/api/billing/checkout/confirm");
    expect(requestBody).toEqual({ sessionId: "cs_test_marginchat" });
    expect(confirmation).toEqual({ confirmed: true, status: "active" });
  });
});
