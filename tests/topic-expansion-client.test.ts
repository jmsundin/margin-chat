import { afterEach, describe, expect, test } from "bun:test";
import { requestTopicExpansion } from "../client/src/lib/topicExpansion";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const draft = { nodes: [
  { id: "one", parentId: null, title: "Feedback", content: "Draft explanation of feedback." },
  { id: "two", parentId: "one", title: "Delays", content: "Draft explanation of delays." },
] };
const request = (overrides = {}) => requestTopicExpansion({
  topic: { id: "Q1", label: "Systems", description: "" }, noteContent: "Selected note", existingTitles: [],
  expectedUserId: "owner", signal: new AbortController().signal, ...overrides,
});
const done = JSON.stringify({ type: "done", expansion: draft });

describe("topic expansion client", () => {
  test("uses the fixed authenticated endpoint and handles split stream chunks", async () => {
    const progress: string[] = [], calls: any[] = [];
    const text = `${JSON.stringify({ type: "progress", message: "Drafting…" })}\n${done}`;
    const bytes = new TextEncoder().encode(text);
    globalThis.fetch = (async (url, options) => {
      calls.push({ url, options });
      return new Response(new ReadableStream({ start(controller) {
        for (let index = 0; index < bytes.length; index += 7) controller.enqueue(bytes.slice(index, index + 7));
        controller.close();
      } }));
    }) as typeof fetch;
    expect(await request({ onProgress: (message: string) => progress.push(message), workspaceContext: "PRIVATE" })).toEqual(draft);
    expect(progress).toEqual(["Drafting…"]);
    expect(calls[0].url).toBe("/api/graph/topic");
    expect(calls[0].options.credentials).toBe("same-origin");
    expect(calls[0].options.headers["X-Margin-Vault-User"]).toBe("owner");
    expect(calls[0].options.body).not.toContain("PRIVATE");
    expect(calls[0].options.body).not.toContain("expectedUserId");
  });

  test("rejects malformed, incomplete, duplicate and oversized stream responses", async () => {
    for (const text of ["bad json\n", '{"type":"done","expansion":null}\n', done + "\n" + done, "x".repeat(100001)]) {
      globalThis.fetch = (async () => new Response(text)) as typeof fetch;
      await expect(request()).rejects.toThrow("invalid topic expansion");
    }
    globalThis.fetch = (async () => new Response('{"type":"progress","message":"Drafting…"}\n')) as typeof fetch;
    await expect(request()).rejects.toThrow("before the topic expansion was complete");
    globalThis.fetch = (async () => new Response(done)) as typeof fetch;
    await expect(request({ existingTitles: ["Feedback"] })).rejects.toThrow("invalid topic expansion");
  });

  test("retains server errors even after a done event and never returns partial success", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "Account changed." }), { status: 409 })) as typeof fetch;
    await expect(request()).rejects.toMatchObject({ statusCode: 409, message: "Account changed." });
    globalThis.fetch = (async () => new Response(done + '\n{"type":"error","statusCode":402,"error":"Usage limit reached."}\n')) as typeof fetch;
    await expect(request()).rejects.toMatchObject({ statusCode: 402, message: "Usage limit reached." });
  });

  test("cancels a stalled reader, releases its lock, and does not publish completed data after abort", async () => {
    const controller = new AbortController(); let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    globalThis.fetch = (async () => new Response(body)) as typeof fetch;
    const pending = request({ signal: controller.signal });
    await Promise.resolve(); controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(true); expect(body.locked).toBe(false);
  });
});
