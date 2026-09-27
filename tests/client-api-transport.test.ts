import { afterEach, describe, expect, test } from "bun:test";
import { apiFetch, apiServerUrl, apiStorageNamespace, setApiTransport } from "../client/src/lib/apiTransport";
import { requestAuthSession, requestChatReply } from "../client/src/lib/api";
import { createVaultTransport } from "../client/src/lib/vaultApi";

const nativeFetch = globalThis.fetch;
afterEach(() => { setApiTransport(null); globalThis.fetch = nativeFetch; });

describe("shared workspace API transport", () => {
  test("website requests retain same-origin URLs, cookie credentials and account keys", async () => {
    let call: { input: unknown; init?: RequestInit } | undefined;
    globalThis.fetch = (async (input, init) => {
      call = { input, init };
      return Response.json({ user: null });
    }) as typeof fetch;
    expect(await requestAuthSession()).toBeNull();
    expect(call?.input).toBe("/api/auth/session");
    expect(call?.init?.credentials).toBe("same-origin");
    expect(apiStorageNamespace("account")).toBe("account");
  });

  test("extension delegation preserves streaming bodies and cancellation without overriding native fetch", async () => {
    const controller = new AbortController();
    const chunks = ['{"type":"metadata","metadata":{"model":"gpt-4.1","requestedServiceId":"openai-api","resolvedServiceId":"openai-api"}}\n', '{"type":"delta","delta":"Hello "}\n', '{"type":"delta","delta":"world"}\n', '{"type":"done","reply":"Hello world"}\n'];
    const stream = new ReadableStream({ start(output) { for (const chunk of chunks) output.enqueue(new TextEncoder().encode(chunk)); output.close(); } });
    let call: { input: unknown; init?: RequestInit } | undefined;
    setApiTransport({ serverUrl: "https://margin.example", fetch: (async (input, init) => {
      call = { input, init };
      return new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } });
    }) as typeof fetch });
    const deltas: string[] = [];
    const result = await requestChatReply({ expectedUserId: "real-account", serviceId: "openai-api", modelId: "gpt-4.1", signal: controller.signal,
      messages: [], conversation: { id: "chat", title: "Chat", parentId: null, branchAnchor: null, documents: [], ancestorContext: [] }, onDelta: (value) => deltas.push(value) });
    expect(result.reply).toBe("Hello world");
    expect(deltas).toEqual(["Hello ", "world"]);
    expect(call?.input).toBe("/api/chat");
    expect(call?.init?.signal).toBe(controller.signal);
    expect(new Headers(call?.init?.headers).get("X-Margin-Vault-User")).toBe("real-account");
    expect(globalThis.fetch).toBe(nativeFetch);
  });

  test("vault reads use injected transport with real account headers and separate local server identities", async () => {
    const calls: Array<{ path: string; user: string | null }> = [];
    const delegated = (async (input, init) => {
      calls.push({ path: String(input), user: new Headers(init?.headers).get("X-Margin-Vault-User") });
      return Response.json({ configured: true, manifest: { schemaVersion: 1, revision: 0, files: {} } });
    }) as typeof fetch;
    setApiTransport({ serverUrl: "https://one.example/", fetch: delegated });
    const first = apiStorageNamespace("shared-id");
    expect(apiServerUrl()).toBe("https://one.example");
    await createVaultTransport("shared-id").manifest();
    setApiTransport({ serverUrl: "https://two.example", fetch: delegated });
    expect(apiStorageNamespace("shared-id")).not.toBe(first);
    expect(apiStorageNamespace("other-id")).not.toBe(apiStorageNamespace("shared-id"));
    expect(calls).toEqual([{ path: "/api/vault", user: "shared-id" }]);
  });

  test("passes upload bodies and abort signals through untouched", async () => {
    const body = new FormData(); body.append("file", new Blob(["source"]), "source.md");
    const controller = new AbortController();
    const init = { method: "POST", body, signal: controller.signal };
    const response = Response.json({ document: {} });
    setApiTransport({ fetch: (async (input, options) => { expect(input).toBe("/api/documents"); expect(options).toBe(init); return response; }) as typeof fetch });
    expect(await apiFetch("/api/documents", init)).toBe(response);
  });
});
