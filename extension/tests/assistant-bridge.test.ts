import { beforeAll, describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { buildBackground } from "./background-build";

let background = "";
beforeAll(async () => { background = await buildBackground(); });
const sourceUrl = "https://example.com/article";
const origin = "chrome-extension://extension-test/";
const connection = { serverUrl: "https://margin.example", token: `mc_workspace_${"A".repeat(43)}`, connectionId: "account-a", displayName: "Reader", userId: "user-1" };
const anchor = { exact: "useful passage", prefix: "Before a ", suffix: " after.", start: 9, end: 23 };
const thread = (overrides: Record<string, unknown> = {}) => ({ id: "thread-0001", createdAt: "2026-10-06T10:00:00.000Z", sourceUrl, title: "Article", quote: "useful passage", anchor, intent: "ask", prompt: "SECRET PROMPT", answer: "SECRET ANSWER", pinned: false, ...overrides });
const pageSender = (url = sourceUrl, documentId = "source-document") => ({ id: "extension-test", url, frameId: 0, documentId, tab: { id: 12, url } });
const assistantSender = (session: string, tabId = 12) => ({ id: "extension-test", url: `${origin}assistant.html?tab=${tabId}&session=${session}`, frameId: 4, tab: { id: tabId, url: sourceUrl } });
const workspaceSender = (session: string) => ({ id: "extension-test", url: `${origin}workspace.html?tab=12&session=${session}`, frameId: 3, tab: { id: 12, url: sourceUrl } });

function worker(local: Record<string, any> = { connection: structuredClone(connection) }, session: Record<string, any> = {}) {
  let listener: (...args: any[]) => any;
  const pageMessages: any[] = [];
  const pageReplies: Record<string, any> = {};
  const area = (data: Record<string, any>) => ({ async get(key: string) { return { [key]: structuredClone(data[key]) }; }, async set(value: Record<string, any>) { Object.assign(data, structuredClone(value)); }, async remove(key: string) { delete data[key]; }, async setAccessLevel() {} });
  const chrome = {
    runtime: { id: "extension-test", getURL: (path: string) => origin + path, onInstalled: { addListener() {} }, onMessage: { addListener(fn: typeof listener) { listener = fn; } }, async openOptionsPage() {} },
    contextMenus: { onClicked: { addListener() {} } }, action: { onClicked: { addListener() {} } },
    tabs: { async get() { return { id: 12, url: sourceUrl }; }, async sendMessage(tabId: number, message: any, options: unknown) { pageMessages.push(structuredClone({ tabId, message, options })); return structuredClone(pageReplies[message.type] ?? { ok: true }); } },
    storage: { local: area(local), session: area(session), onChanged: { addListener() {} } },
  };
  runInNewContext(background, { chrome, crypto, URL, AbortSignal, fetch: async () => { throw new Error("The worker must not call the network for assistant messages."); } });
  return { local, pageMessages, pageReplies, dispatch(message: Record<string, unknown>, sender: Record<string, unknown>): Promise<any> { return new Promise((resolve) => { if (!listener(message, sender, resolve)) resolve(undefined); }); } };
}
async function bind(h: ReturnType<typeof worker>) {
  const registration = await h.dispatch({ type: "overlay:frame" }, pageSender());
  const base = { tabId: 12, session: registration.session, connectionId: "account-a" };
  return { session: registration.session as string, base, card: assistantSender(registration.session) };
}

describe("assistant frame validation", () => {
  test("only the registered tab, exact assistant page, and nonce can act", async () => {
    const h = worker(); const b = await bind(h);
    const request = { ...b.base, type: "assistant:connect" };
    expect(await h.dispatch(request, b.card)).toEqual({ tabId: 12, sourceUrl, connection: { connectionId: "account-a", displayName: "Reader", userId: "user-1" } });
    // A different sender kind is ignored entirely (no response), not merely rejected.
    for (const sender of [pageSender(), { ...b.card, id: "other-extension" }, workspaceSender(b.session), { ...b.card, url: `${origin}assistant.html.evil?tab=12&session=${b.session}` }, { ...b.card, url: `${origin}popup.html` }])
      expect(await h.dispatch(request, sender)).toBeUndefined();
    for (const sender of [{ ...b.card, tab: { id: 13 } }, { ...b.card, frameId: 0 }, { ...b.card, tab: undefined }, { ...b.card, url: `${origin}assistant.html?tab=12&session=wrong` }])
      expect((await h.dispatch(request, sender))?.error).toBeDefined();
    expect((await h.dispatch({ ...request, session: "wrong" }, b.card)).error).toBeDefined();
    expect(JSON.stringify(await h.dispatch(request, b.card))).not.toContain(connection.token);
  });
  test("the workspace frame cannot use assistant actions and the assistant cannot use workspace actions", async () => {
    const h = worker(); const b = await bind(h);
    expect(await h.dispatch({ ...b.base, type: "assistant:connect" }, workspaceSender(b.session))).toBeUndefined();
    expect(await h.dispatch({ ...b.base, type: "workspace:connect" }, b.card)).toBeUndefined();
  });
  test("every account-bound action refuses a stale or missing account", async () => {
    const h = worker(); const b = await bind(h);
    for (const type of ["request", "article", "close", "thread-save", "thread-get", "thread-pin", "thread-delete", "open-workspace"]) {
      expect((await h.dispatch({ ...b.base, connectionId: "previous", type: `assistant:${type}`, id: "thread-0001", thread: thread() }, b.card)).error).toContain("account changed");
      expect((await h.dispatch({ tabId: 12, session: b.session, type: `assistant:${type}`, id: "thread-0001", thread: thread() }, b.card)).error).toContain("account changed");
    }
    expect(h.pageMessages).toHaveLength(0);
    expect(h.local["pageThreads:account-a"]).toBeUndefined();
  });
});

describe("page-derived requests", () => {
  test("forwards the request lookup and article read to the page with the session", async () => {
    const h = worker(); const b = await bind(h);
    h.pageReplies["margin:page-request"] = { quote: "useful passage", anchor, title: "Article", sourceUrl, intent: "ask" };
    expect((await h.dispatch({ ...b.base, type: "assistant:request", id: "r1", privateNotes: "Never forward" }, b.card)).quote).toBe("useful passage");
    expect(h.pageMessages[0]).toEqual({ tabId: 12, message: { type: "margin:page-request", session: b.session, id: "r1" }, options: { frameId: 0 } });
    h.pageReplies["margin:page-article"] = { content: "Page text", title: "Article", sourceUrl };
    expect((await h.dispatch({ ...b.base, type: "assistant:article" }, b.card)).content).toBe("Page text");
    expect(JSON.stringify(h.pageMessages)).not.toContain("Never forward");
  });
  test("an unreadable page is reported as unavailable context, not as a failure", async () => {
    const h = worker(); const b = await bind(h);
    h.pageReplies["margin:page-article"] = { error: "No readable article found." };
    expect(await h.dispatch({ ...b.base, type: "assistant:article" }, b.card)).toEqual({ unavailable: "No readable article found." });
  });
  test("a failed request lookup is an error the card can show", async () => {
    const h = worker(); const b = await bind(h);
    h.pageReplies["margin:page-request"] = { error: "Select the passage again." };
    expect((await h.dispatch({ ...b.base, type: "assistant:request", id: "r1" }, b.card)).error).toBe("Select the passage again.");
  });
});

describe("conversation storage", () => {
  test("saves a finished answer for the account, only for the card's own page", async () => {
    const h = worker(); const b = await bind(h);
    expect((await h.dispatch({ ...b.base, type: "assistant:thread-save", thread: thread() }, b.card)).ok).toBe(true);
    expect(h.local["pageThreads:account-a"]).toHaveLength(1);
    expect(h.local["pageThreads:account-a"][0]).toMatchObject({ id: "thread-0001", answer: "SECRET ANSWER", pinned: false });
    expect((await h.dispatch({ ...b.base, type: "assistant:thread-save", thread: thread({ id: "thread-0002", sourceUrl: "https://example.com/other" }) }, b.card)).error).toContain("page changed");
    expect((await h.dispatch({ ...b.base, type: "assistant:thread-save", thread: thread({ id: "thread-0003", answer: "" }) }, b.card)).error).toBeDefined();
    expect(h.local["pageThreads:account-a"]).toHaveLength(1);
  });
  test("a full queue refuses the save with a message the reader can act on and leaves storage intact", async () => {
    const h = worker(); const b = await bind(h);
    h.local["pageThreads:account-a"] = Array.from({ length: 500 }, (_, index) => thread({ id: `thread-${String(index).padStart(4, "0")}`, pinned: true }));
    const before = structuredClone(h.local["pageThreads:account-a"]);
    const result = await h.dispatch({ ...b.base, type: "assistant:thread-save", thread: thread({ id: "thread-new0" }) }, b.card);
    expect(result.error).toContain("Open the Margin Chat workspace");
    expect(h.local["pageThreads:account-a"]).toEqual(before);
  });
  test("tells the page about pinned passages with anchors only, never private text", async () => {
    const h = worker(); const b = await bind(h);
    await h.dispatch({ ...b.base, type: "assistant:thread-save", thread: thread({ pinned: true }) }, b.card);
    const push = h.pageMessages.find((item) => item.message.type === "margin:page-notes");
    expect(push).toEqual({ tabId: 12, message: { type: "margin:page-notes", session: b.session, notes: [{ id: "thread-0001", anchor }] }, options: { frameId: 0 } });
    expect(JSON.stringify(h.pageMessages)).not.toContain("SECRET");
    h.pageMessages.length = 0;
    await h.dispatch({ ...b.base, type: "assistant:thread-pin", id: "thread-0001", pinned: false }, b.card);
    expect(h.pageMessages[0].message.notes).toEqual([]);
    await h.dispatch({ ...b.base, type: "assistant:thread-pin", id: "thread-0001", pinned: true }, b.card);
    expect(h.pageMessages[1].message.notes).toHaveLength(1);
    await h.dispatch({ ...b.base, type: "assistant:thread-delete", id: "thread-0001" }, b.card);
    expect(h.local["pageThreads:account-a"]).toEqual([]);
    expect(h.pageMessages[2].message.notes).toEqual([]);
  });
  test("the page can fetch its notes' anchors, and only its own account's", async () => {
    const h = worker(); const b = await bind(h);
    await h.dispatch({ ...b.base, type: "assistant:thread-save", thread: thread({ pinned: true }) }, b.card);
    h.local["pageThreads:account-b"] = [thread({ id: "thread-other", pinned: true })];
    const result = await h.dispatch({ type: "overlay:notes" }, pageSender());
    expect(result).toEqual({ notes: [{ id: "thread-0001", anchor }] });
    expect(await h.dispatch({ type: "overlay:notes" }, pageSender("https://example.com/elsewhere"))).toEqual({ notes: [] });
    // A card frame is not the page broker.
    expect(await h.dispatch({ type: "overlay:notes" }, b.card)).toBeUndefined();
  });
  test("a card cannot read, pin, delete, or open a conversation from another page", async () => {
    const h = worker(); const b = await bind(h);
    h.local["pageThreads:account-a"] = [thread({ id: "thread-away", sourceUrl: "https://example.com/elsewhere" })];
    for (const type of ["thread-get", "thread-pin", "thread-delete", "open-workspace"])
      expect((await h.dispatch({ ...b.base, type: `assistant:${type}`, id: "thread-away" }, b.card)).error).toContain("does not belong to this page");
    expect(h.local["pageThreads:account-a"]).toHaveLength(1);
    expect(h.pageMessages).toHaveLength(0);
  });
  test("opening the workspace marks the thread for focus and asks the page to show the panel", async () => {
    const h = worker(); const b = await bind(h);
    await h.dispatch({ ...b.base, type: "assistant:thread-save", thread: thread() }, b.card);
    h.pageMessages.length = 0;
    expect((await h.dispatch({ ...b.base, type: "assistant:open-workspace", id: "thread-0001" }, b.card)).ok).toBe(true);
    expect(h.local["pageThreads:account-a"][0].openRequestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(h.pageMessages).toEqual([{ tabId: 12, message: { type: "margin:page-open-workspace", session: b.session }, options: { frameId: 0 } }]);
  });
});

describe("workspace import queue", () => {
  const request = (b: Awaited<ReturnType<typeof bind>>, type: string, extra: Record<string, unknown> = {}) => ({ ...b.base, sourceUrl, type: `workspace:${type}`, ...extra });
  test("hands unimported conversations to the workspace once and remembers the import", async () => {
    const h = worker(); const b = await bind(h);
    await h.dispatch({ ...b.base, type: "assistant:thread-save", thread: thread() }, b.card);
    await h.dispatch({ ...b.base, type: "assistant:thread-save", thread: thread({ id: "thread-0002", prompt: "Second" }) }, b.card);
    const frame = workspaceSender(b.session);
    const first = await h.dispatch(request(b, "threads"), frame);
    expect(first.threads.map((item: any) => item.id)).toEqual(["thread-0001", "thread-0002"]); // oldest first
    expect(first.threads[0].answer).toBe("SECRET ANSWER"); // the workspace is trusted with full content
    expect((await h.dispatch(request(b, "thread-imported", { id: "thread-0001" }), frame)).ok).toBe(true);
    expect((await h.dispatch(request(b, "threads"), frame)).threads.map((item: any) => item.id)).toEqual(["thread-0002"]);
    expect(h.local["pageThreads:account-a"].find((item: any) => item.id === "thread-0001").importedAt).toBeDefined();
  });
  test("an open request is delivered again after import, and a newer one survives an older acknowledgement", async () => {
    const h = worker(); const b = await bind(h); const frame = workspaceSender(b.session);
    await h.dispatch({ ...b.base, type: "assistant:thread-save", thread: thread() }, b.card);
    await h.dispatch(request(b, "thread-imported", { id: "thread-0001" }), frame);
    await h.dispatch({ ...b.base, type: "assistant:open-workspace", id: "thread-0001" }, b.card);
    const first = (await h.dispatch(request(b, "threads"), frame)).threads[0];
    expect(first.openRequestId).toBeDefined();
    await h.dispatch({ ...b.base, type: "assistant:open-workspace", id: "thread-0001" }, b.card); // reader clicks again
    await h.dispatch(request(b, "thread-imported", { id: "thread-0001", openRequestId: first.openRequestId }), frame);
    const after = (await h.dispatch(request(b, "threads"), frame)).threads;
    expect(after).toHaveLength(1);
    expect(after[0].openRequestId).not.toBe(first.openRequestId);
    await h.dispatch(request(b, "thread-imported", { id: "thread-0001", openRequestId: after[0].openRequestId }), frame);
    expect((await h.dispatch(request(b, "threads"), frame)).threads).toEqual([]);
  });
  test("is refused for another account and from the page or a card", async () => {
    const h = worker(); const b = await bind(h);
    await h.dispatch({ ...b.base, type: "assistant:thread-save", thread: thread() }, b.card);
    expect((await h.dispatch(request(b, "threads", { connectionId: "account-b" }), workspaceSender(b.session))).error).toContain("account changed");
    expect(await h.dispatch(request(b, "threads"), b.card)).toBeUndefined();
    expect(await h.dispatch(request(b, "threads"), pageSender())).toBeUndefined();
  });
});
