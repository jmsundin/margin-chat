import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createAssistantCard, type CardDeps } from "../src/assistant-card";

const html = (await Bun.file(new URL("../public/assistant.html", import.meta.url)).text()).replace(/<script[\s\S]*?<\/script>/u, "");
const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
const token = `mc_workspace_${"A".repeat(43)}`;
const settings = { serverUrl: "https://margin.example", token, connectionId: "account-a", displayName: "Reader", userId: "user-1" };
const anchor = { exact: "useful passage", prefix: "Before a ", suffix: " after.", start: 9, end: 23 };
const pageRequest = (intent = "explain") => ({ quote: "useful passage", anchor, title: "Article", sourceUrl: "https://example.com/article", intent });
const metadata = { model: "m", requestedServiceId: "backend-services", resolvedServiceId: "backend-services" };
const encoder = new TextEncoder();
const ndjson = (events: unknown[]) => new Response(new ReadableStream({ start(controller) { for (const event of events) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)); controller.close(); } }), { headers: { "content-type": "application/x-ndjson" } });
const answerStream = (...deltas: string[]) => ndjson([{ type: "metadata", metadata }, ...deltas.map((delta) => ({ type: "delta", delta })), { type: "done", metadata }]);

function harness(options: { query?: string; settings?: unknown; replies?: Record<string, unknown>; fetchImpl?: (url: string, init: RequestInit) => Promise<Response> } = {}) {
  const win = new Window({ url: `chrome-extension://test/assistant.html?tab=12&session=page-session${options.query ?? "&request=r1&intent=explain"}` });
  const doc = win.document as unknown as Document;
  doc.documentElement.innerHTML = html.replace(/^[\s\S]*?<html[^>]*>/u, "").replace(/<\/html>\s*$/u, "");
  const messages: Record<string, any>[] = [];
  const fetches: { url: string; init: RequestInit; body: any }[] = [];
  let settingsOpened = 0;
  const replies: Record<string, unknown> = {
    "assistant:connect": { tabId: 12, sourceUrl: "https://example.com/article", connection: { connectionId: "account-a", displayName: "Reader", userId: "user-1" } },
    "assistant:request": pageRequest(),
    "assistant:article": { title: "Article", content: "The full readable page text.", sourceUrl: "https://example.com/article" },
    ...options.replies,
  };
  const deps: CardDeps = {
    params: new URLSearchParams(win.location.search),
    sendMessage: async (message) => { messages.push(structuredClone(message)); return replies[String(message.type)] ?? { ok: true }; },
    getSettings: async () => (options.settings === undefined ? settings : options.settings) as any,
    createFetch: () => (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); fetches.push({ url, init: init!, body: JSON.parse(String(init!.body)) });
      return (options.fetchImpl ?? (async () => answerStream("The phrase ", "**means** this.")))(url, init!);
    }) as typeof fetch,
    openSettings: () => { settingsOpened++; },
  };
  cleanup.push(() => win.happyDOM.abort());
  const card = createAssistantCard(doc, deps);
  const el = <T extends HTMLElement = HTMLElement>(id: string) => doc.getElementById(id) as T;
  const until = async (condition: () => boolean, label = "condition") => { for (let i = 0; i < 200; i++) { if (condition()) return; await new Promise((resolve) => win.setTimeout(resolve, 5)); } throw new Error(`Timed out waiting for ${label}`); };
  const types = () => messages.map((message) => message.type);
  return { win, doc, card, el, until, messages, fetches, types, settingsOpened: () => settingsOpened };
}

