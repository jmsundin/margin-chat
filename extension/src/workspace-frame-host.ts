import { CAPTURE_LIMITS, type CaptureKind } from "@margin-chat/capture-contracts";
import { captureTextAnchor, resolveTextAnchor, type TextAnchor } from "./anchors";
import { extractArticle, extractSelection } from "./extraction";
import type { SelectionDraft } from "./storage";

export interface PageContext {
  title: string;
  sourceUrl: string;
  kind: CaptureKind;
  content: string;
  revision: number;
  selectionText?: string;
  anchor?: TextAnchor;
}
type Layout = "docked" | "floating" | "expanded";
type Send = (message: Record<string, unknown>) => Promise<any>;

/** Only this non-private shell and page-derived text enter the host document. */
export function createWorkspaceFrameHost(doc: Document, send: Send, frameUrl: string) {
  const win = doc.defaultView!;
  const host = doc.createElement("div");
  host.dataset.marginOverlay = "workspace";
  // The closed shadow conceals the frame nonce and controls. The independent
  // extension origin protects private workspace data and user input.
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>
    :host{all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;color-scheme:light!important}
    *{box-sizing:border-box}button{font:inherit;cursor:pointer;border:1px solid #d9d8cf;background:#fffdf7;color:#293b35;border-radius:7px;padding:6px 8px}button:hover,button[aria-pressed=true]{background:#e6eee6;border-color:#80958a}button:focus-visible{outline:3px solid #71977a;outline-offset:2px}
    [hidden]{display:none!important}.panel{pointer-events:auto;position:fixed;right:12px;top:12px;width:min(520px,calc(100vw - 24px));height:calc(100vh - 24px);background:#faf9f4;border:1px solid #cccfc4;border-radius:14px;box-shadow:0 14px 55px #1a292b35;display:flex;flex-direction:column;overflow:hidden;font:12px system-ui,sans-serif;color:#293b35}
    header{display:flex;align-items:center;gap:8px;padding:10px;border-bottom:1px solid #dddfd5;flex-wrap:wrap;flex-shrink:0;background:#f6f5ed;touch-action:none}strong{font-size:13px;margin-right:auto}.layouts{display:flex;gap:3px}.close{font-size:16px;padding:3px 8px}.panel[data-layout=floating]{resize:both;min-width:320px;min-height:280px;max-width:calc(100vw - 12px);max-height:calc(100vh - 12px)}.panel[data-layout=floating] header{cursor:move}
    iframe{border:0;display:block;width:100%;flex:1;min-height:0;background:#faf9f4}.status{padding:24px;font-size:14px;line-height:1.6}.status button{margin-top:12px;display:block}
    .reveal,.return{position:fixed;pointer-events:auto;box-shadow:0 3px 20px #1a292b30}.reveal{left:12px;top:50%;writing-mode:vertical-rl;padding:15px 10px}.return{right:18px;bottom:18px;padding:13px 18px}.dragging iframe{pointer-events:none}
    @media(max-width:650px){.layouts button{padding:5px}strong{font-size:12px}header{gap:5px}}
  </style><section class="panel" data-layout="docked" role="complementary" aria-label="Margin Chat workspace" hidden>
    <header><strong>Margin Chat</strong><div class="layouts" role="group" aria-label="Workspace layout"><button data-layout="docked" aria-pressed="true">Docked</button><button data-layout="floating" aria-pressed="false">Floating</button><button data-layout="expanded" aria-pressed="false">Expanded</button></div><button class="peek">Peek</button><button class="close" aria-label="Close Margin Chat">×</button></header>
    <div class="status" role="status">Opening your workspace…</div><iframe title="Private Margin Chat workspace" referrerpolicy="no-referrer" hidden></iframe>
  </section><button class="reveal" hidden>Uncover page</button><button class="return" hidden>Return to Margin</button>`;
  doc.documentElement.append(host);
  const panel = root.querySelector<HTMLElement>(".panel")!;
  const frame = root.querySelector<HTMLIFrameElement>("iframe")!;
  const status = root.querySelector<HTMLElement>(".status")!;
  const reveal = root.querySelector<HTMLButtonElement>(".reveal")!;
  const returnButton = root.querySelector<HTMLButtonElement>(".return")!;
  const header = root.querySelector<HTMLElement>("header")!;
  let layout: Layout = "docked";
  let active = false;
  let peeking = false;
  let session = "";
  let revision = 0;
  let context = bookmark();
  let floating = { left: Math.max(6, win.innerWidth - 640), top: 55, width: 590, height: Math.min(680, win.innerHeight - 70) };
  let drag: { x: number; y: number; left: number; top: number } | undefined;
  let starting: Promise<void> | undefined;
  let anchors: TextAnchor[] = [];
  function bookmark(): PageContext { return { title: doc.title.slice(0, CAPTURE_LIMITS.title), sourceUrl: win.location.href, kind: "bookmark", content: "", revision: ++revision }; }
  function captureSelection(draft?: SelectionDraft) {
    const anchor = captureTextAnchor(win.getSelection(), doc);
    const text = draft?.sourceUrl === win.location.href ? draft.text : anchor?.exact;
    if (!text?.trim()) return;
    if (context.sourceUrl === win.location.href && context.kind === "selection" && context.selectionText === text) return;
    try {
      context = { title: doc.title.slice(0, CAPTURE_LIMITS.title), sourceUrl: win.location.href, kind: "selection", content: extractSelection(text), selectionText: text, revision: ++revision, ...(anchor?.exact === text ? { anchor } : {}) };
    } catch { /* Oversized/private selections never replace an existing draft. */ }
  }
  async function changedPage() {
    if (context.sourceUrl === win.location.href) return;
    context = bookmark(); anchors = []; paintHighlights();
    if (session) await send({ type: "overlay:page", session });
  }
  function render() {
    panel.hidden = !active || peeking;
    reveal.hidden = !active || peeking || layout !== "expanded";
    returnButton.hidden = !active || !peeking;
    panel.dataset.layout = layout;
    root.querySelectorAll<HTMLButtonElement>("button[data-layout]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.layout === layout)));
    if (layout === "floating") {
      Object.assign(panel.style, { left: `${Math.max(6, Math.min(win.innerWidth - 326, floating.left))}px`, top: `${Math.max(6, Math.min(win.innerHeight - 100, floating.top))}px`, right: "auto", width: `${floating.width}px`, height: `${floating.height}px` });
    } else if (layout === "expanded") {
      Object.assign(panel.style, { left: `${Math.min(88, Math.max(46, win.innerWidth * 0.075))}px`, right: "12px", top: "12px", width: "auto", height: "calc(100vh - 24px)" });
    } else {
      Object.assign(panel.style, { left: "auto", right: "12px", top: "12px", width: "min(520px, calc(100vw - 24px))", height: "calc(100vh - 24px)" });
    }
  }
  function setLayout(next: Layout) {
    if (layout === "floating") { const rect = panel.getBoundingClientRect(); floating = { left: rect.left, top: rect.top, width: rect.width || floating.width, height: rect.height || floating.height }; }
    layout = next; peeking = false; render();
  }
  async function connect() {
    const response = await send({ type: "overlay:frame" });
    if (response?.error || !response?.session || !Number.isInteger(response.tabId)) throw new Error(response?.error || "Unable to open Margin Chat. Reload the page and try again.");
    if (session !== response.session) {
      session = response.session;
      const url = new URL(frameUrl); url.searchParams.set("tab", String(response.tabId)); url.searchParams.set("session", session);
      frame.src = url.href;
    }
    frame.hidden = false; status.hidden = true;
  }
  async function open(draft?: SelectionDraft) {
    await changedPage(); captureSelection(draft); active = true; peeking = false; render();
    if (!starting) starting = connect().catch((error) => {
      status.hidden = false; frame.hidden = true; status.textContent = error instanceof Error ? error.message : "Unable to open Margin Chat.";
      const retry = doc.createElement("button"); retry.textContent = "Try again"; retry.onclick = () => { void open(); }; status.append(retry);
    }).finally(() => { starting = undefined; });
    await starting;
  }
  function close() { active = false; peeking = false; render(); }
  function paintHighlights(focus?: Range) {
    const css = (win as unknown as { CSS?: { highlights?: Map<string, unknown> } }).CSS;
    const Highlight = (win as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
    if (!css?.highlights || !Highlight) return;
    const ranges = anchors.map((anchor) => resolveTextAnchor(doc, anchor)).filter((range): range is Range => Boolean(range));
    if (focus) ranges.push(focus);
    css.highlights.set("margin-workspace-passages", new Highlight(...ranges));
    if (!doc.querySelector("style[data-margin-workspace-highlights]")) {
      const style = doc.createElement("style"); style.dataset.marginWorkspaceHighlights = "true";
      style.textContent = "::highlight(margin-workspace-passages){background-color:#e7db82a6;color:inherit}"; doc.documentElement.append(style);
    }
  }
  async function handleMessage(message: Record<string, unknown>) {
    if (!session || message.session !== session) throw new Error("This workspace session has expired. Reopen Margin Chat.");
    await changedPage();
    if (message.type === "margin:page-context") {
      const kind = message.kind ?? "current";
      if (kind === "current") return context;
      if (kind === "selection") { captureSelection(); if (context.kind !== "selection") throw new Error("Select a passage on the page first."); return context; }
      if (kind === "article") { context = { ...extractArticle(doc), sourceUrl: win.location.href, kind, revision: ++revision }; return context; }
      if (kind === "bookmark") { context = bookmark(); return context; }
      throw new Error("Unsupported page context.");
    }
    if (message.type === "margin:page-highlights") { anchors = message.anchors as TextAnchor[]; paintHighlights(); return { ok: true }; }
    if (message.type === "margin:page-locate") {
      const range = resolveTextAnchor(doc, message.anchor as TextAnchor);
      if (!range) return { located: false };
      paintHighlights(range);
      const element = range.startContainer.nodeType === 1 ? range.startContainer as Element : range.startContainer.parentElement;
      element?.scrollIntoView?.({ behavior: "smooth", block: "center" });
      if (layout === "expanded") { peeking = true; render(); }
      return { located: true };
    }
    throw new Error("Unsupported page action.");
  }
  root.querySelectorAll<HTMLButtonElement>("button[data-layout]").forEach((button) => button.onclick = () => setLayout(button.dataset.layout as Layout));
  root.querySelector<HTMLButtonElement>(".close")!.onclick = close;
  for (const button of [root.querySelector<HTMLButtonElement>(".peek")!, reveal]) button.onclick = () => { peeking = true; render(); };
  returnButton.onclick = () => { peeking = false; render(); };
  header.addEventListener("pointerdown", (event) => {
    if (layout !== "floating" || event.button !== 0 || (event.target as Element).closest("button")) return;
    const rect = panel.getBoundingClientRect(); drag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    header.setPointerCapture?.(event.pointerId); panel.classList.add("dragging"); event.preventDefault();
  });
  header.addEventListener("pointermove", (event) => { if (!drag) return;
    panel.style.left = `${Math.max(6, Math.min(win.innerWidth - panel.offsetWidth - 6, drag.left + event.clientX - drag.x))}px`;
    panel.style.top = `${Math.max(6, Math.min(win.innerHeight - 70, drag.top + event.clientY - drag.y))}px`;
  });
  for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) header.addEventListener(event, () => { drag = undefined; panel.classList.remove("dragging"); });
  const selectionChanged = (event: Event) => { if (!event.composedPath().includes(host)) captureSelection(); };
  doc.addEventListener("mouseup", selectionChanged); doc.addEventListener("keyup", selectionChanged);
  const resized = () => { if (layout === "floating") { const rect = panel.getBoundingClientRect(); floating = { left: rect.left, top: rect.top, width: rect.width, height: rect.height }; } render(); };
  win.addEventListener("resize", resized);
  const navigationCheck = win.setInterval(() => { void changedPage().catch(() => undefined); }, 500);
  return { open, close, toggle: () => active ? close() : void open(), handleMessage,
    destroy() { win.clearInterval(navigationCheck); doc.removeEventListener("mouseup", selectionChanged); doc.removeEventListener("keyup", selectionChanged); win.removeEventListener("resize", resized); host.remove(); },
  };
}
