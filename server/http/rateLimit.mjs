import { createHash } from "node:crypto";
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

/**
 * A limit every server instance shares, counted in Postgres when the database offers it.
 * Keys are hashed before they are stored, so no email or address is kept. This process's
 * own counter is checked first and still applies if the database can't be reached, so a
 * database hiccup never removes the limit altogether. Every method returns a promise.
 */
export function createSharedRateLimiter({ name, max, windowMs, store, now = Date.now, slots = 15 }) {
  const local = createRateLimiter({ max, windowMs, now });
  const shared = store && typeof store.countRateLimitHits === "function" && typeof store.recordRateLimitHit === "function"
    && typeof store.clearRateLimitHits === "function" ? store : null;
  const slotMs = Math.max(1000, Math.floor(windowMs / slots));
  const keyHash = (key) => createHash("sha256").update(`${name}\n${key}`).digest("hex").slice(0, 40);
  let warned = false;
  const fallback = (error) => {
    if (!warned) { warned = true; console.error(`Shared rate limit "${name}" unavailable; using this instance's count`, error?.message ?? error); }
  };

  return {
    async check(key) {
      local.check(key);
      if (!shared) return;
      let counted;
      try {
        counted = await shared.countRateLimitHits({ bucket: name, keyHash: keyHash(key), since: new Date(now() - windowMs) });
      } catch (error) { fallback(error); return; }
      if (counted.hits >= max) {
        const freesAt = (counted.oldest ? counted.oldest.getTime() : now()) + windowMs;
        throw new RateLimitError(Math.max(1, Math.ceil((freesAt - now()) / 1000)));
      }
    },
    async record(key) {
      local.record(key);
      if (!shared) return;
      const at = now();
      try {
        await shared.recordRateLimitHit({
          bucket: name, keyHash: keyHash(key), slotStart: new Date(at - (at % slotMs)),
          // About one attempt in fifty also clears slots older than a day.
          pruneBefore: Math.random() < 0.02 ? new Date(at - 24 * 60 * 60 * 1000) : null,
        });
      } catch (error) { fallback(error); }
    },
    async reset(key) {
      local.reset(key);
      if (!shared) return;
      try { await shared.clearRateLimitHits({ bucket: name, keyHash: keyHash(key) }); } catch (error) { fallback(error); }
    },
  };
}
