import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { captureTextAnchor } from "../src/anchors";
import { createSelectionAssistant } from "../src/selection-assistant";

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
const wait = (win: Window, ms = 5) => new Promise((resolve) => win.setTimeout(resolve, ms));

function harness(options: { notes?: unknown[]; registerFails?: boolean } = {}) {
  const win = new Window({ url: "https://example.com/article", settings: { disableIframePageLoading: true } });
  const doc = win.document as unknown as Document;
  doc.title = "Reading with context";
  doc.body.innerHTML = `<article><h1>Title</h1><p>Before a useful passage after.</p><p>Another paragraph for anchors.</p></article><form><textarea>Private draft text</textarea></form>`;
  let root!: ShadowRoot;
  const prototype = win.HTMLElement.prototype; const attach = prototype.attachShadow;
  prototype.attachShadow = function(init) { const shadow = attach.call(this, init); if (this.hasAttribute("data-margin-overlay")) root = shadow as unknown as ShadowRoot; return shadow; };
  const sent: Record<string, any>[] = [];
  let opened = 0;
  let assistant!: ReturnType<typeof createSelectionAssistant>;
  try {
    assistant = createSelectionAssistant(doc, async (message) => { sent.push(structuredClone(message)); return message.type === "overlay:notes" ? { notes: options.notes ?? [] } : { ok: true }; }, {
      frameUrl: "chrome-extension://test/assistant.html",
      register: async () => { if (options.registerFails) throw new Error("Reload this page to reconnect Margin Chat."); return { tabId: 12, session: "page-session" }; },
      openWorkspace: () => { opened++; },
    });
  } finally { prototype.attachShadow = attach; }
  cleanup.push(() => { assistant.destroy(); win.happyDOM.abort(); });
  const q = <T extends HTMLElement = HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const select = async (node: Node, from = 0, to = node.textContent!.length) => {
    const range = doc.createRange(); range.setStart(node, from); range.setEnd(node, to);
    const selection = doc.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    doc.dispatchEvent(new win.MouseEvent("mouseup", { bubbles: true }) as unknown as Event);
    await wait(win);
  };
  const paragraph = doc.querySelector("p")!.firstChild!;
  return { win, doc, root, assistant, q, select, sent, paragraph, opened: () => opened };
}

