import { afterEach, describe, expect, test } from "bun:test";
import { createChatService } from "../server/chat/index.mjs";
import { getDefaultModelIdForService } from "../server/lib/backendModels.mjs";
import { createDocumentService } from "../server/documents/index.mjs";
import { parseServerSentEvents } from "../server/chat/streaming.mjs";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function service() {
  return createChatService({
    database: {},
    env: { OPENAI_API_KEY: "openai-test", GEMINI_API_KEY: "gemini-test", XAI_API_KEY: "xai-test", HF_TOKEN: "hf-test" },
    runtimeConfig: { defaultBackendProvider: "openai-api" },
  });
}

function payload(serviceId: string) {
  return {
    conversation: { ancestorContext: [], branchAnchor: null, id: "chat", parentId: null, title: "Chat" },
    messages: [{ content: "Hello", role: "user" }],
    modelId: getDefaultModelIdForService(serviceId),
    serviceId,
  };
}

describe("provider cancellation", () => {
  test("cancellation wakes a reader waiting for its first event and releases its lock", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    const events = parseServerSentEvents(body, controller.signal);
    const pending = events.next();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });

  for (const serviceId of ["openai-api", "openai-agent", "xai-api", "gemini-api", "huggingface-api"]) {
    test(`${serviceId} aborts a pending stream and cancels its reader after the first delta`, async () => {
      const controller = new AbortController();
      let cancelled = false;
      let calls = 0;
      const event = serviceId === "gemini-api"
        ? { candidates: [{ content: { parts: [{ text: "Hello" }] } }] }
        : serviceId === "huggingface-api"
          ? { choices: [{ delta: { content: "Hello" } }] }
          : { type: "response.output_text.delta", delta: "Hello" };
      const body = new ReadableStream({
        start(stream) { stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)); },
        cancel() { cancelled = true; },
      });
      globalThis.fetch = (async (_url, init) => {
        calls += 1;
        expect(init?.signal).toBe(controller.signal);
        return new Response(body);
      }) as typeof fetch;
      await expect(service().requestReplyStream(payload(serviceId), { signal: controller.signal, userId: "owner" }, {
        onDelta: () => controller.abort(),
      })).rejects.toMatchObject({ name: "AbortError" });
      expect(cancelled).toBe(true);
      expect(body.locked).toBe(false);
      expect(calls).toBe(1);
    });

    test(`${serviceId} passes cancellation to buffered provider requests`, async () => {
      const controller = new AbortController();
      globalThis.fetch = (async (_url, init) => {
        expect(init?.signal).toBe(controller.signal);
        controller.abort();
        throw controller.signal.reason;
      }) as typeof fetch;
      await expect(service().requestReply(payload(serviceId), { signal: controller.signal, userId: "owner" }))
        .rejects.toMatchObject({ name: "AbortError" });
    });
  }

  test("automatic routing never retries an aborted request before output", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; throw new DOMException("Stopped", "AbortError"); }) as typeof fetch;
    await expect(service().requestReplyStream(payload("backend-services"))).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
    calls = 0;
    await expect(service().requestReply(payload("backend-services"))).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
  });

  test("automatic routing never retries a provider failure after output", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response('data: {"type":"response.output_text.delta","delta":"Hello"}\n\ndata: {"type":"response.failed","response":{"error":{"message":"failed"}}}\n\n');
    }) as typeof fetch;
    await expect(service().requestReplyStream(payload("backend-services"))).rejects.toThrow("failed");
    expect(calls).toBe(1);
  });

  test("retrieval embeddings receive cancellation before any chunk search", async () => {
    const controller = new AbortController();
    let searched = false;
    globalThis.fetch = (async (_url, init) => {
      expect(init?.signal).toBe(controller.signal);
      controller.abort();
      throw controller.signal.reason;
    }) as typeof fetch;
    const documents = createDocumentService({
      env: { OPENAI_API_KEY: "embedding-test" },
      database: { findRelevantDocumentChunks: async () => { searched = true; return []; } },
    });
    await expect(documents.retrieveContext({
      chatRequest: { conversation: { documents: [{ id: "doc" }] }, messages: [{ role: "user", content: "find this" }] },
      context: { signal: controller.signal, userId: "owner" },
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(searched).toBe(false);
  });
});
