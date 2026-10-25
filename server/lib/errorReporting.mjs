import { randomUUID } from "node:crypto";

/**
 * Sends unexpected server errors to Sentry when SENTRY_DSN is set, without the
 * SDK: one envelope POST per error. Only the error, the route and the release
 * are sent, never request bodies, query strings, cookies or document text.
 */

/** Sentry's DSN: https://<publicKey>@<host>/<projectId>. Null when absent or malformed. */
export function parseSentryDsn(dsn) {
  if (typeof dsn !== "string" || !dsn.trim()) return null;
  try {
    const url = new URL(dsn.trim());
    const projectId = url.pathname.replace(/^\/+|\/+$/gu, "");
    if (url.protocol !== "https:" || !url.username || !/^\d+$/u.test(projectId)) return null;
    return { publicKey: url.username, endpoint: `${url.origin}/api/${projectId}/envelope/` };
  } catch {
    return null;
  }
}

const FRAME = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/u;

/** V8 stack lines as Sentry frames, oldest call first. */
export function stackFrames(stack) {
  const frames = [];
  for (const line of String(stack ?? "").split("\n").slice(1, 51)) {
    const match = FRAME.exec(line);
    if (!match) continue;
    const [, fn, file, lineno, colno] = match;
    frames.push({
      function: fn || "?", filename: file, lineno: Number(lineno), colno: Number(colno),
      in_app: !/node_modules|^node:|^internal\//u.test(file),
    });
  }
  return frames.reverse();
}

export function buildErrorEvent(error, { platform, release, environment, route, method, tags } = {}) {
  const value = error instanceof Error ? error : new Error(String(error));
  const frames = stackFrames(value.stack);
  return {
    event_id: randomUUID().replaceAll("-", ""),
    timestamp: Date.now() / 1000,
    platform,
    level: "error",
    ...(release ? { release } : {}),
    ...(environment ? { environment } : {}),
    exception: { values: [{ type: value.name || "Error", value: String(value.message ?? "").slice(0, 1000), ...(frames.length ? { stacktrace: { frames } } : {}) }] },
    ...(route ? { transaction: route, request: { url: route, method } } : {}),
    ...(tags ? { tags } : {}),
  };
}

export function createErrorReporter({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 2_000 } = {}) {
  const sentry = parseSentryDsn(env.SENTRY_DSN);
  const release = env.MARGIN_RELEASE_SHA ?? env.VERCEL_GIT_COMMIT_SHA ?? undefined;
  const environment = env.VERCEL_ENV ?? env.NODE_ENV ?? "development";

  return {
    enabled: Boolean(sentry),
    /** Never throws; a reporting failure must not turn into a second error. */
    async report(error, { request, routeId } = {}) {
      if (!sentry) return false;
      // The path only: query strings carry reset tokens and search text.
      const path = typeof request?.url === "string" ? request.url.split(/[?#]/u)[0] : undefined;
      const event = buildErrorEvent(error, {
        platform: "node", release, environment, route: path, method: request?.method, tags: routeId ? { route: routeId } : undefined,
      });
      const body = `${JSON.stringify({ event_id: event.event_id, sent_at: new Date().toISOString() })}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(event)}`;
      try {
        const response = await fetchImpl(sentry.endpoint, {
          body,
          headers: {
            "Content-Type": "application/x-sentry-envelope",
            "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${sentry.publicKey}, sentry_client=margin-chat/1.0`,
          },
          method: "POST",
          signal: AbortSignal.timeout(timeoutMs),
        });
        return response.ok;
      } catch {
        return false;
      }
    },
  };
}
