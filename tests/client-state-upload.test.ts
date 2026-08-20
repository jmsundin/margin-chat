import { afterEach, describe, expect, test } from "bun:test";
import { createEmptyState } from "../client/src/initialState";
import { persistStoredStateWithProgress } from "../client/src/lib/api";

const originalXmlHttpRequest = globalThis.XMLHttpRequest;

afterEach(() => {
  if (originalXmlHttpRequest) {
    globalThis.XMLHttpRequest = originalXmlHttpRequest;
    return;
  }

  delete (globalThis as { XMLHttpRequest?: typeof XMLHttpRequest })
    .XMLHttpRequest;
});

describe("manual cloud state upload", () => {
  test("reports uploaded bytes against the serialized local master copy", async () => {
    const state = createEmptyState();
    state.conversations[state.rootId].title = "Résumé notes";
    const serializedState = JSON.stringify(state);
    const totalBytes = new TextEncoder().encode(serializedState).byteLength;
    const progress: Array<{ totalBytes: number; uploadedBytes: number }> = [];
    let request: FakeXmlHttpRequest | null = null;

    class FakeUploadTarget {
      progressListener: ((event: { loaded: number }) => void) | null = null;

      addEventListener(
        type: string,
        listener: (event: { loaded: number }) => void,
      ) {
        if (type === "progress") {
          this.progressListener = listener;
        }
      }
    }

    class FakeXmlHttpRequest {
      body: string | null = null;
      listeners = new Map<string, () => void>();
      method = "";
      responseText = "{}";
      status = 200;
      upload = new FakeUploadTarget();
      url = "";
      withCredentials = false;

      constructor() {
        request = this;
      }

      open(method: string, url: string) {
        this.method = method;
        this.url = url;
      }

      setRequestHeader() {}

      addEventListener(type: string, listener: () => void) {
        this.listeners.set(type, listener);
      }

      send(body: string) {
        this.body = body;
        this.upload.progressListener?.({ loaded: Math.floor(totalBytes / 2) });
        this.listeners.get("load")?.();
      }
    }

    globalThis.XMLHttpRequest =
      FakeXmlHttpRequest as unknown as typeof XMLHttpRequest;

    await persistStoredStateWithProgress(state, (nextProgress) => {
      progress.push(nextProgress);
    });

    expect(request?.method).toBe("PUT");
    expect(request?.url).toBe("/api/state");
    expect(request?.withCredentials).toBe(true);
    expect(request?.body).toBe(serializedState);
    expect(progress).toEqual([
      { totalBytes, uploadedBytes: 0 },
      { totalBytes, uploadedBytes: Math.floor(totalBytes / 2) },
      { totalBytes, uploadedBytes: totalBytes },
    ]);
  });
});
