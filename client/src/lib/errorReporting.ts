/**
 * Sends crashes and unhandled errors to Sentry when VITE_SENTRY_DSN is set,
 * without the SDK. Only the error, the page path and the release go out:
 * never query strings (reset tokens), document text or what was typed.
 */

interface SentryTarget { endpoint: string }

const MAX_EVENTS_PER_PAGE = 10;
const FRAME = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$|^(.*?)@(.+?):(\d+):(\d+)$/u;

export function sentryTarget(dsn: string | undefined): SentryTarget | null {
  if (!dsn?.trim()) return null;
  try {
    const url = new URL(dsn.trim());
    const projectId = url.pathname.replace(/^\/+|\/+$/gu, "");
    if (url.protocol !== "https:" || !url.username || !/^\d+$/u.test(projectId)) return null;
    // Key in the query and a text body: a simple request, so no CORS preflight.
    return { endpoint: `${url.origin}/api/${projectId}/envelope/?sentry_key=${encodeURIComponent(url.username)}&sentry_version=7&sentry_client=margin-chat-web/1.0` };
  } catch {
    return null;
  }
}

/** Chrome and Firefox/Safari stack lines as Sentry frames, oldest call first. */
export function stackFrames(stack: string | undefined) {
  const frames = [];
  for (const line of String(stack ?? "").split("\n").slice(0, 50)) {
    const match = FRAME.exec(line.trim());
    if (!match) continue;
    const fn = match[1] ?? match[5];
    const file = (match[2] ?? match[6]).split(/[?#]/u)[0];
    frames.push({ function: fn || "?", filename: file, lineno: Number(match[3] ?? match[7]), colno: Number(match[4] ?? match[8]), in_app: true });
  }
  return frames.reverse();
}

export function buildBrowserEvent(error: unknown, { release, path, kind }: { release?: string; path: string; kind: string }) {
  const value = error instanceof Error ? error : new Error(typeof error === "string" ? error : "Non-error value thrown");
  const frames = stackFrames(value.stack);
  const eventId = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/[^a-f0-9]/gu, "").padEnd(32, "0").slice(0, 32);
  return {
    event_id: eventId,
    timestamp: Date.now() / 1000,
    platform: "javascript",
    level: "error",
    ...(release ? { release } : {}),
    environment: "production",
    exception: { values: [{ type: value.name || "Error", value: String(value.message ?? "").slice(0, 1000), ...(frames.length ? { stacktrace: { frames } } : {}) }] },
    transaction: path,
    request: { url: path, headers: { "User-Agent": navigator.userAgent } },
    tags: { kind },
  };
}

let target: SentryTarget | null = null;
let sent = 0;
const seen = new Set<string>();

export function reportError(error: unknown, kind = "caught") {
  if (!target || sent >= MAX_EVENTS_PER_PAGE) return;
  const key = error instanceof Error ? `${error.name}:${error.message}` : String(error);
  if (seen.has(key)) return;
  seen.add(key);
  sent += 1;
  const event = buildBrowserEvent(error, { release: import.meta.env.VITE_APP_COMMIT, path: window.location.pathname, kind });
  const body = `${JSON.stringify({ event_id: event.event_id, sent_at: new Date().toISOString() })}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(event)}`;
  void fetch(target.endpoint, { method: "POST", body, keepalive: true, headers: { "Content-Type": "text/plain;charset=UTF-8" } }).catch(() => undefined);
}

/** Call once at startup. Does nothing without a DSN, in development, or in the extension. */
export function startErrorReporting() {
  target = import.meta.env.PROD ? sentryTarget(import.meta.env.VITE_SENTRY_DSN) : null;
  if (!target) return;
  window.addEventListener("error", (event) => {
    // A failed image or script load has no error object; those aren't crashes.
    if (event.error) reportError(event.error, "uncaught");
  });
  window.addEventListener("unhandledrejection", (event) => reportError(event.reason, "unhandled-rejection"));
}
