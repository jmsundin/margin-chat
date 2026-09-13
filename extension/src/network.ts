import { normalizeServerUrl } from "@margin-chat/capture-contracts";
export async function captureRequest<T>(
  settings: { serverUrl: string; token: string },
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(
    `${normalizeServerUrl(settings.serverUrl)}${path}`,
    {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${settings.token}`,
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

export function errorText(error: unknown) {
  return error instanceof Error &&
    error.name !== "TypeError" &&
    error.name !== "TimeoutError"
    ? error.message
    : "Could not reach Margin Chat. Your capture is kept here; retry when you’re online.";
}
