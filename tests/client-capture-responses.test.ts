import { afterEach, describe, expect, test } from "bun:test";
import { listCaptures, loadCapture } from "../client/src/lib/captures";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const respond = (value: unknown, status = 200) => {
  globalThis.fetch = (async () => Response.json(value, { status })) as typeof fetch;
};

describe("Cloud Inbox response validation", () => {
  test("validates list responses while preserving authenticated request options and opaque cursors", async () => {
    globalThis.fetch = (async (url, init) => {
      expect(String(url)).toBe("/api/v1/captures?cursor=next%2Bpage%3D");
      expect(init?.credentials).toBe("same-origin");
      expect(init?.cache).toBe("no-store");
      return Response.json({ captures: [], nextCursor: null, futureField: true });
    }) as typeof fetch;
    expect(await listCaptures("next+page=")).toEqual({ captures: [], nextCursor: null, futureField: true });
    respond({ captures: {}, nextCursor: null });
    await expect(listCaptures()).rejects.toThrow("invalid Cloud Inbox page");
  });

  test("rejects malformed detail JSON before exposing a capture to the UI", async () => {
    respond({ capture: { id: "saved-id", createdAt: "2026-09-12T12:30:00.000Z" } });
    await expect(loadCapture("saved-id")).rejects.toThrow("invalid capture");
    globalThis.fetch = (async () => new Response("<html>Unavailable</html>")) as typeof fetch;
    await expect(loadCapture("saved-id")).rejects.toThrow("invalid capture");
  });

  test("keeps server error messages and handles malformed error responses", async () => {
    respond({ error: "Sign in again." }, 401);
    await expect(listCaptures()).rejects.toThrow("Sign in again.");
    respond(null, 503);
    await expect(loadCapture("saved-id")).rejects.toThrow("Unable to reach your Cloud Inbox.");
  });
});
