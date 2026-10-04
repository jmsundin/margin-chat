import { HttpError } from "../lib/errors.mjs";

export class RateLimitError extends HttpError {
  constructor(retryAfterSeconds) {
    super(429, "Too many attempts. Please wait a few minutes and try again.");
    this.name = "RateLimitError";
    this.headers = { "Retry-After": String(retryAfterSeconds) };
  }
}

/**
 * Fixed-window counter keyed by an arbitrary string.
 *
 * State lives in this process only. On serverless hosts each warm instance has
 * its own counters, so this slows an attacker rather than bounding them; put a
 * shared limit (for example a WAF rule) in front for a hard guarantee.
 */
export function createRateLimiter({ max, windowMs, maxKeys = 10_000, now = Date.now }) {
  const windows = new Map();

  function active(key) {
    const entry = windows.get(key);
    if (!entry) return null;
    if (entry.resetAt <= now()) {
      windows.delete(key);
      return null;
    }
    return entry;
  }

  function prune() {
    for (const key of windows.keys()) active(key);
    // Still full of live windows: drop the oldest rather than grow without bound.
    while (windows.size >= maxKeys) windows.delete(windows.keys().next().value);
  }

  return {
    /** Throws when the key has used its allowance; does not count this call. */
    check(key) {
      const entry = active(key);
      if (entry && entry.count >= max) {
        throw new RateLimitError(Math.max(1, Math.ceil((entry.resetAt - now()) / 1000)));
      }
    },
    record(key) {
      const entry = active(key);
      if (entry) {
        entry.count += 1;
        return;
      }
      if (windows.size >= maxKeys) prune();
      windows.set(key, { count: 1, resetAt: now() + windowMs });
    },
    reset(key) {
      windows.delete(key);
    },
  };
}

/**
 * Forwarding headers are client-controlled unless a trusted proxy overwrites
 * them, so they are only honored when the deployment says one does.
 */
export function getClientAddress(request, { trustProxyHeaders = false } = {}) {
  if (trustProxyHeaders) {
    const forwarded = request.headers["x-vercel-forwarded-for"] ?? request.headers["x-forwarded-for"];
    const first = String(Array.isArray(forwarded) ? forwarded[0] : forwarded ?? "").split(",")[0].trim();
    if (first) return first.slice(0, 64);
  }
  return request.socket?.remoteAddress ?? "unknown";
}
