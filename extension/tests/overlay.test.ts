import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createMarginOverlay } from "../src/overlay-ui";
import type { OverlayAnnotation, OverlayState } from "../src/overlay-types";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const article = `<article><h1>Reading with context</h1>${Array.from({ length: 6 }, (_, i) => `<p>Paragraph ${i} explains why keeping the original source beside a quotation helps a reader understand the evidence. Reading carefully leaves room for useful questions and thoughtful notes about what a source means.</p>`).join("")}</article>`;
const note = (text = "Saved thought"): OverlayAnnotation => ({ id: "note-1", captureId: "capture-1", title: "Saved source", kind: "selection", excerpt: "Saved quotation", comment: text, capturedAt: "2026-09-27T12:00:00Z" });
const initialState = (): OverlayState => ({ connection: { connectionId: "account-a", displayName: "Reader" }, pending: null, hasOtherPending: false, page: { annotations: [], draft: null } });

function harness(html = article) {
  const window = new Window({ url: "https://example.com/research" });
  const document = window.document as unknown as Document;
  document.title = "Research page";
  document.body.innerHTML = html;
  let state = initialState();
  const messages: Record<string, any>[] = [];
  let respond: ((message: Record<string, any>) => unknown | Promise<unknown>) | undefined;
  let root!: ShadowRoot;
  // Capture the root at creation only: production keeps the controls closed.
  const prototype = window.HTMLElement.prototype;
  const attachShadow = prototype.attachShadow;
  prototype.attachShadow = function (options) {
    const shadow = attachShadow.call(this, options);
    if (this.hasAttribute("data-margin-overlay")) root = shadow as unknown as ShadowRoot;
    return shadow;
  };
  let overlay: ReturnType<typeof createMarginOverlay>;
  try {
    overlay = createMarginOverlay(document, async (message) => {
      messages.push(structuredClone(message));
      const overridden = await respond?.(message);
      if (overridden !== undefined) return overridden;
      if (message.type === "overlay:state") return structuredClone(state);
      if (message.type === "overlay:draft") {
        state.page.draft = structuredClone(message.draft) as OverlayState["page"]["draft"];
        return { ok: true };
      }
      if (message.type === "overlay:save" || message.type === "overlay:retry") {
        state.pending = null;
        return { receipt: { id: "capture-1" } };
      }
      return { ok: true };
    });
  } finally {
    prototype.attachShadow = attachShadow;
  }
  cleanups.push(() => { overlay.destroy(); window.happyDOM.abort(); });
  const element = <T extends HTMLElement = HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const click = (selector: string) => element<HTMLButtonElement>(selector).click();
  const select = (node: Node, from = 0, to = node.textContent!.length) => {
    const range = document.createRange();
    range.setStart(node, from);
    range.setEnd(node, to);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }) as unknown as Event);
  };
  return {
    window, document, root, overlay, messages, element, click, select,
    get state() { return state; },
    set state(next: OverlayState) { state = next; },
    set respond(next: typeof respond) { respond = next; },
  };
}

