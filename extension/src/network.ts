import { EXTENSION_SESSION_API_PATH, normalizeServerUrl, type ExtensionSession } from "@margin-chat/capture-contracts";

async function request<T>(
  serverUrl: string,
  path: string,
  method: string,
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
      result?.error ?? `Margin Chat returned an error (${response.status}).`,
    );
  if (!result || typeof result !== "object")
    throw new Error(
      "The server returned an invalid response. Check your Margin Chat address.",
    );
  return result as T;
}

export function captureRequest<T>(settings: { serverUrl: string; token: string }, path: string, body?: unknown) {
  return request<T>(settings.serverUrl, path, body === undefined ? "GET" : "POST", body, settings.token);
}

export async function signIn(serverUrl: string, email: string, password: string) {
  const session = await request<ExtensionSession>(serverUrl, EXTENSION_SESSION_API_PATH, "POST", { email, password });
  if (typeof session.token !== "string" || !/^mc_extension_[A-Za-z0-9_-]{43}$/u.test(session.token) ||
      typeof session.user?.id !== "string" || !session.user.id ||
      typeof session.user?.displayName !== "string" || !session.user.displayName ||
      typeof session.user?.email !== "string" || !session.user.email ||
      !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= Date.now()) {
    throw new Error("This server did not return a valid session. Update your Margin Chat server and try again.");
  }
  return session;
}

export function signOut(settings: { serverUrl: string; token: string }) {
  return request(settings.serverUrl, EXTENSION_SESSION_API_PATH, "DELETE", undefined, settings.token);
}

export function errorText(error: unknown, fallback = "Could not reach Margin Chat. Your capture is kept here; retry when you’re online.") {
  return error instanceof Error &&
    error.name !== "TypeError" &&
    error.name !== "TimeoutError"
    ? error.message
    : fallback;
}