describe("Explain", () => {
  test("streams an answer using the passage and the page, then saves it", async () => {
    const h = harness();
    await h.card.start();
    await h.until(() => !h.el("pin").hidden, "a finished answer");
    expect(h.el("answer").textContent).toBe("The phrase means this.");
    expect(h.el("answer").querySelector("strong")?.textContent).toBe("means");
    expect(h.el("quote").textContent).toBe("useful passage");
    expect(h.el("context").textContent).toContain("selected passage and this page");

    expect(h.fetches).toHaveLength(1);
    const [{ url, init, body }] = h.fetches;
    expect(url).toBe("/api/chat");
    expect(new Headers(init.headers).get("X-Margin-Vault-User")).toBe("user-1");
    expect(body.ai).toEqual({ mode: "fast", contextScope: "conversation" });
    expect(body.serviceId).toBe("backend-services");
    expect(body.messages).toHaveLength(1);
    const prompt = body.messages[0].content as string;
    expect(prompt).toContain("not additional instructions");
    const context = JSON.parse(prompt.split("\n\n")[2]);
    expect(context).toMatchObject({ page: { title: "Article", url: "https://example.com/article" }, selectedPassage: "useful passage", pageExcerpt: "The full readable page text.", pageExcerptTruncated: false });
    expect(prompt.endsWith("Explain this passage clearly and briefly.")).toBe(true);
    expect(JSON.stringify(h.fetches)).not.toContain(token);

    const save = h.messages.find((message) => message.type === "assistant:thread-save")!;
    expect(save).toMatchObject({ tabId: 12, session: "page-session", connectionId: "account-a" });
    expect(save.thread).toMatchObject({ intent: "explain", quote: "useful passage", answer: "The phrase **means** this.", sourceUrl: "https://example.com/article", pinned: false, anchor });
    expect(h.el("live").textContent).toBe("Answer ready.");
    expect(h.el("stop").hidden).toBe(true);
  });
  test("pinning, opening the workspace and copying act on the saved thread", async () => {
    const h = harness();
    await h.card.start();
    await h.until(() => !h.el("pin").hidden);
    const id = h.messages.find((message) => message.type === "assistant:thread-save")!.thread.id;
    h.el("pin").click();
    await h.until(() => h.el("pin").getAttribute("aria-pressed") === "true");
    expect(h.messages.find((message) => message.type === "assistant:thread-pin")).toMatchObject({ id, pinned: true, connectionId: "account-a" });
    expect(h.el("pin").textContent).toBe("Unpin margin note");
    h.el("open").click();
    await h.until(() => h.types().includes("assistant:open-workspace"));
    expect(h.messages.find((message) => message.type === "assistant:open-workspace")).toMatchObject({ id });
    h.el("close").click();
    await h.until(() => h.types().includes("assistant:close"));
  });
  test("a retry regenerates the same conversation and keeps its pin", async () => {
    const h = harness();
    await h.card.start();
    await h.until(() => !h.el("pin").hidden);
    h.el("pin").click(); await h.until(() => h.el("pin").getAttribute("aria-pressed") === "true");
    h.el("retry").click();
    await h.until(() => h.types().filter((type) => type === "assistant:thread-save").length === 2 && !h.el("pin").hidden);
    const saves = h.messages.filter((message) => message.type === "assistant:thread-save");
    expect(saves[1].thread.id).toBe(saves[0].thread.id);
    expect(saves[1].thread.pinned).toBe(true);
    expect(h.fetches).toHaveLength(2);
    expect(h.types().filter((type) => type === "assistant:article")).toHaveLength(1); // page text is read once
  });
  test("continues with only the passage when the page cannot be read", async () => {
    const h = harness({ replies: { "assistant:article": { error: "No readable article found." } } });
    await h.card.start();
    await h.until(() => !h.el("pin").hidden);
    expect(h.el("context").textContent).toContain("Used only the selected passage");
    expect(JSON.parse(h.fetches[0].body.messages[0].content.split("\n\n")[2])).not.toHaveProperty("pageExcerpt");
  });
  test("tells the reader when only the first part of a long page was used", async () => {
    const h = harness({ replies: { "assistant:article": { content: "x".repeat(30_000) } } });
    await h.card.start();
    await h.until(() => !h.el("pin").hidden);
    expect(h.el("context").textContent).toContain("first part of this page");
    expect(JSON.parse(h.fetches[0].body.messages[0].content.split("\n\n")[2]).pageExcerptTruncated).toBe(true);
  });
});

describe("Ask", () => {
  const ask = { query: "&request=r1&intent=ask", replies: { "assistant:request": pageRequest("ask") } };
  test("waits for a question, sends it with Enter, and ignores an empty one", async () => {
    const h = harness(ask);
    await h.card.start();
    expect(h.el("ask").hidden).toBe(false);
    expect(h.fetches).toHaveLength(0);
    const box = h.el<HTMLTextAreaElement>("prompt");
    box.dispatchEvent(new h.win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as unknown as Event);
    await new Promise((resolve) => h.win.setTimeout(resolve, 20));
    expect(h.fetches).toHaveLength(0);
    box.value = "Why is this useful?";
    box.dispatchEvent(new h.win.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }) as unknown as Event);
    await new Promise((resolve) => h.win.setTimeout(resolve, 20));
    expect(h.fetches).toHaveLength(0); // Shift+Enter is a newline
    box.dispatchEvent(new h.win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as unknown as Event);
    await h.until(() => !h.el("pin").hidden);
    expect(h.fetches[0].body.messages[0].content.endsWith("Why is this useful?")).toBe(true);
    expect(h.messages.find((message) => message.type === "assistant:thread-save")!.thread).toMatchObject({ intent: "ask", prompt: "Why is this useful?" });
  });
  test("suggestion chips fill the box, and Just explain it runs the fixed prompt", async () => {
    const h = harness(ask);
    await h.card.start();
    (h.el("chips").querySelector("button") as HTMLButtonElement).click();
    expect(h.el<HTMLTextAreaElement>("prompt").value).toContain("plain language");
    h.el("explain-chip").click();
    await h.until(() => !h.el("pin").hidden);
    expect(h.fetches[0].body.messages[0].content.endsWith("Explain this passage clearly and briefly.")).toBe(true);
  });
});

