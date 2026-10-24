import { afterEach, expect, test } from "bun:test";
import { readChatReplyStream } from "../client/src/lib/chatStream";
import { createGuestTransport, guestChatPrompt, isGuestPath, ON_DEVICE_MODEL_LABEL } from "../client/src/lib/guestMode";
import { fitOnDevicePrompt, onDeviceStatus, resetOnDeviceSessionForTests, type LanguageModelApi } from "../client/src/lib/onDeviceAI";

afterEach(resetOnDeviceSessionForTests);

function fakeModel(availability: string, chunks: string[] = []) {
  const prompts: string[] = [];
  const api: LanguageModelApi = {
    availability: async () => availability,
    create: async () => ({
      promptStreaming(input: string) {
        prompts.push(input);
        const parts = [...chunks];
        return new ReadableStream<string>({ pull(controller) { const part = parts.shift(); if (part === undefined) controller.close(); else controller.enqueue(part); } });
      },
      destroy() {},
    }),
  };
  return { api, prompts };
}

const chatRequest = (body: unknown) => ({ method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

test("the trial lives at /try", () => {
  expect(isGuestPath("/try")).toBe(true);
  expect(isGuestPath("/try/")).toBe(true);
  expect(isGuestPath("/")).toBe(false);
  expect(isGuestPath("/trying")).toBe(false);
});

test("Ask AI streams from Chrome's on-device model in the server's reply format", async () => {
  const { api, prompts } = fakeModel("available", ["Cells fix ", "their DNA."]);
  const response = await createGuestTransport({ api }).fetch("/api/chat", chatRequest({
    serviceId: "backend-services", modelId: "auto",
    messages: [{ role: "user", content: "Help write this editable document.\n\nUser request:\n\nExplain DNA repair" }],
    conversation: { title: "Notes", branchAnchor: { quote: "DNA repair" }, ancestorContext: [] },
  }));
  expect(response.headers.get("content-type")).toContain("application/x-ndjson");
  const deltas: string[] = [];
  const reply = await readChatReplyStream(response.body!, (delta) => deltas.push(delta));
  expect(reply.reply).toBe("Cells fix their DNA.");
  expect(reply.metadata.model).toBe(ON_DEVICE_MODEL_LABEL);
  expect(deltas).toEqual(["Cells fix ", "their DNA."]);
  expect(prompts[0]).toContain("Explain DNA repair");
  expect(prompts[0]).toContain('grew from the passage: "DNA repair"');
});

test("browsers without the model get a clear message that points to sign-up", async () => {
  const unsupported = await createGuestTransport({ api: null }).fetch("/api/chat", chatRequest({ messages: [{ role: "user", content: "Hi" }] }));
  await expect(readChatReplyStream(unsupported.body!)).rejects.toThrow(/Chrome.*sign up/);
  const weak = await createGuestTransport({ api: fakeModel("unavailable").api }).fetch("/api/chat", chatRequest({ messages: [{ role: "user", content: "Hi" }] }));
  await expect(readChatReplyStream(weak.body!)).rejects.toThrow(/can’t run its built-in model/);
});

test("nothing that needs an account or a paid model is answered for a guest", async () => {
  const transport = createGuestTransport({ api: null });
  const session = await (await transport.fetch("/api/auth/session")).json();
  expect(session.user).toMatchObject({ id: "guest", role: "member", billing: { accessKind: "none", hasAccess: false } });
  for (const path of ["/api/vault", "/api/state", "/api/chat/title", "/api/public-map/ask", "/api/billing/checkout", "/api/jev/workspace", "/api/dictation/transcribe"]) {
    const response = await transport.fetch(path, { method: "POST" });
    expect(response.status).toBe(403);
    expect((await response.json()).error).toContain("Sign up");
  }
  expect((await transport.fetch("/api/chat/runs/abc", { method: "DELETE" })).ok).toBe(true);
  expect((await transport.fetch("/api/chat/runs/abc")).status).toBe(404);
});

test("availability comes from LanguageModel, and its absence means unsupported", async () => {
  expect(await onDeviceStatus(null)).toBe("unsupported");
  expect(await onDeviceStatus(fakeModel("downloadable").api)).toBe("downloadable");
  expect(await onDeviceStatus(fakeModel("readily").api)).toBe("unavailable");
});

test("long prompts are cut from the middle so the request at the end survives", () => {
  const prompt = `Instructions. ${"document text ".repeat(2_000)}User request: summarize`;
  const fitted = fitOnDevicePrompt(prompt, 4_000);
  expect(fitted.length).toBeLessThanOrEqual(4_000);
  expect(fitted.startsWith("Instructions.")).toBe(true);
  expect(fitted.endsWith("User request: summarize")).toBe(true);
  expect(guestChatPrompt({ messages: [] })).toBe("");
});
