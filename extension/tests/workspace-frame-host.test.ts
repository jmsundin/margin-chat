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
  const dockResizes: number[] = [];
  let overlay!: ReturnType<typeof createWorkspaceFrameHost>;
  try {
    overlay = createWorkspaceFrameHost(doc, async (message) => { messages.push(structuredClone(message)); return message.type === "overlay:frame" ? { tabId: 12, session: "source-session" } : { ok: true }; }, "chrome-extension://test/workspace.html", { onDockResize: (width) => dockResizes.push(width) });
  } finally { prototype.attachShadow = attach; }
  cleanup.push(() => { overlay.destroy(); win.happyDOM.abort(); });
  const element = <T extends HTMLElement = HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const click = (selector: string) => element<HTMLButtonElement>(selector).click();
  const chooseLayout = (layout: string) => { click(".more"); click(`.menu button[data-layout=${layout}]`); };
  const press = (selector: string, key: string) => { const event = new win.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }); element(selector).dispatchEvent(event as unknown as Event); return event; };
  const select = (node: Node, from = 0, to = node.textContent!.length) => { const range = doc.createRange(); range.setStart(node, from); range.setEnd(node, to); const selection = doc.getSelection()!; selection.removeAllRanges(); selection.addRange(range); doc.dispatchEvent(new win.MouseEvent("mouseup", { bubbles: true }) as unknown as Event); };
  return { win, doc, root, overlay, dockResizes, element, click, chooseLayout, press, select, messages, context: (kind = "current") => overlay.handleMessage({ type: "margin:page-context", session: "source-session", kind }) };
}