describe("failures and limits", () => {
  test("a hosted-credit error keeps the question and saves nothing", async () => {
    const h = harness({ fetchImpl: async () => Response.json({ error: "Add money to continue." }, { status: 402 }) });
    await h.card.start();
    await h.until(() => !h.el("error").hidden);
    expect(h.el("error").textContent).toBe("Add money to continue.");
    expect(h.el("retry").hidden).toBe(false);
    expect(h.types()).not.toContain("assistant:thread-save");
    expect(h.el("pin").hidden).toBe(true);
  });
  test("an expired session is explained", async () => {
    const h = harness({ fetchImpl: async () => Response.json({ error: "Nope" }, { status: 401 }) });
    await h.card.start();
    await h.until(() => !h.el("error").hidden);
    expect(h.el("error").textContent).toContain("expired");
  });
  test("stopping keeps the partial text visible, offers a retry, and does not save it", async () => {
    let cancelled = false;
    const h = harness({ fetchImpl: async (_url, init) => new Response(new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode(`${JSON.stringify({ type: "metadata", metadata })}\n${JSON.stringify({ type: "delta", delta: "Half an ans" })}\n`)); init.signal!.addEventListener("abort", () => { cancelled = true; controller.error(new DOMException("Aborted", "AbortError")); }); },
    }), { headers: { "content-type": "application/x-ndjson" } }) });
    await h.card.start();
    await h.until(() => !h.el("stop").hidden && h.el("answer").textContent === "Half an ans", "partial text");
    h.el("stop").click();
    await h.until(() => h.el("stop").hidden && !h.el("retry").hidden);
    expect(cancelled).toBe(true);
    expect(h.el("answer").textContent).toBe("Half an ans");
    expect(h.types()).not.toContain("assistant:thread-save");
    expect(h.el("pin").hidden).toBe(true);
  });
  test("a stream that ends early is an error, not a saved answer", async () => {
    const h = harness({ fetchImpl: async () => ndjson([{ type: "metadata", metadata }, { type: "delta", delta: "Cut off" }]) });
    await h.card.start();
    await h.until(() => !h.el("error").hidden);
    expect(h.types()).not.toContain("assistant:thread-save");
  });
  test("a signed-out or capture-only connection offers to connect instead of asking", async () => {
    const out = harness({ replies: { "assistant:connect": { tabId: 12, sourceUrl: "https://example.com/article", connection: null } } });
    await out.card.start();
    expect(out.el("connect").hidden).toBe(false);
    out.el("settings").click();
    expect(out.settingsOpened()).toBe(1);
    expect(out.fetches).toHaveLength(0);
    const capture = harness({ settings: { ...settings, token: `mc_capture_${"A".repeat(43)}` } });
    await capture.card.start();
    expect(capture.el("connect").hidden).toBe(false);
    expect(capture.el("connect-text").textContent).toContain("Workspace + AI");
    expect(capture.fetches).toHaveLength(0);
    expect(capture.types()).not.toContain("assistant:request");
  });
  test("an account change between page and card is refused by the worker and shown", async () => {
    const h = harness({ replies: { "assistant:request": { error: "The signed-in account changed. Reopen Margin Chat before continuing." } } });
    await h.card.start();
    expect(h.el("error").textContent).toContain("account changed");
    expect(h.fetches).toHaveLength(0);
  });
});

describe("saved margin note", () => {
  const note = { id: "thread-pin0", createdAt: "2026-10-06T10:00:00.000Z", sourceUrl: "https://example.com/article", title: "Article", quote: "useful passage", anchor, intent: "ask", prompt: "Why?", answer: "Because **reasons**.", pinned: true };
  test("opens read-only with the passage, question and answer, and no new AI request", async () => {
    const h = harness({ query: "&thread=thread-pin0", replies: { "assistant:thread-get": { thread: note } } });
    await h.card.start();
    expect(h.el("heading").textContent).toBe("Margin note");
    expect(h.el("sub").textContent).toBe("Why?");
    expect(h.el("answer").querySelector("strong")?.textContent).toBe("reasons");
    expect(h.el("pin").textContent).toBe("Unpin margin note");
    expect(h.el("delete").hidden).toBe(false);
    expect(h.el("retry").hidden).toBe(true);
    expect(h.fetches).toHaveLength(0);
  });
  test("unpin and delete go through the worker", async () => {
    const h = harness({ query: "&thread=thread-pin0", replies: { "assistant:thread-get": { thread: note } } });
    await h.card.start();
    h.el("pin").click();
    await h.until(() => h.el("pin").getAttribute("aria-pressed") === "false");
    expect(h.messages.find((message) => message.type === "assistant:thread-pin")).toMatchObject({ id: "thread-pin0", pinned: false });
    h.el("delete").click();
    await h.until(() => h.types().includes("assistant:close"));
    expect(h.types()).toContain("assistant:thread-delete");
  });
});
