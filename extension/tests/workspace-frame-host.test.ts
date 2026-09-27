import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createWorkspaceFrameHost } from "../src/workspace-frame-host";

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
function harness() {
  const win = new Window({ url: "https://example.com/article", settings: { disableIframePageLoading: true } });
  const doc = win.document as unknown as Document;
  doc.title = "Reading with context";
  doc.body.innerHTML = `<article><h1>Reading with context</h1><p>Before a useful passage after.</p></article><form><input value="private password"><textarea>Private draft</textarea></form>`;
  let root!: ShadowRoot;
  const prototype = win.HTMLElement.prototype; const attach = prototype.attachShadow;
  prototype.attachShadow = function(options) { const shadow = attach.call(this, options); if (this.hasAttribute("data-margin-overlay")) root = shadow as unknown as ShadowRoot; return shadow; };
  const messages: Record<string, any>[] = [];
  let overlay!: ReturnType<typeof createWorkspaceFrameHost>;
  try {
    overlay = createWorkspaceFrameHost(doc, async (message) => { messages.push(structuredClone(message)); return message.type === "overlay:frame" ? { tabId: 12, session: "source-session" } : { ok: true }; }, "chrome-extension://test/workspace.html");
  } finally { prototype.attachShadow = attach; }
  cleanup.push(() => { overlay.destroy(); win.happyDOM.abort(); });
  const element = <T extends HTMLElement = HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const click = (selector: string) => element<HTMLButtonElement>(selector).click();
  const select = (node: Node, from = 0, to = node.textContent!.length) => { const range = doc.createRange(); range.setStart(node, from); range.setEnd(node, to); const selection = doc.getSelection()!; selection.removeAllRanges(); selection.addRange(range); doc.dispatchEvent(new win.MouseEvent("mouseup", { bubbles: true }) as unknown as Event); };
  return { win, doc, root, overlay, element, click, select, messages, context: (kind = "current") => overlay.handleMessage({ type: "margin:page-context", session: "source-session", kind }) };
}

describe("protected workspace frame host", () => {
  test("mounts one private extension frame and preserves it across layout, peek, and close changes", async () => {
    const h = harness(); await h.overlay.open();
    const frame = h.element<HTMLIFrameElement>("iframe");
    const url = new URL(frame.src);
    expect(url.protocol).toBe("chrome-extension:"); expect(url.searchParams.get("tab")).toBe("12"); expect(url.searchParams.get("session")).toBe("source-session");
    expect(h.root.host.shadowRoot).toBeNull();
    expect(h.root.querySelectorAll("textarea,input,[contenteditable]")).toHaveLength(0);
    for (const layout of ["floating", "expanded", "docked", "expanded"]) {
      h.click(`button[data-layout=${layout}]`); expect(h.element(".panel").dataset.layout).toBe(layout); expect(h.element("iframe")).toBe(frame); expect(frame.src).toBe(url.href);
    }
    expect(h.element(".reveal").hidden).toBe(false);
    h.click(".reveal"); expect(h.element(".panel").hidden).toBe(true); expect(h.element(".return").hidden).toBe(false);
    h.click(".return"); expect(h.element(".panel").hidden).toBe(false);
    h.click(".close"); await h.overlay.open(); expect(h.element("iframe")).toBe(frame); expect(frame.src).toBe(url.href);
    expect(h.doc.body.innerHTML).not.toContain("source-session");
  });
  test("keeps a page selection when iframe focus clears it and rejects private editable text", async () => {
    const h = harness(); await h.overlay.open();
    const text = h.doc.querySelector("p")!.firstChild!; h.select(text, 7, 23);
    const selected = await h.context();
    expect(selected).toMatchObject({ kind: "selection", content: "a useful passage", selectionText: "a useful passage", anchor: { exact: "a useful passage", start: 27, end: 43 } });
    h.doc.getSelection()!.removeAllRanges(); expect(await h.context()).toEqual(selected);
    h.select(h.doc.querySelector("textarea")!.firstChild!); expect(await h.context()).toEqual(selected);
    expect(JSON.stringify(h.messages)).not.toContain("Private draft");
    await expect(h.overlay.handleMessage({ type: "margin:page-context", session: "wrong" })).rejects.toThrow("expired");
    await h.context("bookmark"); expect((await h.context()).kind).toBe("bookmark");
  });
  test("resets provenance on navigation while retaining the same workspace frame", async () => {
    const h = harness(); await h.overlay.open(); h.select(h.doc.querySelector("p")!.firstChild!, 7, 23);
    const frame = h.element("iframe"); h.win.history.pushState({}, "", "/next");
    expect(await h.context()).toMatchObject({ kind: "bookmark", sourceUrl: "https://example.com/next", content: "" });
    expect(h.messages).toContainEqual({ type: "overlay:page", session: "source-session" });
    expect(h.element("iframe")).toBe(frame);
    expect(await h.overlay.handleMessage({ type: "margin:page-locate", session: "source-session", anchor: { exact: "removed text", prefix: "", suffix: "", start: 0, end: 12 } })).toEqual({ located: false });
  });
  test("floating drag clamps to the page and ends on pointer cancellation", async () => {
    const h = harness(); await h.overlay.open(); h.click("button[data-layout=floating]");
    const header = h.element("header");
    const pointer = (type: string, x: number, y: number) => header.dispatchEvent(new h.win.PointerEvent(type, { button: 0, pointerId: 1, clientX: x, clientY: y, bubbles: true }) as unknown as Event);
    pointer("pointerdown", 50, 40); pointer("pointermove", -300, -300);
    expect(h.element(".panel").style.left).toBe("6px"); expect(h.element(".panel").style.top).toBe("6px");
    pointer("pointercancel", -300, -300); pointer("pointermove", 500, 500); expect(h.element(".panel").style.left).toBe("6px");
    expect(h.element(".panel").classList.contains("dragging")).toBe(false);
  });
});