describe("selection popover", () => {
  test("offers Explain and Ask for a page passage without taking the selection", async () => {
    const h = harness();
    expect(h.q(".popover").hidden).toBe(true);
    await h.select(h.paragraph, 9, 23);
    expect(h.q(".popover").hidden).toBe(false);
    expect([...h.q(".popover").querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Explain", "Ask…"]);
    expect(h.doc.getSelection()!.toString()).toBe("useful passage");
    const down = new h.win.MouseEvent("mousedown", { bubbles: true, cancelable: true });
    h.q(".popover").dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true); // keeps the page selection from collapsing
  });
  test("stays away from editable text, tiny selections, and collapsed selections", async () => {
    const h = harness();
    await h.select(h.doc.querySelector("textarea")!.firstChild!);
    expect(h.q(".popover").hidden).toBe(true);
    await h.select(h.paragraph, 0, 1);
    expect(h.q(".popover").hidden).toBe(true);
    await h.select(h.paragraph, 9, 23);
    expect(h.q(".popover").hidden).toBe(false);
    h.doc.getSelection()!.removeAllRanges();
    h.doc.dispatchEvent(new h.win.Event("selectionchange") as unknown as Event);
    expect(h.q(".popover").hidden).toBe(true);
  });
  test("Escape dismisses the popover", async () => {
    const h = harness();
    await h.select(h.paragraph, 9, 23);
    h.doc.dispatchEvent(new h.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event);
    expect(h.q(".popover").hidden).toBe(true);
  });
});

describe("answer card", () => {
  test("opens an extension-origin frame that carries ids but no page or private text", async () => {
    const h = harness();
    await h.select(h.paragraph, 9, 23);
    h.q<HTMLButtonElement>('button[data-intent="explain"]').click();
    await wait(h.win);
    const frame = h.q<HTMLIFrameElement>("iframe");
    const url = new URL(frame.src);
    expect(`${url.protocol}//${url.host}${url.pathname}`).toBe("chrome-extension://test/assistant.html");
    expect([...url.searchParams.keys()].sort()).toEqual(["intent", "request", "session", "tab"]);
    expect(url.searchParams.get("tab")).toBe("12"); expect(url.searchParams.get("session")).toBe("page-session"); expect(url.searchParams.get("intent")).toBe("explain");
    expect(frame.src).not.toContain("useful"); // the passage reaches the frame only through the worker
    expect(h.q(".card").hidden).toBe(false);
    expect(h.q(".popover").hidden).toBe(true);
    expect(h.root.querySelectorAll("textarea,input,[contenteditable]")).toHaveLength(0);
    expect(h.doc.documentElement.outerHTML).not.toContain("page-session");
    expect(h.root.host.shadowRoot).toBeNull();
  });
  test("serves the selected passage only for the matching request, session, and page", async () => {
    const h = harness();
    await h.select(h.paragraph, 9, 23);
    h.q<HTMLButtonElement>('button[data-intent="ask"]').click();
    await wait(h.win);
    const id = new URL(h.q<HTMLIFrameElement>("iframe").src).searchParams.get("request")!;
    const result = await h.assistant.handleMessage({ type: "margin:page-request", session: "page-session", id });
    expect(result).toMatchObject({ quote: "useful passage", title: "Reading with context", sourceUrl: "https://example.com/article", intent: "ask", anchor: { exact: "useful passage" } });
    await expect(h.assistant.handleMessage({ type: "margin:page-request", session: "other", id })).rejects.toThrow("expired");
    await expect(h.assistant.handleMessage({ type: "margin:page-request", session: "page-session", id: "unknown" })).rejects.toThrow("Select the passage again");
    h.win.happyDOM.setURL("https://example.com/next");
    await expect(h.assistant.handleMessage({ type: "margin:page-request", session: "page-session", id })).rejects.toThrow("page changed");
  });
  test("reads the page for context without touching the selection", async () => {
    const h = harness();
    h.doc.body.innerHTML = `<article><h1>Long read</h1>${"<p>This sentence is part of a long enough article body to be readable.</p>".repeat(12)}</article>`;
    await h.select(h.doc.querySelector("p")!.firstChild!, 0, 20);
    h.q<HTMLButtonElement>('button[data-intent="explain"]').click();
    await wait(h.win);
    const article = await h.assistant.handleMessage({ type: "margin:page-article", session: "page-session" }) as { content: string; sourceUrl: string };
    expect(article.content).toContain("long enough article body");
    expect(article.sourceUrl).toBe("https://example.com/article");
    expect(h.doc.getSelection()!.toString()).toBe("This sentence is par");
  });
  test("closing removes the frame source so a running answer is cancelled", async () => {
    const h = harness();
    await h.select(h.paragraph, 9, 23);
    h.q<HTMLButtonElement>('button[data-intent="explain"]').click();
    await wait(h.win);
    await h.assistant.handleMessage({ type: "margin:page-close-card", session: "page-session" });
    expect(h.q(".card").hidden).toBe(true);
    expect(h.q<HTMLIFrameElement>("iframe").getAttribute("src")).toBeNull();
    h.q<HTMLButtonElement>('button[data-intent="explain"]').click();
    await wait(h.win);
    h.doc.dispatchEvent(new h.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event);
    expect(h.q(".card").hidden).toBe(true);
  });
  test("explains that Margin Chat needs reconnecting instead of failing silently", async () => {
    const h = harness({ registerFails: true });
    await h.select(h.paragraph, 9, 23);
    h.q<HTMLButtonElement>('button[data-intent="explain"]').click();
    await wait(h.win);
    expect(h.q(".card").hidden).toBe(true);
    expect(h.q(".popover .note").textContent).toContain("Reload this page");
    expect(h.q(".popover").hidden).toBe(false);
  });
  test("opens the workspace on request from the card", async () => {
    const h = harness();
    await h.select(h.paragraph, 9, 23);
    h.q<HTMLButtonElement>('button[data-intent="explain"]').click();
    await wait(h.win);
    await h.assistant.handleMessage({ type: "margin:page-open-workspace", session: "page-session" });
    expect(h.opened()).toBe(1);
    expect(h.q(".card").hidden).toBe(true); // the reader has moved on to the workspace
  });
});

describe("margin notes", () => {
  async function withAnchor() {
    const plain = harness();
    await plain.select(plain.paragraph, 9, 23);
    const anchor = captureTextAnchor(plain.doc.getSelection(), plain.doc)!;
    cleanup.pop()!(); // discard this document; reuse only the anchor
    return anchor;
  }
  test("show an opaque marker for each resolvable pinned passage and nothing else", async () => {
    const anchor = await withAnchor();
    const h = harness({ notes: [{ id: "thread-pin0", anchor }, { id: "thread-gone", anchor: { ...anchor, exact: "missing text", end: anchor.start + 12 } }] });
    h.assistant.arm();
    await wait(h.win);
    const markers = [...h.root.querySelectorAll<HTMLButtonElement>(".marker")];
    expect(markers).toHaveLength(1);
    expect(markers[0].getAttribute("aria-label")).toBe("Open margin note");
    expect(markers[0].textContent).toBe("m");
    expect(h.sent[0]).toEqual({ type: "overlay:notes" });
    markers[0].click();
    await wait(h.win);
    const url = new URL(h.q<HTMLIFrameElement>("iframe").src);
    expect(url.searchParams.get("thread")).toBe("thread-pin0");
    expect(url.searchParams.has("request")).toBe(false);
  });
  test("update when the worker pushes a change and drop markers on unpin", async () => {
    const anchor = await withAnchor();
    const h = harness();
    h.assistant.arm(); await wait(h.win);
    expect(h.root.querySelectorAll(".marker")).toHaveLength(0);
    h.q<HTMLButtonElement>('button[data-intent="explain"]'); // popover exists but session is not registered yet
    await expect(h.assistant.handleMessage({ type: "margin:page-notes", session: "page-session", notes: [] })).rejects.toThrow("expired");
    await h.select(h.paragraph, 9, 23);
    h.q<HTMLButtonElement>('button[data-intent="explain"]').click(); await wait(h.win);
    await h.assistant.handleMessage({ type: "margin:page-notes", session: "page-session", notes: [{ id: "thread-pin0", anchor }] });
    expect(h.root.querySelectorAll(".marker")).toHaveLength(1);
    await h.assistant.handleMessage({ type: "margin:page-notes", session: "page-session", notes: [] });
    expect(h.root.querySelectorAll(".marker")).toHaveLength(0);
  });
  test("never put prompts or answers into the page's document", async () => {
    const anchor = await withAnchor();
    const h = harness({ notes: [{ id: "thread-pin0", anchor, answer: "SECRET ANSWER", prompt: "SECRET PROMPT" }] });
    h.assistant.arm(); await wait(h.win);
    expect(h.doc.documentElement.outerHTML).not.toContain("SECRET");
    expect(h.root.innerHTML).not.toContain("SECRET");
  });
});
