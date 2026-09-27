import { beforeAll, describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { serverPermissionPattern } from "../src/permissions";
import { buildBackground } from "./background-build";

let background: string;
beforeAll(async () => {
  background = await buildBackground();
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
  let actionListener: (...args: any[]) => any;
  let menuListener: (...args: any[]) => any;
  const injections: any[] = [];
  const openedTabs: string[] = [];
  let optionsOpened = 0;
  let accessLevel: string | null = null;
  const url = "chrome-extension://test-extension/popup.html";
  const chrome = {
    runtime: {
      id: "test-extension",
      getURL: (path: string) => `chrome-extension://test-extension/${path}`,
      onInstalled: { addListener() {} },
      async openOptionsPage() { optionsOpened++; },
      onMessage: {
        addListener(callback: typeof listener) {
          listener = callback;
        },
      },
    },
    contextMenus: { onClicked: { addListener(callback: typeof menuListener) { menuListener = callback; } } },
    action: {
      onClicked: { addListener(callback: typeof actionListener) { actionListener = callback; } },
      async openPopup() { throw new Error("No action popup"); },
    },
    tabs: { async create(tab: { url: string }) { openedTabs.push(tab.url); } },
    scripting: { async executeScript(options: unknown) { injections.push(options); return []; } },
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
      session: {
        async set(value: Record<string, unknown>) { Object.assign(storage, structuredClone(value)); },
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
    injections,
    openedTabs,
    optionsOpened: () => optionsOpened,
    async clickAction(tab: { id: number; url: string; windowId?: number }) {
      actionListener(tab);
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    async clickMenu(info: Record<string, unknown>, tab: Record<string, unknown>) {
      menuListener(info, tab);
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    dispatch(
      message: unknown,
      sender: Record<string, unknown> = { id: "test-extension", url },
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
  test("malformed receipts remain retryable with the original capture ID", async () => {
    const receipt = { id: "saved-id", createdAt: "2026-09-12T10:00:00.000Z" };
    for (const malformed of [
      { ...receipt, id: 42 },
      { ...receipt, createdAt: "not-a-date" },
      { ...receipt, createdAt: 2026 },
    ]) {
      const storage: Record<string, any> = { connection: connection() };
      const draft = capture();
      const worker = createWorker(storage, (async () => Response.json({ capture: malformed })) as typeof fetch);
      expect((await worker.dispatch({ type: "save", capture: draft })).error).toContain("did not confirm");
      expect(storage.pendingSave.capture).toEqual(draft);
      expect(storage.pendingSave.receipt).toBeUndefined();
      const resumed = createWorker(storage, (async (_url, init) => {
        expect(JSON.parse(String(init?.body))).toEqual(draft);
        return Response.json({ capture: receipt, futureOptionalField: true });
      }) as typeof fetch);
      expect((await resumed.dispatch({ type: "retry" })).receipt).toEqual(receipt);
      expect(storage.pendingSave.error).toBeUndefined();
    }
  });
});

const pageSender = (url = "https://example.com/article") => ({
  id: "test-extension", url, frameId: 0, tab: { id: 12, url },
});
const overlayDraft = () => ({
  title: "A selected passage", kind: "selection", content: "Worth keeping.",
  comment: "My thoughts.", mode: "annotate",
  anchor: { exact: "Worth keeping.", prefix: "Before ", suffix: " After", start: 7, end: 21 },
});

describe("on-page Margin broker", () => {
  test("only an own main-frame HTTP content script can read page state", async () => {
    const storage = { connection: connection() };
    const worker = createWorker(storage, fetch);
    for (const sender of [
      { ...pageSender(), id: "other-extension" },
      { ...pageSender(), frameId: 1 },
      { ...pageSender(), tab: undefined },
      { ...pageSender(), url: "chrome://settings/" },
      { ...pageSender(), url: "https://user:password@example.com/article" },
      { id: "test-extension", url: "chrome-extension://test-extension/popup.html" },
    ]) {
      expect(await worker.dispatch({ type: "overlay:state" }, sender)).toBeUndefined();
    }
    const state = await worker.dispatch({ type: "overlay:state" }, pageSender());
    expect(state.connection).toEqual({ connectionId: "connection-a", displayName: "Reader" });
    expect(state.page).toEqual({ annotations: [], draft: null });
    expect(JSON.stringify(state)).not.toContain(storage.connection.token);
  });

  test("drafts are restored only for their exact page and account", async () => {
    const storage = { connection: connection() };
    const worker = createWorker(storage, fetch);
    const draft = overlayDraft();
    expect((await worker.dispatch({ type: "overlay:draft", draft }, pageSender())).ok).toBe(true);
    expect((await worker.dispatch({ type: "overlay:state" }, pageSender())).page.draft).toEqual(draft);
    for (const url of ["https://example.com/other", "https://example.com/article?next=1", "https://example.com/article#section"]) {
      expect((await worker.dispatch({ type: "overlay:state" }, pageSender(url))).page.draft).toBeNull();
    }
    storage.connection.connectionId = "connection-b";
    expect((await worker.dispatch({ type: "overlay:state" }, pageSender())).page.draft).toBeNull();
    expect((await worker.dispatch({ type: "overlay:draft", draft, connectionId: "connection-a" }, pageSender())).error).toContain("account changed");
    storage.connection.connectionId = "connection-a";
    expect((await worker.dispatch({ type: "overlay:state" }, pageSender())).page.draft).toEqual(draft);
    expect((await worker.dispatch({ type: "overlay:draft", draft: { ...draft, content: 42 } }, pageSender())).error).toContain("Invalid content");
    expect((await worker.dispatch({ type: "overlay:state" }, pageSender())).page.draft).toEqual(draft);
  });

  test("save failures survive a worker restart and retry commits an annotation exactly once", async () => {
    const storage: Record<string, any> = { connection: connection() };
    const draft = capture();
    const annotation = { anchor: overlayDraft().anchor };
    const first = createWorker(storage, (async () => { throw new TypeError("offline"); }) as typeof fetch);
    expect((await first.dispatch({ type: "overlay:save", capture: draft, annotation }, pageSender())).error).toContain("retry");
    expect(storage.pendingSave.overlayAnnotation.anchor).toEqual(annotation.anchor);
    expect((await first.dispatch({ type: "overlay:state" }, pageSender())).page.annotations).toEqual([]);
    const otherPage = await first.dispatch({ type: "overlay:state" }, pageSender("https://example.com/other"));
    expect(otherPage.pending).toBeNull();
    expect(otherPage.hasOtherPending).toBe(true);
    expect((await first.dispatch({ type: "overlay:retry" }, pageSender("https://example.com/other"))).error).toContain("no pending capture");
    expect((await first.dispatch({ type: "overlay:dismiss" }, pageSender("https://example.com/other"))).error).toContain("no pending capture");
    expect(storage.pendingSave.capture).toEqual(draft);
    const receipt = { id: "capture-a", createdAt: "2026-09-27T10:00:00.000Z" };
    let uploads = 0;
    const resumed = createWorker(storage, (async (_url, init) => {
      uploads++;
      expect(JSON.parse(String(init?.body))).toEqual(draft);
      return Response.json({ capture: { ...receipt, token: "do-not-forward-server-fields" } });
    }) as typeof fetch);
    expect((await resumed.dispatch({ type: "overlay:retry" }, pageSender())).receipt).toEqual(receipt);
    expect((await resumed.dispatch({ type: "overlay:retry" }, pageSender())).receipt).toEqual(receipt);
    expect(uploads).toBe(1);
    const state = await resumed.dispatch({ type: "overlay:state" }, pageSender());
    expect(state.page.annotations).toHaveLength(1);
    expect(state.page.annotations[0]).toMatchObject({ id: draft.clientCaptureId, captureId: "capture-a", comment: draft.comment, anchor: annotation.anchor });
    expect(state.pending.receipt).toEqual(receipt);
    expect(JSON.stringify(state)).not.toContain("do-not-forward-server-fields");
    await resumed.dispatch({ type: "overlay:dismiss" }, pageSender());
    expect(storage.pendingSave).toBeUndefined();
    expect((await resumed.dispatch({ type: "overlay:state" }, pageSender())).page.annotations).toHaveLength(1);
  });

  test("the popup can recover an overlay upload without losing its annotation", async () => {
    const draft = capture();
    const storage: Record<string, any> = { connection: connection() };
    const first = createWorker(storage, (async () => { throw new TypeError("offline"); }) as typeof fetch);
    await first.dispatch({ type: "overlay:save", capture: draft, annotation: { anchor: overlayDraft().anchor } }, pageSender());
    const resumed = createWorker(storage, (async () => Response.json({ capture: { id: "capture-recovered", createdAt: draft.capturedAt } })) as typeof fetch);
    await resumed.dispatch({ type: "retry" });
    const state = await resumed.dispatch({ type: "overlay:state" }, pageSender());
    expect(state.page.annotations[0].captureId).toBe("capture-recovered");
  });

  test("a worker stopped between receipt and annotation storage recovers its page index", async () => {
    const draft = capture();
    const receipt = { id: "already-saved", createdAt: draft.capturedAt };
    const storage: Record<string, any> = {
      connection: connection(),
      pendingSave: {
        connectionId: "connection-a", capture: draft, receipt,
        overlayAnnotation: {
          id: draft.clientCaptureId, title: draft.title, kind: draft.kind,
          excerpt: draft.content, comment: draft.comment, capturedAt: draft.capturedAt,
          anchor: overlayDraft().anchor,
        },
      },
    };
    const worker = createWorker(storage, (async () => { throw new Error("Must not upload twice"); }) as typeof fetch);
    const state = await worker.dispatch({ type: "overlay:state" }, pageSender());
    expect(state.page.annotations).toHaveLength(1);
    expect(state.page.annotations[0].captureId).toBe(receipt.id);
    expect((await worker.dispatch({ type: "overlay:state" }, pageSender())).page.annotations).toHaveLength(1);
    await worker.dispatch({ type: "dismiss" });
    expect(storage.pendingSave).toBeUndefined();
    expect((await worker.dispatch({ type: "overlay:state" }, pageSender())).page.annotations).toHaveLength(1);
  });

  test("the broker rejects forged source URLs and opens only a saved capture for this page and account", async () => {
    const storage: Record<string, any> = { connection: connection() };
    let uploads = 0;
    const draft = capture();
    const worker = createWorker(storage, (async () => {
      uploads++;
      return Response.json({ capture: { id: "capture & /?", createdAt: draft.capturedAt } });
    }) as typeof fetch);
    expect((await worker.dispatch({ type: "overlay:save", capture: { ...draft, sourceUrl: "https://example.com/other" } }, pageSender())).error).toContain("page changed");
    expect(uploads).toBe(0);
    expect(storage.pendingSave).toBeUndefined();
    expect((await worker.dispatch({ type: "overlay:open", captureId: "unknown", intent: "ask" }, pageSender())).error).toContain("does not belong");
    await worker.dispatch({ type: "overlay:save", capture: draft }, pageSender());
    await worker.dispatch({ type: "overlay:dismiss" }, pageSender());
    expect((await worker.dispatch({ type: "overlay:open", captureId: "capture & /?", intent: "ask" }, pageSender())).ok).toBe(true);
    const url = new URL(worker.openedTabs[0]);
    expect(url.origin).toBe("https://margin.example");
    expect(url.searchParams.get("capture")).toBe("capture & /?");
    expect(url.searchParams.get("intent")).toBe("ask");
    expect(url.searchParams.get("inbox")).toBe("1");
    expect((await worker.dispatch({ type: "overlay:open", captureId: "capture & /?", intent: "ask" }, pageSender("https://example.com/other"))).error).toContain("does not belong");
    storage.connection.connectionId = "connection-b";
    expect((await worker.dispatch({ type: "overlay:state" }, pageSender())).page.annotations).toEqual([]);
    expect((await worker.dispatch({ type: "overlay:open", captureId: "capture & /?", intent: "ask" }, pageSender())).error).toContain("does not belong");
    expect(worker.openedTabs).toHaveLength(1);
  });

  test("toolbar injects only in the isolated main frame and context selections keep their provenance", async () => {
    const storage: Record<string, any> = { connection: connection() };
    const worker = createWorker(storage, fetch);
    const tab = { id: 12, url: "https://example.com/article", title: "Article", windowId: 1 };
    await worker.clickAction(tab);
    expect(worker.injections).toHaveLength(2);
    expect(worker.injections[0]).toMatchObject({ target: { tabId: 12, frameIds: [0] }, world: "ISOLATED", files: ["overlay.js"] });
    expect(worker.injections[1].args).toEqual([tab.url, null]);
    await worker.clickMenu({ menuItemId: "save-selection", frameId: 0, pageUrl: tab.url, selectionText: "A passage" }, tab);
    expect(worker.injections[3].args).toEqual([tab.url, { text: "A passage", sourceUrl: tab.url, title: "Article" }]);
    await worker.clickMenu({ menuItemId: "save-selection", frameId: 4, frameUrl: "https://embedded.example/page", selectionText: "In a frame" }, tab);
    expect(worker.injections).toHaveLength(4);
    expect(storage.selectionDraft).toEqual({ text: "In a frame", sourceUrl: "https://embedded.example/page", title: "Article" });
    expect(worker.openedTabs).toEqual(["chrome-extension://test-extension/popup.html"]);
    await worker.clickAction({ id: 12, url: "chrome://extensions/" });
    expect(worker.injections).toHaveLength(4);
    expect(worker.openedTabs).toHaveLength(2);
  });

  test("settings and pending review stay in trusted extension pages", async () => {
    const worker = createWorker({}, fetch);
    expect((await worker.dispatch({ type: "overlay:settings" }, pageSender())).ok).toBe(true);
    expect(worker.optionsOpened()).toBe(1);
    expect((await worker.dispatch({ type: "overlay:pending" }, pageSender())).ok).toBe(true);
    expect(worker.openedTabs).toEqual(["chrome-extension://test-extension/popup.html"]);
  });
});
