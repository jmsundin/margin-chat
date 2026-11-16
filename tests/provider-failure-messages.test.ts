import { afterEach, describe, expect, test } from "bun:test";
import { extractApiErrorMessage, requestMetaResponseStream, requestResponsesApiStream } from "../server/chat/providers.mjs";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function stream(events: unknown[]) {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  globalThis.fetch = (async () => new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } })) as unknown as typeof fetch;
}
const META = "https://api.meta.ai/v1/responses";
const call = () => requestResponsesApiStream({ apiKey: "k", body: { model: "muse-wonder-1.0", input: "hi" }, fallbackError: "meta request failed.", url: META }).catch((error) => error);

// "meta request failed." after Ask AI in a note beside a game: Muse Wonder's failures said nothing about why.
describe("Muse Wonder failures say why", () => {
  test("an answer that spent its output limit reasoning says so", async () => {
    stream([{ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] } }]);
    const failure = await call();
    expect(failure.statusCode).toBe(502);
    expect(failure.message).toContain("output limit");
    expect(failure.message).not.toBe("meta request failed.");
  });

  test("an answer cut short after it started writing is kept", async () => {
    stream([
      { type: "response.output_text.delta", delta: "Half an " },
      { type: "response.output_text.delta", delta: "answer" },
      { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
        output: [{ type: "message", content: [{ type: "output_text", text: "Half an answer" }] }] } },
    ]);
    const result = await call();
    expect(result.reply).toBe("Half an answer");
  });

  test("a failed response without a message names the model and its code", async () => {
    stream([{ type: "response.failed", response: { status: "failed", error: { code: "server_error" } } }]);
    const failure = await call();
    expect(failure.message).toContain("Muse Wonder");
    expect(failure.message).toContain("server_error");
  });

  test("a failed response with a message passes it on", async () => {
    stream([{ type: "response.failed", response: { status: "failed", error: { code: "x", message: "Context too long" } } }]);
    expect((await call()).message).toBe("Context too long");
  });

  test("an HTTP error with an empty body carries its status", async () => {
    globalThis.fetch = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    const failure = await call();
    expect(failure.statusCode).toBe(503);
    expect(failure.message).toBe("meta request failed (HTTP 503).");
  });

  test("an error body in { detail } form is read", () => {
    expect(extractApiErrorMessage({ detail: "Input contains unsupported characters" })).toBe("Input contains unsupported characters");
    expect(extractApiErrorMessage({ detail: [{ msg: "field required" }] })).toBe("field required");
  });

  test("a plain Muse Wonder answer asks for the mode's reasoning effort", async () => {
    let sent: { reasoning?: { effort?: string } } = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hi" })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [] } })}\n\n`,
        { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const result = await requestMetaResponseStream({ apiKey: "k", model: "muse-wonder-1.0", systemInstruction: "s", maxOutputTokens: 8000,
      chatRequest: { ai: { mode: "fast" }, messages: [{ role: "user", content: "hi" }] } });
    expect(result.reply).toBe("Hi");
    expect(sent.reasoning?.effort).toBe("low");
  });
});
