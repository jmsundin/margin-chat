import { captureTextAnchor, resolveTextAnchor, type TextAnchor } from "./anchors";
import { extractArticle } from "./extraction";
import { PAGE_AI_LIMITS, type PageNote, type PageThreadIntent } from "./page-ai";
import { CARD_PLACEMENT, placeCard as computeCardPlacement, type Box } from "./placement";

type Send = (message: Record<string, unknown>) => Promise<any>;
interface PageRequest { id: string; intent: PageThreadIntent; anchor: TextAnchor; title: string; sourceUrl: string }
interface Placed { id: string; range: Range }

const OWNED = new Set(["margin:page-request", "margin:page-article", "margin:page-notes", "margin:page-close-card", "margin:page-open-workspace"]);
const CARD = CARD_PLACEMENT;

/**
 * The page-side half of "select text, ask AI". It holds only geometry, buttons,
 * and page-derived text. The prompt box, the answer, and the margin note body are
 * rendered by an extension-origin frame, so page scripts cannot read what the
 * reader types or what the AI says.
 */
export function createSelectionAssistant(doc: Document, send: Send, options: {
  frameUrl: string;
  register(): Promise<{ tabId: number; session: string }>;
  openWorkspace(): void | Promise<void>;
}) {
  const win = doc.defaultView!;
  const host = doc.createElement("div");
  host.dataset.marginOverlay = "assistant";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>
    :host{all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;color-scheme:light!important}
    *{box-sizing:border-box}[hidden]{display:none!important}
    button{font:600 12px/1 system-ui,-apple-system,'Segoe UI',sans-serif;cursor:pointer;color:#243a2f;background:transparent;border:0;border-radius:7px;padding:8px 10px}
    button:hover{background:#e6eee6}button:focus-visible{outline:2px solid #3d6b57;outline-offset:1px}
    .popover{position:fixed;pointer-events:auto;display:flex;align-items:center;gap:2px;padding:3px;background:#faf8f1;border:1px solid #c5cfc0;border-radius:10px;box-shadow:0 6px 24px #152b3533}
    .popover .note{font:12px system-ui,sans-serif;color:#7a3b2a;padding:0 8px;max-width:240px}
    .card{position:fixed;pointer-events:auto;background:#faf8f1;border:1px solid #c5cfc0;border-left:3px solid #3d6b57;border-radius:12px;box-shadow:0 14px 50px #152b3544;overflow:hidden}
    iframe{display:block;width:100%;height:100%;border:0;background:#faf8f1}
    .marker{position:fixed;right:6px;pointer-events:auto;width:26px;height:26px;padding:0;display:grid;place-items:center;border-radius:50%;background:#315b45;color:#faf8f1;font:italic 600 15px/1 Georgia,serif;box-shadow:0 2px 10px #152b3544;border:2px solid #faf8f1}
    .marker:hover{background:#264a37}
    @media (forced-colors:active){.popover,.card,.marker{border:1px solid CanvasText}}
  </style>
  <div class="popover" role="toolbar" aria-label="Margin Chat selection actions" hidden><button type="button" data-intent="explain">Explain</button><button type="button" data-intent="ask">Ask…</button><span class="note" role="status" hidden></span></div>
  <section class="card" role="dialog" aria-label="Margin Chat answer" hidden><iframe title="Margin Chat answer" referrerpolicy="no-referrer"></iframe></section>
  <div class="markers"></div>`;
  doc.documentElement.append(host);

  const popover = root.querySelector<HTMLElement>(".popover")!;
  const note = popover.querySelector<HTMLElement>(".note")!;
  const card = root.querySelector<HTMLElement>(".card")!;
  const frame = root.querySelector<HTMLIFrameElement>("iframe")!;
  const markerLayer = root.querySelector<HTMLElement>(".markers")!;

  let session = "";
  let tabId = -1;
  let current: { anchor: TextAnchor; range: Range } | null = null;
  let cardRange: Range | null = null;
  let returnFocus: Element | null = null;
  let notes: Placed[] = [];
  let knownUrl = win.location.href;
  let frameRequest = 0;
  let scheduled = 0;
  const requests = new Map<string, PageRequest>();

  const css = (win as unknown as { CSS?: { highlights?: Map<string, unknown> } }).CSS;
  const Highlight = (win as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  function paint(name: string, ranges: Range[]) {
    if (!css?.highlights || !Highlight) return;
    if (ranges.length) css.highlights.set(name, new Highlight(...ranges)); else css.highlights.delete(name);
    if (!doc.querySelector("style[data-margin-assistant-highlights]")) {
      const style = doc.createElement("style"); style.dataset.marginAssistantHighlights = "true";
      // Dotted underline, unlike the yellow saved highlights: an AI note is a different kind of mark.
      style.textContent = "::highlight(margin-ai-notes){text-decoration:underline dotted #3d6b57 2px;text-underline-offset:3px;background-color:#dfeadf99;color:inherit}::highlight(margin-ai-focus){background-color:#dfeadfcc;color:inherit}";
      doc.documentElement.append(style);
    }
  }

  function rectOf(range: Range): DOMRect | null {
    const rects = typeof range.getClientRects === "function" ? [...range.getClientRects()].filter((rect) => rect.width || rect.height) : [];
    const bounds = rects.length ? rects : typeof range.getBoundingClientRect === "function" ? [range.getBoundingClientRect()] : [];
    return bounds[0] ?? null;
  }
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
  const viewport = () => ({ width: win.innerWidth || doc.documentElement.clientWidth, height: win.innerHeight || doc.documentElement.clientHeight });

  function placePopover() {
    if (popover.hidden || !current) return;
    const rect = rectOf(current.range);
    const { width, height } = viewport();
    if (!rect || rect.bottom < 0 || rect.top > height) { popover.hidden = true; return; }
    const w = popover.offsetWidth || 150, h = popover.offsetHeight || 36;
    const above = rect.top - h - 8;
    popover.style.top = `${above >= CARD.edge ? above : Math.min(height - h - CARD.edge, rect.bottom + 8)}px`;
    popover.style.left = `${clamp(rect.left + rect.width / 2 - w / 2, CARD.edge, Math.max(CARD.edge, width - w - CARD.edge))}px`;
  }
  /** The whole passage, from its first line to its last, so a multi-line quote stays uncovered. */
  function boundsOf(range: Range): Box | null {
    const rects = typeof range.getClientRects === "function" ? [...range.getClientRects()].filter((rect) => rect.width || rect.height) : [];
    const list = rects.length ? rects : typeof range.getBoundingClientRect === "function" ? [range.getBoundingClientRect()] : [];
    if (!list.length) return null;
    return { top: Math.min(...list.map((r) => r.top)), left: Math.min(...list.map((r) => r.left)), right: Math.max(...list.map((r) => r.right)), bottom: Math.max(...list.map((r) => r.bottom)) };
  }
  function placeCard() {
    if (card.hidden) return;
    const placed = computeCardPlacement(cardRange && !cardRange.collapsed ? boundsOf(cardRange) : null, viewport());
    Object.assign(card.style, { width: `${placed.width}px`, height: `${placed.height}px`, top: `${placed.top}px`, left: `${placed.left}px` });
  }
  function layoutMarkers() {
    const { height } = viewport();
    const measured = [...markerLayer.querySelectorAll<HTMLButtonElement>(".marker")].map((button) => {
      const range = notes.find((item) => item.id === button.dataset.note)?.range;
      const rect = range && !range.collapsed ? rectOf(range) : null;
      return { button, top: rect?.top };
    });
    let floor = -Infinity;
    for (const { button, top } of measured.filter((item): item is { button: HTMLButtonElement; top: number } => item.top !== undefined).sort((a, b) => a.top - b.top)) {
      // Keep neighbouring markers from overlapping when passages are close together.
      const y = Math.max(top, floor + 30);
      floor = y;
      button.hidden = y < -4 || y > height - 28;
      button.style.top = `${y}px`;
    }
    for (const { button, top } of measured) if (top === undefined) button.hidden = true;
  }
  function layout() { scheduled = 0; placePopover(); placeCard(); layoutMarkers(); }
  function schedule() { if (!scheduled) scheduled = win.requestAnimationFrame(layout); }

  function hidePopover() { popover.hidden = true; note.hidden = true; }
  function evaluateSelection() {
    const selection = win.getSelection();
    const anchor = captureTextAnchor(selection, doc);
    if (!anchor || anchor.exact.trim().length < 2 || anchor.exact.length > PAGE_AI_LIMITS.quote) { current = null; hidePopover(); return; }
    current = { anchor, range: selection!.getRangeAt(0).cloneRange() };
    note.hidden = true;
    popover.querySelectorAll("button").forEach((button) => button.hidden = false);
    popover.hidden = false;
    placePopover();
  }
  const fromHost = (event: Event) => event.composedPath().includes(host);
  // Indexing a large page's text is not free, so a burst of keys or clicks reads the selection once.
  let evaluating = 0;
  const scheduleEvaluation = (delay: number) => { win.clearTimeout(evaluating); evaluating = win.setTimeout(evaluateSelection, delay); };
  const onPointerUp = (event: Event) => { if (!fromHost(event)) scheduleEvaluation(0); };
  const onKeyUp = (event: Event) => { if (!fromHost(event) && (event as KeyboardEvent).key !== "Escape") scheduleEvaluation(120); };
  const onSelectionChange = () => { const selection = win.getSelection(); if (!selection || selection.isCollapsed) { current = null; hidePopover(); } };
  const onKeyDown = (event: Event) => {
    if ((event as KeyboardEvent).key !== "Escape") return;
    if (!card.hidden) closeCard(); else if (!popover.hidden) hidePopover();
  };

  function closeCard() {
    if (card.hidden) return;
    frameRequest++;
    card.hidden = true;
    // Removing the source unloads the frame, which also cancels a streaming answer.
    frame.removeAttribute("src");
    cardRange = null;
    paint("margin-ai-focus", []);
    if (returnFocus && (returnFocus as HTMLElement).isConnected) (returnFocus as HTMLElement).focus?.();
    returnFocus = null;
  }
  async function showCard(params: Record<string, string>, range: Range | null) {
    const ticket = ++frameRequest;
    const registered = await options.register();
    if (ticket !== frameRequest) return;
    session = registered.session; tabId = registered.tabId;
    const url = new URL(options.frameUrl);
    url.searchParams.set("tab", String(tabId)); url.searchParams.set("session", session);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    if (card.hidden) returnFocus = doc.activeElement;
    cardRange = range;
    paint("margin-ai-focus", range && !range.collapsed ? [range] : []);
    card.hidden = false;
    frame.src = url.href;
    placeCard();
  }
  function flash(text: string) {
    popover.querySelectorAll("button").forEach((button) => button.hidden = true);
    note.textContent = text; note.hidden = false; popover.hidden = false; placePopover();
    win.setTimeout(() => { if (!note.hidden) hidePopover(); }, 4500);
  }
  async function ask(intent: PageThreadIntent) {
    if (!current) return;
    const { anchor, range } = current;
    const request: PageRequest = { id: crypto.randomUUID(), intent, anchor, title: doc.title.slice(0, 300), sourceUrl: win.location.href };
    requests.set(request.id, request);
    for (const stale of [...requests.keys()].slice(0, Math.max(0, requests.size - 10))) requests.delete(stale);
    try {
      await showCard({ request: request.id, intent }, range);
      hidePopover();
    } catch (error) {
      flash(error instanceof Error ? error.message : "Reload this page to reconnect Margin Chat.");
    }
  }

  function renderNotes() {
    markerLayer.replaceChildren();
    for (const item of notes) {
      const button = doc.createElement("button");
      button.type = "button"; button.className = "marker"; button.dataset.note = item.id;
      button.setAttribute("aria-label", "Open margin note"); button.title = "Margin note";
      button.textContent = "m";
      button.addEventListener("click", () => { void showCard({ thread: item.id }, item.range).catch(() => undefined); });
      markerLayer.append(button);
    }
    paint("margin-ai-notes", notes.map((item) => item.range));
    layoutMarkers();
  }
  function setNotes(next: readonly PageNote[]) {
    notes = next.flatMap((item) => {
      const range = resolveTextAnchor(doc, item.anchor);
      return range ? [{ id: item.id, range }] : [];
    });
    renderNotes();
  }
  async function refreshNotes() {
    try { const result = await send({ type: "overlay:notes" }); if (Array.isArray(result?.notes)) setNotes(result.notes.slice(0, 200)); } catch { /* No account or worker yet. */ }
  }

  function owns(type: unknown): boolean { return typeof type === "string" && OWNED.has(type); }
  async function handleMessage(message: Record<string, unknown>) {
    if (!session || message.session !== session) throw new Error("This workspace session has expired. Reopen Margin Chat.");
    if (message.type === "margin:page-request") {
      const request = requests.get(String(message.id));
      if (!request) throw new Error("Select the passage again.");
      if (request.sourceUrl !== win.location.href) throw new Error("The page changed. Select the passage again.");
      return { quote: request.anchor.exact, anchor: request.anchor, title: request.title, sourceUrl: request.sourceUrl, intent: request.intent };
    }
    if (message.type === "margin:page-article") {
      const article = extractArticle(doc);
      return { title: article.title, content: article.content, sourceUrl: win.location.href };
    }
    if (message.type === "margin:page-notes") {
      if (Array.isArray(message.notes)) setNotes((message.notes as PageNote[]).slice(0, 200));
      return { ok: true };
    }
    if (message.type === "margin:page-close-card") { closeCard(); return { ok: true }; }
    if (message.type === "margin:page-open-workspace") { closeCard(); await options.openWorkspace(); return { ok: true }; }
    throw new Error("Unsupported page action.");
  }

  popover.addEventListener("mousedown", (event) => event.preventDefault()); // keep the selection
  popover.querySelectorAll<HTMLButtonElement>("button[data-intent]").forEach((button) =>
    button.addEventListener("click", () => void ask(button.dataset.intent as PageThreadIntent)));
  doc.addEventListener("mouseup", onPointerUp);
  doc.addEventListener("keyup", onKeyUp);
  doc.addEventListener("selectionchange", onSelectionChange);
  doc.addEventListener("keydown", onKeyDown, true);
  win.addEventListener("scroll", schedule, true);
  win.addEventListener("resize", schedule);
  const navigationCheck = win.setInterval(() => {
    if (win.location.href === knownUrl) return;
    knownUrl = win.location.href;
    closeCard(); hidePopover(); current = null; setNotes([]);
    void refreshNotes();
  }, 700);

  return {
    owns, handleMessage,
    /** Start listening; pinned notes for this page are restored and painted. */
    arm() { void refreshNotes(); win.setTimeout(() => void refreshNotes(), 2000); },
    destroy() {
      win.clearInterval(navigationCheck); win.clearTimeout(evaluating);
      doc.removeEventListener("mouseup", onPointerUp); doc.removeEventListener("keyup", onKeyUp);
      doc.removeEventListener("selectionchange", onSelectionChange); doc.removeEventListener("keydown", onKeyDown, true);
      win.removeEventListener("scroll", schedule, true); win.removeEventListener("resize", schedule);
      paint("margin-ai-notes", []); paint("margin-ai-focus", []);
      host.remove();
    },
  };
}
