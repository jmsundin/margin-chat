import { describe, expect, test } from "bun:test";
import { createWorkspaceFetch } from "../src/workspace-transport";
import type { ConnectionSettings } from "../src/storage";

const connection = (): ConnectionSettings => ({ serverUrl: "https://margin.example", token: `mc_workspace_${"A".repeat(43)}`, userId: "reader", connectionId: "server-reader", displayName: "Reader" });
describe("protected extension workspace transport", () => {
  test("uses only the configured API with bearer auth, omitted cookies and live streaming", async () => {
    const settings = connection();
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"type":"delta"}\n')); controller.close(); } });
    const fetcher = createWorkspaceFetch({ connection: settings, getSettings: async () => settings, fetch: (async (url, init) => {
      expect(String(url)).toBe("https://margin.example/api/chat");
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${settings.token}`);
      expect(new Headers(init?.headers).get("X-Margin-Vault-User")).toBe("reader");
      expect(init?.credentials).toBe("omit"); expect(init?.redirect).toBe("error");
      return new Response(stream);
    }) as typeof fetch });
    const response = await fetcher("/api/chat", { method: "POST", headers: { "X-Margin-Vault-User": "reader" }, body: "{}" });
    expect(response.body).toBe(stream);
    expect(await response.text()).toContain("delta");
  });
  test("does not send tokens to another host, protocol-relative URL, credentials, or non-API path", async () => {
    let calls = 0; const settings = connection();
    const fetcher = createWorkspaceFetch({ connection: settings, getSettings: async () => settings, fetch: (async () => { calls++; return Response.json({}); }) as typeof fetch });
    for (const path of ["https://evil.example/api/chat", "//evil.example/api/chat", "/index.html", "https://user:secret@margin.example/api/chat", "/api/../outside"]) await expect(fetcher(path)).rejects.toThrow("configured");
    expect(calls).toBe(0);
  });
  test("rejects capture-only sessions and mismatched expected account before any network request", async () => {
    let calls = 0; let settings: ConnectionSettings | null = connection();
    const expected = { ...settings };
    const fetcher = createWorkspaceFetch({ connection: expected, getSettings: async () => settings, fetch: (async () => { calls++; return Response.json({}); }) as typeof fetch });
    settings.token = `mc_extension_${"A".repeat(43)}`;
    await expect(fetcher("/api/vault")).rejects.toThrow("workspace access");
    settings = connection();
    await expect(fetcher("/api/vault", { headers: { "X-Margin-Vault-User": "other" } })).rejects.toThrow("another");
    settings = { ...settings, connectionId: "other" };
    await expect(fetcher("/api/vault")).rejects.toThrow("account changed");
    expect(calls).toBe(0);
  });
  test("shares cancellation with chat streams and drops late responses after account changes", async () => {
    const lifetime = new AbortController(); let settings = connection(); let signal: AbortSignal | undefined;
    const fetcher = createWorkspaceFetch({ connection: settings, getSettings: async () => settings, signal: lifetime.signal, fetch: (async (_url, init) => { signal = init?.signal ?? undefined; return Response.json({ ok: true }); }) as typeof fetch });
    await fetcher("/api/chat"); lifetime.abort(); expect(signal?.aborted).toBe(true);
    const changing = createWorkspaceFetch({ connection: settings, getSettings: async () => settings, fetch: (async () => { settings = { ...settings, connectionId: "other" }; return Response.json({ private: "old account data" }); }) as typeof fetch });
    await expect(changing("/api/vault")).rejects.toThrow("before the response");
  });
});
