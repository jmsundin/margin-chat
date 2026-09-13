import { beforeAll, describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { serverPermissionPattern } from "../src/permissions";

let background: string;
beforeAll(async () => {
  const result = await Bun.build({
    entrypoints: [new URL("../src/background.ts", import.meta.url).pathname],
    target: "browser",
    format: "iife",
  });
  if (!result.success)
    throw new Error("Unable to build the background worker for tests.");
  background = await result.outputs[0].text();
});
const capture = () => ({
  schemaVersion: 1,
  clientCaptureId: crypto.randomUUID(),
  kind: "selection",
  title: "A selected passage",
  sourceUrl: "https://example.com/article",
  content: "Worth keeping.",
  comment: "My thoughts.",
  capturedAt: new Date().toISOString(),
});
const connection = () => ({
  serverUrl: "https://margin.example",
  token: `mc_capture_${"A".repeat(43)}`,
  connectionId: "connection-a",
  displayName: "Reader",
});
function createWorker(storage: Record<string, any>, fetchImpl: typeof fetch) {
  let listener: (...args: any[]) => any;
  let accessLevel: string | null = null;
  const url = "chrome-extension://test-extension/popup.html";
  const chrome = {
    runtime: {
      id: "test-extension",
      getURL: (path: string) => `chrome-extension://test-extension/${path}`,
      onInstalled: { addListener() {} },
      onMessage: {
        addListener(callback: typeof listener) {
          listener = callback;
        },
      },
    },
    contextMenus: { onClicked: { addListener() {} } },
    storage: {
      local: {
        async get(key: string) {
          return { [key]: structuredClone(storage[key]) };
        },
        async set(value: Record<string, unknown>) {
          Object.assign(storage, structuredClone(value));
        },
        async remove(key: string) {
          delete storage[key];
        },
        async setAccessLevel(options: { accessLevel: string }) {
          accessLevel = options.accessLevel;
        },
      },
    },
  };
  runInNewContext(background, {
    chrome,
    fetch: fetchImpl,
    URL,
    AbortSignal,
    console,
  });
  return {
    accessLevel: () => accessLevel,
    dispatch(
      message: unknown,
      sender = { id: "test-extension", url },
    ): Promise<any> {
      return new Promise((resolve) => {
        const keepOpen = listener({ connectionId: storage.connection?.connectionId, ...(message as object) }, sender, resolve);
        if (!keepOpen) resolve(undefined);
      });
    },
  };
}

describe("extension upload lifecycle", () => {
  test("a popup opened before an account switch cannot upload to the new account", async () => {
    const storage = { connection: connection() };
    let uploads = 0;
    const worker = createWorker(storage, (async () => { uploads++; return Response.json({}); }) as typeof fetch);
    const result = await worker.dispatch({ type: "save", capture: capture(), connectionId: "previous-account" });
    expect(result.error).toContain("account changed");
    expect(uploads).toBe(0);
  });
  test("server permissions remain stable when switching local development ports", () => {
    expect(serverPermissionPattern("http://localhost:5173")).toBe(
      "http://localhost/*",
    );
    expect(serverPermissionPattern("http://localhost:4174")).toBe(
      serverPermissionPattern("http://localhost:5173"),
    );
    expect(serverPermissionPattern("https://margin.example:8443")).toBe(
      "https://margin.example/*",
    );
  });
  test("persists before upload and reuses the identical request after a worker restart", async () => {
    const storage: Record<string, any> = { connection: connection() };
    const draft = capture();
    const first = createWorker(storage, (async () => {
      expect(storage.pendingSave.capture.clientCaptureId).toBe(
        draft.clientCaptureId,
      );
      throw new TypeError("Network disconnected");
    }) as typeof fetch);
    expect(
      (await first.dispatch({ type: "save", capture: draft })).error,
    ).toContain("retry");
    expect(first.accessLevel()).toBe("TRUSTED_CONTEXTS");
    expect(storage.pendingSave.receipt).toBeUndefined();
    const receipt = { id: "saved-id", createdAt: "2026-09-12T10:00:00.000Z" };
    let uploads = 0;
    const resumed = createWorker(storage, (async (url, init) => {
      uploads++;
      expect(String(url)).toBe("https://margin.example/api/v1/captures");
      expect(JSON.parse(String(init?.body))).toEqual(draft);
      expect(init?.credentials).toBe("omit");
      expect(init?.redirect).toBe("error");
      return Response.json({ capture: receipt });
    }) as typeof fetch);
    expect((await resumed.dispatch({ type: "retry" })).receipt).toEqual(
      receipt,
    );
    expect((await resumed.dispatch({ type: "retry" })).receipt).toEqual(
      receipt,
    );
    expect(uploads).toBe(1);
    expect(storage.pendingSave.receipt).toEqual(receipt);
  });
  test("does not send a pending capture to a different connection or overwrite an unresolved save", async () => {
    const storage: Record<string, any> = {
      connection: connection(),
      pendingSave: { capture: capture(), connectionId: "connection-a" },
    };
    let uploads = 0;
    const worker = createWorker(storage, (async () => {
      uploads++;
      return Response.json({});
    }) as typeof fetch);
    expect(
      (await worker.dispatch({ type: "save", capture: capture() })).error,
    ).toContain("previous capture");
    storage.connection.connectionId = "connection-b";
    expect((await worker.dispatch({ type: "retry" })).error).toContain(
      "previous connection",
    );
    expect(uploads).toBe(0);
    await worker.dispatch({ type: "dismiss" });
    expect(storage.pendingSave).toBeUndefined();
  });
  test("ignores page and content-script messages and rejects malformed capture data", async () => {
    const storage: Record<string, any> = { connection: connection() };
    let uploads = 0;
    const worker = createWorker(storage, (async () => {
      uploads++;
      return Response.json({});
    }) as typeof fetch);
    expect(
      await worker.dispatch(
        { type: "save", capture: capture() },
        { id: "test-extension", url: "https://example.com/article" },
      ),
    ).toBeUndefined();
    expect(
      await worker.dispatch(
        { type: "save", capture: capture() },
        {
          id: "another-extension",
          url: "chrome-extension://test-extension/popup.html",
        },
      ),
    ).toBeUndefined();
    expect(
      (
        await worker.dispatch({
          type: "save",
          capture: { ...capture(), sourceUrl: "javascript:alert(1)" },
        })
      ).error,
    ).toBeDefined();
    expect(storage.pendingSave).toBeUndefined();
    expect(uploads).toBe(0);
  });
  test("keeps a pending save on a lost confirmation instead of declaring success", async () => {
    const storage: Record<string, any> = { connection: connection() };
    const worker = createWorker(storage, (async () =>
      Response.json({ ok: true })) as typeof fetch);
    expect(
      (await worker.dispatch({ type: "save", capture: capture() })).error,
    ).toContain("did not confirm");
    expect(storage.pendingSave.capture).toBeDefined();
    expect(storage.pendingSave.receipt).toBeUndefined();
  });
});