describe("page workspace overlay", () => {
  test("all three layouts preserve context, separate thoughts/questions, and the saved draft", async () => {
    const h = harness();
    await h.overlay.open();
    expect(h.root.host.shadowRoot).toBeNull();
    h.element<HTMLInputElement>("#title").value = "My source title";
    h.element<HTMLTextAreaElement>("#comment").value = "My private thought";
    const context = h.element<HTMLTextAreaElement>("#content").value;
    for (const layout of ["floating", "expanded", "docked"]) {
      h.click(`[data-layout=${layout}]`);
      expect(h.element(".panel").dataset.layout).toBe(layout);
      expect(h.element(`[data-layout=${layout}]`).getAttribute("aria-pressed")).toBe("true");
      expect(h.element<HTMLInputElement>("#title").value).toBe("My source title");
      expect(h.element<HTMLTextAreaElement>("#content").value).toBe(context);
      expect(h.element<HTMLTextAreaElement>("#comment").value).toBe("My private thought");
    }
    h.click("[data-space=ask]");
    expect(h.element<HTMLTextAreaElement>("#comment").value).toBe("");
    h.element<HTMLTextAreaElement>("#comment").value = "What is the evidence?";
    h.click("[data-space=margin]");
    expect(h.element<HTMLTextAreaElement>("#comment").value).toBe("My private thought");
    h.click("#close");
    await settle();
    expect(h.state.page.draft).toMatchObject({ title: "My source title", content: context, comment: "My private thought", question: "What is the evidence?" });
    await h.overlay.open();
    expect(h.element<HTMLTextAreaElement>("#comment").value).toBe("My private thought");
  });

  test("floating drag stays on screen and peek returns to the current layout", async () => {
    const h = harness();
    await h.overlay.open();
    h.click("[data-layout=floating]");
    const header = h.element("header");
    const pointer = (type: string, x: number, y: number) => header.dispatchEvent(new h.window.PointerEvent(type, { button: 0, pointerId: 1, clientX: x, clientY: y, bubbles: true }) as unknown as Event);
    pointer("pointerdown", 50, 40);
    pointer("pointermove", -200, -200);
    expect(h.element(".panel").style.left).toBe("6px");
    expect(h.element(".panel").style.top).toBe("6px");
    pointer("pointerup", -200, -200);
    pointer("pointermove", 500, 500);
    expect(h.element(".panel").style.left).toBe("6px");
    h.click("#peek");
    expect(h.element(".panel").classList.contains("peeking")).toBe(true);
    expect(h.element(".peek-tab").hidden).toBe(false);
    h.click(".peek-tab");
    expect(h.element(".panel").classList.contains("peeking")).toBe(false);
    expect(h.element(".panel").dataset.layout).toBe("floating");
    expect(h.element(".peek-tab").hidden).toBe(true);
    h.click("[data-layout=expanded]");
    expect(h.element(".panel").style.left).toBe("");
  });

  test("page selection becomes quote context while editable text and overlay interactions cannot replace it", async () => {
    const h = harness(article + "<div contenteditable>PRIVATE DRAFT SENTINEL</div>");
    await h.overlay.open();
    expect(h.element<HTMLTextAreaElement>("#content").value).toContain("Paragraph 0");
    expect(h.element<HTMLTextAreaElement>("#content").value).not.toContain("PRIVATE DRAFT SENTINEL");
    expect(h.element<HTMLTextAreaElement>("#content").value).not.toContain("Think in the margin");
    const pageText = h.document.querySelector("p")!.firstChild!;
    h.select(pageText, 0, 11);
    expect(h.element<HTMLTextAreaElement>("#content").value).toBe("Paragraph 0");
    h.element<HTMLInputElement>("#title").value = "Chosen title";
    h.element("#peek").dispatchEvent(new h.window.MouseEvent("mouseup", { bubbles: true, composed: true }) as unknown as Event);
    expect(h.element<HTMLInputElement>("#title").value).toBe("Chosen title");
    h.select(h.document.querySelector("[contenteditable]")!.firstChild!);
    expect(h.element<HTMLTextAreaElement>("#content").value).toBe("Paragraph 0");
    h.click("#close");
    await settle();
    expect(h.state.page.draft?.anchor?.exact).toBe("Paragraph 0");
  });

  test("failed saves preserve the thought and retry the pending capture even when current context is unavailable", async () => {
    const h = harness();
    h.respond = (message) => {
      if (message.type !== "overlay:save") return;
      h.state.pending = { connectionId: "account-a", capture: message.capture, error: "Network unavailable; retry this capture." };
      return { error: "Network unavailable; retry this capture." };
    };
    await h.overlay.open();
    h.element<HTMLTextAreaElement>("#comment").value = "Keep this thought after failure";
    h.element("#form").dispatchEvent(new h.window.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
    await settle();
    expect(h.messages.filter((message) => message.type === "overlay:save")).toHaveLength(1);
    expect(h.element<HTMLTextAreaElement>("#comment").value).toBe("Keep this thought after failure");
    expect(h.state.page.draft?.comment).toBe("Keep this thought after failure");
    expect(h.element("#pending").hidden).toBe(false);
    h.click("[data-kind=selection]");
    expect(h.element<HTMLTextAreaElement>("#content").value).toBe("");
    expect(h.element<HTMLButtonElement>("#save").disabled).toBe(true);
    h.click("#retry");
    await settle();
    const retries = h.messages.filter((message) => message.type === "overlay:retry");
    expect(retries).toHaveLength(1);
    expect(retries[0]).not.toHaveProperty("capture");
    expect(h.messages.filter((message) => message.type === "overlay:save")).toHaveLength(1);
    expect(h.element<HTMLTextAreaElement>("#comment").value).toBe("");
    expect(h.state.page.draft).toBeNull();
  });

  test("a changed account cannot retain another account's notes or draft", async () => {
    const h = harness();
    h.state.page = { annotations: [note("Account A note")], draft: { kind: "bookmark", title: "Account A draft", content: "", comment: "Account A private draft", question: "Account A question", mode: "ask" } };
    await h.overlay.open();
    expect(h.element<HTMLTextAreaElement>("#comment").value).toBe("Account A question");
    h.state = { ...initialState(), connection: { connectionId: "account-b", displayName: "Other reader" } };
    await h.overlay.open();
    expect(h.element("#account").textContent).toContain("Other reader");
    expect(h.element("#entries").textContent).not.toContain("Account A");
    expect(h.element<HTMLInputElement>("#title").value).not.toContain("Account A");
    expect(h.element<HTMLTextAreaElement>("#comment").value).toBe("");
    h.click("[data-space=margin]");
    expect(h.element<HTMLTextAreaElement>("#comment").value).toBe("");
  });

  test("navigation clears old page context and notes even when the new state request fails", async () => {
    const h = harness();
    h.state.page = { annotations: [note("Old page private note")], draft: { kind: "article", title: "Old page draft title", content: "Old page saved context", comment: "Old page draft thought" } };
    await h.overlay.open();
    h.document.defaultView!.history.pushState({}, "", "/other-page");
    h.document.title = "Different page";
    h.document.body.innerHTML = "<p>Different page source</p>";
    h.respond = (message) => message.type === "overlay:state" ? { error: "Connection unavailable" } : undefined;
    await h.overlay.open();
    expect(h.element("#page-url").textContent).toBe("https://example.com/other-page");
    expect(h.element("#entries").textContent).not.toContain("Old page");
    expect(h.element<HTMLInputElement>("#title").value).not.toContain("Old page");
    expect(h.element<HTMLTextAreaElement>("#content").value).not.toContain("Old page");
    expect(h.element<HTMLTextAreaElement>("#comment").value).toBe("");
    expect(h.element<HTMLButtonElement>("#save").disabled).toBe(true);
  });

  test("a slow old-page response cannot replace the newly opened page's state", async () => {
    const h = harness();
    let resolveOld!: (value: OverlayState) => void;
    let calls = 0;
    h.respond = (message) => message.type === "overlay:state" && calls++ === 0 ? new Promise<OverlayState>((resolve) => { resolveOld = resolve; }) : undefined;
    const oldOpen = h.overlay.open({ text: "Stale passage from old page", sourceUrl: h.document.location.href });
    await settle();
    h.document.defaultView!.history.pushState({}, "", "/new-page");
    h.state.page.annotations = [note("New page note")];
    await h.overlay.open();
    resolveOld({ ...initialState(), page: { annotations: [note("Stale old-page note")], draft: null } });
    await oldOpen;
    expect(h.element("#entries").textContent).toContain("New page note");
    expect(h.element("#entries").textContent).not.toContain("Stale old-page note");
    expect(h.element("#page-url").textContent).toBe("https://example.com/new-page");
    expect(h.element<HTMLTextAreaElement>("#content").value).not.toContain("Stale passage from old page");
    h.click("#close");
    await settle();
    expect(h.state.page.draft?.content).not.toContain("Stale passage from old page");
  });

  test("navigation while a draft write is pending cannot save or clear the next page's draft", async () => {
    for (const stage of ["before-save", "after-save"]) {
      const h = harness();
      await h.overlay.open();
      h.element<HTMLTextAreaElement>("#comment").value = "Old page thought";
      let finishDraft!: (value: unknown) => void;
      let pendingDraft = true;
      h.respond = (message) => {
        if (message.type === "overlay:draft" && pendingDraft && (stage === "before-save" || message.draft === null)) {
          pendingDraft = false;
          return new Promise((resolve) => { finishDraft = resolve; });
        }
      };
      h.element("#form").dispatchEvent(new h.window.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
      await settle();
      h.document.defaultView!.history.pushState({}, "", "/new-source");
      h.state = initialState();
      h.state.page.draft = { kind: "article", title: "Next source", content: "Next source context", comment: "Next source private draft" };
      const nextOpen = h.overlay.open();
      finishDraft({ ok: true });
      await nextOpen;
      await settle();
      expect(h.messages.filter((message) => message.type === "overlay:save")).toHaveLength(stage === "before-save" ? 0 : 1);
      expect(h.element<HTMLInputElement>("#title").value).toBe("Next source");
      expect(h.element<HTMLTextAreaElement>("#comment").value).toBe("Next source private draft");
      expect(h.state.page.draft?.comment).toBe("Next source private draft");
      expect(h.element("#status").textContent).not.toContain("Saved.");
    }
  });

  test("an explicit new passage replaces restored quote context while retaining the user's thought", async () => {
    const h = harness(article + "<p id='new-passage'>A newly selected passage</p>");
    const oldQuote = "Previously saved passage";
    h.state.page.draft = { kind: "selection", title: "Previous source title", content: oldQuote, comment: "Keep my unfinished thought", anchor: { exact: oldQuote, prefix: "", suffix: "", start: 0, end: oldQuote.length } };
    const newText = h.document.getElementById("new-passage")!.firstChild!;
    h.select(newText);
    await h.overlay.open({ text: newText.textContent!, sourceUrl: h.document.location.href });
    expect(h.element<HTMLTextAreaElement>("#content").value).toBe("A newly selected passage");
    expect(h.element<HTMLTextAreaElement>("#comment").value).toBe("Keep my unfinished thought");
    h.click("#close");
    await settle();
    expect(h.state.page.draft?.anchor?.exact).toBe("A newly selected passage");
    expect(h.state.page.draft?.content).toBe("A newly selected passage");
  });

  test("hostile page titles and saved content are rendered as literal text", async () => {
    const h = harness();
    const hostile = "<img src=x onerror=alert(1)><script>steal()</script>";
    h.document.title = hostile;
    h.state.connection!.displayName = hostile;
    h.state.page.annotations = [{ ...note(hostile), excerpt: hostile }];
    await h.overlay.open();
    expect(h.element("#page-title").textContent).toBe(hostile);
    expect(h.element("#entries blockquote").textContent).toBe(hostile);
    expect(h.element("#entries p").textContent).toBe(hostile);
    expect(h.element("#account").textContent).toContain(hostile);
    expect(h.root.querySelectorAll("img, script, [onerror]")).toHaveLength(0);
  });
});
