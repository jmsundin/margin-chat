import { EXTENSION_SESSION_API_PATH, normalizeServerUrl, parseExtensionSession } from "@margin-chat/capture-contracts";

async function request<T>(
  serverUrl: string,
  path: string,
  method: string,
  parse: (input: unknown) => T,
  body?: unknown,
  token?: string,
): Promise<T> {
  const response = await fetch(
    `${normalizeServerUrl(serverUrl)}${path}`,
    {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    },
  );
  const result = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      typeof result?.error === "string" ? result.error : `Margin Chat returned an error (${response.status}).`,
    );
  return parse(result);
}

export function captureRequest<T>(settings: { serverUrl: string; token: string }, path: string, parse: (input: unknown) => T, body?: unknown) {
  return request(settings.serverUrl, path, body === undefined ? "GET" : "POST", parse, body, settings.token);
}

export function signIn(serverUrl: string, email: string, password: string) {
  return request(serverUrl, EXTENSION_SESSION_API_PATH, "POST", parseExtensionSession, { email, password });
}

export function signOut(settings: { serverUrl: string; token: string }) {
  return request(settings.serverUrl, EXTENSION_SESSION_API_PATH, "DELETE", (input) => {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("The server returned an invalid response. Check your Margin Chat address.");
  }, undefined, settings.token);
}

export function errorText(error: unknown, fallback = "Could not reach Margin Chat. Your capture is kept here; retry when you’re online.") {
  return error instanceof Error &&
    error.name !== "TypeError" &&
    error.name !== "TimeoutError"
    ? error.message
    : fallback;
}
