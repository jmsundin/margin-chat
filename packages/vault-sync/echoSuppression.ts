/**
 * Tells the app's own writes apart from files other programs change.
 *
 * Every file the app publishes into the vault folder (a cloud pull, a merge
 * result, an in-app save) is recorded here by path and content hash. When the
 * folder watcher later reports that path, it hashes the file: a match is the
 * echo of our own write and is dropped; anything else is an external change.
 * A sync loop that re-ingests and re-uploads its own downloads would never
 * settle, so this is a correctness mechanism, not an optimization.
 *
 * The map is bounded: one entry per path (the latest write wins), each cleared
 * when its echo arrives or after `ttlMs`, whichever comes first.
 */

export interface EchoSuppressor {
  /** Records that `path` now holds bytes with this hash because the app wrote them. */
  expect(path: string, hash: string, now?: number): void;
  /** Forgets a path the app removed; its disappearance is not an external deletion either. */
  expectRemoved(path: string, now?: number): void;
  /** Whether a watcher event for `path` with these bytes (or `null` for a missing file) is our own write. Consumes the expectation. */
  isEcho(path: string, hash: string | null, now?: number): boolean;
  /** Drops expectations older than the time limit. */
  prune(now?: number): void;
  readonly size: number;
}

/** How long an expected echo may take to arrive before it is forgotten. */
export const ECHO_TTL_MS = 60_000;

export function createEchoSuppressor(ttlMs = ECHO_TTL_MS): EchoSuppressor {
  const expected = new Map<string, { hash: string | null; at: number }>();
  const prune = (now: number) => {
    for (const [path, entry] of expected) if (now - entry.at > ttlMs) expected.delete(path);
  };
  return {
    expect(path, hash, now = Date.now()) { prune(now); expected.set(path, { hash, at: now }); },
    expectRemoved(path, now = Date.now()) { prune(now); expected.set(path, { hash: null, at: now }); },
    isEcho(path, hash, now = Date.now()) {
      prune(now);
      const entry = expected.get(path);
      if (!entry) return false;
      if (entry.hash !== hash) return false;
      expected.delete(path);
      return true;
    },
    prune(now = Date.now()) { prune(now); },
    get size() { return expected.size; },
  };
}

/** SHA-256 of some bytes, as hex. Works in browsers, Node and Electron alike. */
export async function hashBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