describe("protected workspace frame host", () => {
  test("the docked panel resizes from its left edge and reports the width to remember", async () => {
    const h = harness(); await h.overlay.open();
    const grip = h.element(".grip"); const panel = h.element(".panel");
    expect(grip.getAttribute("role")).toBe("separator"); expect(panel.style.width).toBe("520px");
    const pointer = (type: string, clientX: number) => grip.dispatchEvent(new h.win.PointerEvent(type, { clientX, button: 0, pointerId: 1, bubbles: true }) as unknown as Event);
    pointer("pointerdown", 500); pointer("pointermove", 400);
    expect(panel.style.width).toBe("620px"); expect(panel.classList.contains("resizing")).toBe(true); expect(h.dockResizes).toEqual([]);
    pointer("pointerup", 400);
    expect(panel.classList.contains("resizing")).toBe(false); expect(h.dockResizes).toEqual([620]);
    h.press(".grip", "ArrowRight"); expect(panel.style.width).toBe("596px"); expect(h.dockResizes.at(-1)).toBe(596);
    h.overlay.setDockWidth(100); expect(panel.style.width).toBe("320px");
    h.overlay.setDockWidth(99999); expect(panel.style.width).toBe(`${h.win.innerWidth - 24}px`);
    h.chooseLayout("floating"); pointer("pointerdown", 500); pointer("pointermove", 100); pointer("pointerup", 100);
    expect(panel.style.width).not.toBe(`${h.win.innerWidth - 24 + 400}px`); expect(h.dockResizes).toHaveLength(2);
    h.chooseLayout("docked"); grip.dispatchEvent(new h.win.MouseEvent("dblclick", { bubbles: true }) as unknown as Event);
    expect(panel.style.width).toBe("520px"); expect(h.dockResizes.at(-1)).toBe(520);
  });
  test("the shell follows the app's theme, falling back to the system setting", async () => {
    const h = harness(); await h.overlay.open();
    const host = h.root.host as HTMLElement;
    expect(["light", "dark"]).toContain(host.dataset.theme!);
    h.overlay.setTheme("light"); expect(host.dataset.theme).toBe("light");
    h.overlay.setTheme("dark"); expect(host.dataset.theme).toBe("dark");
    h.overlay.setTheme("neon"); expect(["light", "dark"]).toContain(host.dataset.theme!);
    expect(h.root.querySelector("style")!.textContent).toContain(":host([data-theme=light])");
  });
  test("mounts one private extension frame and preserves it across layout, peek, and close changes", async () => {
    const h = harness(); await h.overlay.open();
    const frame = h.element<HTMLIFrameElement>("iframe");
    const url = new URL(frame.src);
    expect(url.protocol).toBe("chrome-extension:"); expect(url.searchParams.get("tab")).toBe("12"); expect(url.searchParams.get("session")).toBe("source-session");
    expect(h.root.host.shadowRoot).toBeNull();
    expect(h.root.querySelectorAll("textarea,input,[contenteditable]")).toHaveLength(0);
    for (const layout of ["floating", "expanded", "docked", "expanded"]) {
      h.chooseLayout(layout); expect(h.element(".panel").dataset.layout).toBe(layout); expect(h.element("iframe")).toBe(frame); expect(frame.src).toBe(url.href);
    }
    expect(h.element(".reveal").hidden).toBe(false);
    h.click(".reveal"); expect(h.element(".panel").hidden).toBe(true); expect(h.element(".return").hidden).toBe(false);
    h.click(".return"); expect(h.element(".panel").hidden).toBe(false);
    h.click(".close"); await h.overlay.open(); expect(h.element("iframe")).toBe(frame); expect(frame.src).toBe(url.href);
    expect(h.doc.body.innerHTML).not.toContain("source-session");
  });
  test("keeps the header to a title, a view-options button, and close", async () => {
    const h = harness(); await h.overlay.open();
    expect([...h.element("header").children].map((child) => child.className || child.tagName.toLowerCase())).toEqual(["strong", "icon more", "menu", "icon close"]);
    expect([...h.root.querySelectorAll("header > button")].some((button) => button.hasAttribute("data-layout"))).toBe(false); // layouts live only in the menu
    expect(h.root.textContent).not.toContain("Community");
    expect(h.element(".more").getAttribute("aria-label")).toBe("View options");
    expect(h.element(".more").getAttribute("aria-haspopup")).toBe("menu");
    expect(h.element(".menu").hidden).toBe(true);
  });
  describe("view options menu", () => {
    test("lists the layouts and peek, marks the current layout, and closes after a choice", async () => {
      const h = harness(); await h.overlay.open();
      h.click(".more");
      expect(h.element(".menu").hidden).toBe(false); expect(h.element(".more").getAttribute("aria-expanded")).toBe("true");
      const entries = [...h.root.querySelectorAll(".menu button")].map((item) => [item.textContent, item.getAttribute("role"), item.getAttribute("aria-checked")]);
      expect(entries).toEqual([["Docked", "menuitemradio", "true"], ["Floating", "menuitemradio", "false"], ["Expanded", "menuitemradio", "false"], ["Peek at page", "menuitem", null]]);
      h.click(".menu button[data-layout=expanded]");
      expect(h.element(".panel").dataset.layout).toBe("expanded");
      expect(h.element(".menu").hidden).toBe(true); expect(h.element(".more").getAttribute("aria-expanded")).toBe("false");
      h.click(".more");
      expect(h.element(".menu button[data-layout=expanded]").getAttribute("aria-checked")).toBe("true");
      expect(h.element(".menu button[data-layout=docked]").getAttribute("aria-checked")).toBe("false");
    });
    test("peek at page hides the panel and offers the way back", async () => {
      const h = harness(); await h.overlay.open();
      const frame = h.element("iframe");
      h.click(".more"); h.click(".menu .peek");
      expect(h.element(".panel").hidden).toBe(true); expect(h.element(".return").hidden).toBe(false); expect(h.element(".menu").hidden).toBe(true);
      expect(h.root.activeElement).toBe(h.element(".return"));
      h.click(".return"); expect(h.element(".panel").hidden).toBe(false); expect(h.element("iframe")).toBe(frame);
    });
    test("is operable from the keyboard and Escape closes only the menu", async () => {
      const h = harness(); await h.overlay.open();
      h.press(".more", "ArrowDown");
      expect(h.element(".menu").hidden).toBe(false);
      expect(h.root.activeElement).toBe(h.element(".menu button[data-layout=docked]"));
      const key = (name: string) => { const event = new h.win.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }); h.root.activeElement!.dispatchEvent(event as unknown as Event); return event; };
      key("ArrowDown"); expect(h.root.activeElement).toBe(h.element(".menu button[data-layout=floating]"));
      key("End"); expect(h.root.activeElement).toBe(h.element(".menu .peek"));
      key("ArrowDown"); expect(h.root.activeElement).toBe(h.element(".menu button[data-layout=docked]")); // wraps
      key("ArrowUp"); expect(h.root.activeElement).toBe(h.element(".menu .peek"));
      key("Home"); expect(h.root.activeElement).toBe(h.element(".menu button[data-layout=docked]"));
      const escape = key("Escape");
      expect(escape.defaultPrevented).toBe(true);
      expect(h.element(".menu").hidden).toBe(true);
      expect(h.root.activeElement).toBe(h.element(".more"));
      expect(h.element(".panel").hidden).toBe(false);
      h.press(".more", "ArrowUp");
      expect(h.root.activeElement).toBe(h.element(".menu .peek"));
    });
    test("closes when the reader clicks elsewhere, on the page or in the panel, and when the panel closes", async () => {
      const h = harness(); await h.overlay.open();
      const down = (target: EventTarget) => target.dispatchEvent(new h.win.Event("pointerdown", { bubbles: true, composed: true }) as unknown as Event);
      h.click(".more"); down(h.doc.body); expect(h.element(".menu").hidden).toBe(true);
      h.click(".more"); down(h.element("header strong")); expect(h.element(".menu").hidden).toBe(true);
      h.click(".more"); down(h.element(".menu button[data-layout=docked]")); expect(h.element(".menu").hidden).toBe(false);
      h.click(".more"); expect(h.element(".menu").hidden).toBe(true); // the button toggles
      h.click(".more"); h.click(".close");
      expect(h.element(".menu").hidden).toBe(true); expect(h.element(".more").getAttribute("aria-expanded")).toBe("false");
    });
    test("does not start a floating drag from the menu", async () => {
      const h = harness(); await h.overlay.open(); h.chooseLayout("floating");
      h.click(".more");
      h.element(".menu").dispatchEvent(new h.win.PointerEvent("pointerdown", { button: 0, pointerId: 2, clientX: 5, clientY: 5, bubbles: true }) as unknown as Event);
      expect(h.element(".panel").classList.contains("dragging")).toBe(false);
    });
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
    const h = harness(); await h.overlay.open(); h.chooseLayout("floating");
    const header = h.element("header");
    const pointer = (type: string, x: number, y: number) => header.dispatchEvent(new h.win.PointerEvent(type, { button: 0, pointerId: 1, clientX: x, clientY: y, bubbles: true }) as unknown as Event);
    pointer("pointerdown", 50, 40); pointer("pointermove", -300, -300);
    expect(h.element(".panel").style.left).toBe("6px"); expect(h.element(".panel").style.top).toBe("6px");
    pointer("pointercancel", -300, -300); pointer("pointermove", 500, 500); expect(h.element(".panel").style.left).toBe("6px");
    expect(h.element(".panel").classList.contains("dragging")).toBe(false);
  });
});
