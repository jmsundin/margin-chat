import { beforeAll, describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { buildBackground } from "./background-build";

let background = "";
beforeAll(async () => {
  background = await buildBackground();
});
const sourceUrl = "https://example.com/article";
const origin = "chrome-extension://extension-test/";
const connection = { serverUrl: "https://margin.example", token: `mc_capture_${"A".repeat(43)}`, connectionId: "account-a", displayName: "Reader" };
const pageSender = (url = sourceUrl, documentId = "source-document") => ({ id: "extension-test", url, frameId: 0, documentId, tab: { id: 12, url } });
function worker(local: Record<string, any> = { connection: structuredClone(connection) }, session: Record<string, any> = {}) {
  let listener: (...args: any[]) => any;
  let tabUrl = sourceUrl;
  const pageMessages: any[] = [];
  let pageResponse: any = { title: "Article", sourceUrl, kind: "selection", content: "A passage", revision: 1 };
  const area = (data: Record<string, any>) => ({ async get(key: string) { return { [key]: structuredClone(data[key]) }; }, async set(value: Record<string, any>) { Object.assign(data, structuredClone(value)); }, async remove(key: string) { delete data[key]; }, async setAccessLevel() {} });
  const chrome = {
    runtime: { id: "extension-test", getURL: (path: string) => origin + path, onInstalled: { addListener() {} }, onMessage: { addListener(fn: typeof listener) { listener = fn; } }, async openOptionsPage() {} },
    contextMenus: { onClicked: { addListener() {} } }, action: { onClicked: { addListener() {} } },
    tabs: { async get(tabId: number) { if (tabId !== 12) throw new Error("Tab missing"); return { id: 12, url: tabUrl }; }, async sendMessage(tabId: number, message: unknown, options: unknown) { pageMessages.push({ tabId, message, options }); return structuredClone(pageResponse); }, async create() {} },
    storage: { local: area(local), session: area(session), onChanged: { addListener() {} } },
  };
  runInNewContext(background, { chrome, crypto, URL, AbortSignal, fetch: async () => Response.json({ capture: { id: "saved-capture", createdAt: new Date().toISOString() } }) });
  return {
    local, session, pageMessages,
    set tabUrl(value: string) { tabUrl = value; }, set pageResponse(value: any) { pageResponse = value; },
    dispatch(message: Record<string, unknown>, sender: Record<string, unknown>): Promise<any> { return new Promise((resolve) => { if (!listener(message, sender, resolve)) resolve(undefined); }); },
  };
}
function frameSender(session: string, tabId = 12) { return { id: "extension-test", url: `${origin}workspace.html?tab=${tabId}&session=${session}`, frameId: 3, tab: { id: tabId, url: sourceUrl } }; }
async function connect(h: ReturnType<typeof worker>) {
  const registration = await h.dispatch({ type: "overlay:frame" }, pageSender());
  return { sender: frameSender(registration.session), message: { tabId: 12, session: registration.session, connectionId: "account-a", sourceUrl } };
}

describe("extension-origin workspace bridge", () => {
  test("requires the registered source tab, exact extension frame, and a valid nonce", async () => {
    const h = worker();
    const binding = await connect(h);
    const request = { ...binding.message, type: "workspace:connect" };
    expect(await h.dispatch(request, binding.sender)).toEqual({ tabId: 12, sourceUrl, connection: { connectionId: "account-a", displayName: "Reader" } });
    for (const sender of [pageSender(), { ...binding.sender, id: "other-extension" }, { ...binding.sender, url: `${origin}popup.html` }, { ...binding.sender, url: `${origin}workspace.html.evil?tab=12&session=${binding.message.session}` }]) expect(await h.dispatch(request, sender)).toBeUndefined();
    for (const sender of [{ ...binding.sender, tab: { id: 13 } }, { ...binding.sender, frameId: 0 }, { ...binding.sender, tab: undefined }, { ...binding.sender, url: `${origin}workspace.html?tab=12&session=wrong` }]) expect((await h.dispatch(request, sender)).error).toBeDefined();
    expect((await h.dispatch({ ...request, session: "wrong" }, binding.sender)).error).toBeDefined();
    expect(JSON.stringify(await h.dispatch(request, binding.sender))).not.toContain(connection.token);
    expect(h.pageMessages).toHaveLength(0);
  });
  test("survives worker restart but rotates the nonce for a different source document", async () => {
    const h = worker(); const binding = await connect(h);
    const resumed = worker(h.local, h.session);
    expect((await resumed.dispatch({ ...binding.message, type: "workspace:connect" }, binding.sender)).connection.connectionId).toBe("account-a");
    expect((await resumed.dispatch({ type: "overlay:frame" }, pageSender())).session).toBe(binding.message.session);
    const newFrame = await resumed.dispatch({ type: "overlay:frame" }, pageSender(sourceUrl, "replacement-document"));
    expect(newFrame.session).not.toBe(binding.message.session);
    expect((await resumed.dispatch({ ...binding.message, type: "workspace:state" }, binding.sender)).error).toContain("expired");
  });
  test("updates source for same-document navigation and rejects stale source saves", async () => {
    const h = worker(); const binding = await connect(h);
    const next = "https://example.com/next"; h.tabUrl = next;
    expect((await h.dispatch({ ...binding.message, type: "workspace:connect" }, binding.sender)).error).toContain("page changed");
    expect((await h.dispatch({ type: "overlay:page", session: binding.message.session }, pageSender(next, "wrong-document"))).error).toBeDefined();
    expect((await h.dispatch({ type: "overlay:page", session: binding.message.session }, pageSender(next))).ok).toBe(true);
    expect((await h.dispatch({ ...binding.message, type: "workspace:connect" }, binding.sender)).sourceUrl).toBe(next);
    const queuedDraft = { kind: "selection", title: "Old page", content: "Old quotation", comment: "Private note" };
    expect((await h.dispatch({ ...binding.message, type: "workspace:draft", draft: queuedDraft }, binding.sender)).error).toContain("page changed");
    expect((await h.dispatch({ ...binding.message, type: "workspace:highlights", anchors: [] }, binding.sender)).error).toContain("page changed");
    const capture = { schemaVersion: 1, clientCaptureId: crypto.randomUUID(), kind: "selection", title: "Passage", sourceUrl, content: "A passage", comment: "Private", capturedAt: new Date().toISOString() };
    expect((await h.dispatch({ ...binding.message, type: "workspace:save", capture }, binding.sender)).error).toContain("page changed");
    expect(h.local.pendingSave).toBeUndefined();
  });
  test("account switches require refreshed connection identity without rebuilding the page frame", async () => {
    const h = worker(); const binding = await connect(h);
    h.local.connection.connectionId = "account-b";
    expect((await h.dispatch({ ...binding.message, type: "workspace:state" }, binding.sender)).error).toContain("account changed");
    expect((await h.dispatch({ ...binding.message, type: "workspace:connect" }, binding.sender)).connection.connectionId).toBe("account-b");
    expect((await h.dispatch({ ...binding.message, type: "workspace:state", connectionId: "account-b" }, binding.sender)).page.annotations).toEqual([]);
    expect(h.pageMessages).toHaveLength(0);
  });
  test("forwards only context requests and sanitized quote anchors into the page", async () => {
    const h = worker(); const binding = await connect(h);
    expect((await h.dispatch({ ...binding.message, type: "workspace:context", kind: "current", privateNotes: "Never forward" }, binding.sender)).content).toBe("A passage");
    expect(h.pageMessages[0]).toEqual({ tabId: 12, message: { type: "margin:page-context", kind: "current", session: binding.message.session }, options: { frameId: 0 } });
    const anchor = { exact: "A passage", prefix: "", suffix: "", start: 0, end: 9 };
    h.pageResponse = { located: true };
    expect((await h.dispatch({ ...binding.message, type: "workspace:locate", anchor: { ...anchor, privateNotes: "Never forward" } }, binding.sender)).located).toBe(true);
    expect(h.pageMessages[1].message.anchor).toEqual(anchor);
    await h.dispatch({ ...binding.message, type: "workspace:highlights", anchors: [anchor], privateNotes: "Never forward" }, binding.sender);
    expect(JSON.stringify(h.pageMessages)).not.toContain("Never forward");
    h.pageResponse = { title: "Wrong page", sourceUrl: "https://example.com/unrelated" };
    expect((await h.dispatch({ ...binding.message, type: "workspace:context" }, binding.sender)).error).toContain("page changed");
  });
  test("keeps private annotation and draft state in the extension frame", async () => {
    const h = worker(); const binding = await connect(h);
    const draft = { kind: "selection", title: "Private title", content: "Page quote", comment: "My private note", question: "Private AI question" };
    expect((await h.dispatch({ ...binding.message, type: "workspace:draft", draft }, binding.sender)).ok).toBe(true);
    expect((await h.dispatch({ ...binding.message, type: "workspace:state" }, binding.sender)).page.draft).toEqual(draft);
    expect(h.pageMessages).toHaveLength(0);
  });
});
