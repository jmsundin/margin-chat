import { normalizeServerUrl } from "@margin-chat/capture-contracts";
import type { ConnectionSettings } from "./storage";

/** Runs only in the extension-origin workspace. Never installed in a page world. */
export function createWorkspaceFetch(options: {
  connection: ConnectionSettings;
  getSettings: () => Promise<ConnectionSettings | null>;
  fetch: typeof fetch;
  signal?: AbortSignal;
}): typeof fetch {
  const origin = normalizeServerUrl(options.connection.serverUrl);
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const inputUrl = input instanceof Request ? input.url : String(input);
    const url = new URL(inputUrl, `${origin}/`);
    if (url.origin !== origin || !url.pathname.startsWith("/api/") || url.username || url.password)
      throw new Error("Workspace requests must use your configured Margin Chat server.");
    const settings = await options.getSettings();
    if (!settings || settings.connectionId !== options.connection.connectionId || settings.serverUrl !== origin)
      throw new Error("The signed-in account changed. Reconnect your Margin Chat workspace.");
    if (!/^mc_workspace_[A-Za-z0-9_-]{43}$/u.test(settings.token))
      throw new Error("Sign in with workspace access in the extension settings to use your documents and AI.");
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    headers.set("Authorization", `Bearer ${settings.token}`);
    const expectedAccount = headers.get("X-Margin-Vault-User") ?? headers.get("X-Margin-Billing-User");
    if (expectedAccount && expectedAccount !== settings.userId)
      throw new Error("This request belongs to another Margin Chat account.");
    const signals = [options.signal, init?.signal, input instanceof Request ? input.signal : undefined].filter(Boolean) as AbortSignal[];
    const request: RequestInit = {
      ...(input instanceof Request ? { method: input.method, body: input.body, signal: input.signal } : {}),
      ...init, headers, credentials: "omit", redirect: "error", cache: "no-store",
      ...(signals.length ? { signal: AbortSignal.any(signals) } : {}),
    };
    const response = await options.fetch(url.href, request);
    const current = await options.getSettings();
    if (!current || current.connectionId !== settings.connectionId || current.serverUrl !== origin) {
      await response.body?.cancel();
      throw new Error("The signed-in account changed before the response arrived.");
    }
    return response;
  }) as typeof fetch;
}
