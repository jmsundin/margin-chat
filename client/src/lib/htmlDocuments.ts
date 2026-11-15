/**
 * HTML pages in the vault open as live documents: their scripts run, so a page
 * can be interactive. They run in a sandboxed frame with an opaque origin, so a
 * page can't read the app, its cookies or its storage, or navigate the app away.
 * A small bridge script added to the page reports selections, its height and
 * where saved passages sit; the app answers with the passages to mark.
 */

export const HTML_SOURCE_ID = "file:html";

/** Scripts, forms and new tabs work; same-origin access, top navigation and alerts don't. */
export const HTML_FRAME_SANDBOX = "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox";

/** A passage the page should mark, with where it was found when it was saved. */
export interface HtmlAnchor { id: string; quote: string; start: number; end: number }

export interface HtmlRect { left: number; top: number; width: number; height: number }

/** Messages the bridge sends from inside the frame. Anything else posted by the page is ignored. */
export type HtmlFrameMessage =
  | { marginHtml: 1; type: "size"; height: number }
  | { marginHtml: 1; type: "selection"; quote: string; start: number; end: number; context: string; rect: HtmlRect }
  | { marginHtml: 1; type: "clear" }
  | { marginHtml: 1; type: "marks"; marks: Array<HtmlRect & { id: string }> }
  | { marginHtml: 1; type: "open"; id: string }
  | { marginHtml: 1; type: "storage"; data: Record<string, string> }
  | { marginHtml: 1; type: "screen"; requestId: string; screen: HtmlScreen }
  | { marginHtml: 1; type: "content-request" }
  | { marginHtml: 1; type: "asset-request"; id: string; path: string };

/**
 * What a page shows at one moment, for Play's notes and Ask AI: the words in view, what the person
 * typed into its boxes, and the whole page's text, since a game draws its screen with scripts and
 * the saved file holds little of it.
 */
export interface HtmlScreen {
  /** The text in view, line by line. */
  visible: string;
  /** What is typed or picked in the boxes in view, each with its label. */
  fields: Array<{ label: string; value: string }>;
  /** All the text on the page now, shortened if long. */
  page: string;
}

export const MAX_SCREEN_TEXT = 12_000;
export const MAX_SCREEN_PAGE = 30_000;
const MAX_SCREEN_FIELDS = 20;

/** What a page keeps in its own `localStorage`, at most this much, so it remembers its state the next time it opens. */
export const MAX_HTML_STORAGE_CHARS = 1_000_000;

function readStorageData(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data: Record<string, string> = {};
  let size = 0;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") return null;
    size += key.length + item.length;
    if (size > MAX_HTML_STORAGE_CHARS) return null;
    data[key] = item;
  }
  return data;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isRect = (value: unknown): value is HtmlRect => Boolean(value) && typeof value === "object"
  && finite((value as HtmlRect).left) && finite((value as HtmlRect).top) && finite((value as HtmlRect).width) && finite((value as HtmlRect).height);

/** Checks a message from the frame; the page's own scripts can post too, so nothing is trusted by shape alone. */
export function readHtmlFrameMessage(data: unknown): HtmlFrameMessage | null {
  if (!data || typeof data !== "object" || (data as { marginHtml?: unknown }).marginHtml !== 1) return null;
  const message = data as Record<string, unknown>;
  switch (message.type) {
    case "size": return finite(message.height) && message.height >= 0 ? { marginHtml: 1, type: "size", height: message.height } : null;
    case "clear": return { marginHtml: 1, type: "clear" };
    case "content-request": return { marginHtml: 1, type: "content-request" };
    case "asset-request": return typeof message.id === "string" && message.id.length <= 40 && typeof message.path === "string" && message.path.length <= 1_000
      ? { marginHtml: 1, type: "asset-request", id: message.id, path: message.path } : null;
    case "open": return typeof message.id === "string" && message.id.length <= 200 ? { marginHtml: 1, type: "open", id: message.id } : null;
    case "storage": {
      const data = readStorageData(message.data);
      return data ? { marginHtml: 1, type: "storage", data } : null;
    }
    case "selection": {
      const { quote, start, end, context, rect } = message;
      if (typeof quote !== "string" || !quote.trim() || quote.length > 20_000 || typeof context !== "string" || context.length > 40_000) return null;
      if (!finite(start) || !finite(end) || start < 0 || end < start || !isRect(rect)) return null;
      return { marginHtml: 1, type: "selection", quote, start, end, context, rect };
    }
    case "screen": return readScreenMessage(message);
    case "marks": {
      if (!Array.isArray(message.marks) || message.marks.length > 2_000) return null;
      const marks = message.marks.filter((mark): mark is HtmlRect & { id: string } => isRect(mark) && typeof (mark as { id?: unknown }).id === "string");
      return { marginHtml: 1, type: "marks", marks };
    }
    default: return null;
  }
}

function readScreenMessage(message: Record<string, unknown>): HtmlFrameMessage | null {
  const { requestId, screen } = message;
  if (typeof requestId !== "string" || requestId.length > 100 || !screen || typeof screen !== "object") return null;
  const { visible, page, fields } = screen as Record<string, unknown>;
  if (typeof visible !== "string" || typeof page !== "string" || !Array.isArray(fields)) return null;
  const clean = fields.slice(0, MAX_SCREEN_FIELDS).flatMap((field) => {
    const { label, value } = (field ?? {}) as Record<string, unknown>;
    return typeof label === "string" && typeof value === "string" ? [{ label: label.slice(0, 200), value: value.slice(0, MAX_SCREEN_TEXT) }] : [];
  });
  return { marginHtml: 1, type: "screen", requestId,
    screen: { visible: visible.slice(0, MAX_SCREEN_TEXT), page: page.slice(0, MAX_SCREEN_PAGE), fields: clean } };
}

/**
 * Runs inside the frame, before the page's own scripts. It must stay
 * self-contained: it is sent to the frame as source text.
 */
function bridge(savedStorage: Record<string, string>, hasAssets: boolean, firstTheme: string, firstLayout: string) {
  const SKIP = /^(?:SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TEXTAREA|SELECT|OPTION)$/u;
  const parentWindow = window.parent;
  const post = (message: Record<string, unknown>) => parentWindow.postMessage({ marginHtml: 1, ...message }, "*");
  let anchors: Array<{ id: string; quote: string; start: number; end: number }> = [];

  /*
   * The app's theme. The frame's color scheme already makes the page's `prefers-color-scheme` rules
   * follow it; pages that key their dark palette on `data-theme` get that too, unless the page set
   * one itself (it has its own switch, which is left alone).
   */
  const root = document.documentElement;
  const ownsTheme = root.hasAttribute("data-theme");
  const setTheme = (theme: unknown) => {
    if (!ownsTheme && (theme === "light" || theme === "dark")) root.setAttribute("data-theme", theme);
  };
  setTheme(firstTheme);

  /*
   * Without same-origin access the browser throws on any use of localStorage,
   * sessionStorage or cookies, and most pages that save anything stop at that
   * line. They get stand-ins instead: localStorage is kept by the app for this
   * page, sessionStorage and cookies last while the page is open.
   */
  function storage(initial: Record<string, string>, changed: (data: Record<string, string>) => void) {
    const data = new Map(Object.entries(initial));
    const snapshot = () => Object.fromEntries(data);
    const api = {
      getItem: (key: string) => data.get(String(key)) ?? null,
      setItem: (key: string, value: unknown) => { data.set(String(key), String(value)); changed(snapshot()); },
      removeItem: (key: string) => { if (data.delete(String(key))) changed(snapshot()); },
      clear: () => { if (data.size) { data.clear(); changed(snapshot()); } },
      key: (index: number) => [...data.keys()][index] ?? null,
      get length() { return data.size; },
    };
    return new Proxy(api, {
      get: (target, key) => key in target ? Reflect.get(target, key) : typeof key === "string" ? data.get(key) : undefined,
      set: (target, key, value) => { if (typeof key === "string" && !(key in target)) api.setItem(key, value); return true; },
      deleteProperty: (_target, key) => { if (typeof key === "string") api.removeItem(key); return true; },
      has: (target, key) => key in target || (typeof key === "string" && data.has(key)),
      ownKeys: () => [...data.keys()],
      getOwnPropertyDescriptor: (_target, key) => typeof key === "string" && data.has(key)
        ? { value: data.get(key), writable: true, enumerable: true, configurable: true } : undefined,
    });
  }
  let storageTimer = 0;
  const saveStorage = (data: Record<string, string>) => {
    window.clearTimeout(storageTimer);
    storageTimer = window.setTimeout(() => post({ type: "storage", data }), 250);
  };
  const stand = (target: object, name: string, value: unknown) => {
    try { Object.defineProperty(target, name, { value, configurable: true, enumerable: true }); } catch { /* The browser keeps its own. */ }
  };
  stand(window, "localStorage", storage(savedStorage, saveStorage));
  stand(window, "sessionStorage", storage({}, () => {}));
  const cookies = new Map<string, string>();
  try {
    Object.defineProperty(document, "cookie", {
      configurable: true,
      get: () => [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
      set: (value: unknown) => {
        const [pair] = String(value).split(";");
        const split = pair.indexOf("=");
        const name = (split < 0 ? "" : pair.slice(0, split)).trim();
        const item = split < 0 ? pair.trim() : pair.slice(split + 1).trim();
        if (/;\s*(?:expires=Thu, 01 Jan 1970|max-age=-?0\b)/iu.test(String(value))) cookies.delete(name); else cookies.set(name, item);
      },
    });
  } catch { /* The browser keeps its own. */ }

  /*
   * Files beside the page. The frame has no address of its own, so "vendor/engine.js" would be asked of
   * Margin Chat's server, which doesn't have it. For a page in its own folder the app answers instead,
   * from that folder in the vault: fetches, scripts and pictures the page adds, and fetches its workers make.
   */
  const assetWaiters = new Map<string, (blob: Blob | null) => void>();
  if (hasAssets) {
    const baseFolder = new URL(".", document.baseURI).href;
    const assets = new Map<string, Promise<Blob | null>>();
    let nextAsset = 0;
    /** The path inside the page's folder that an address names, or null for anything on the web. */
    const assetPath = (address: unknown) => {
      let url: URL;
      try { url = new URL(String(address), document.baseURI); } catch { return null; }
      const plain = url.href.split(/[?#]/u)[0]!;
      if (!/^https?:$/u.test(url.protocol) || !plain.startsWith(baseFolder) || plain.endsWith("/")) return null;
      try { return decodeURIComponent(plain.slice(baseFolder.length)) || null; } catch { return null; }
    };
    const loadAsset = (path: string) => {
      let asset = assets.get(path);
      if (!asset) {
        asset = new Promise<Blob | null>((resolve) => {
          const id = `a${nextAsset += 1}`;
          assetWaiters.set(id, resolve);
          post({ type: "asset-request", id, path });
          window.setTimeout(() => { if (assetWaiters.delete(id)) resolve(null); }, 60_000);
        });
        assets.set(path, asset);
        // A file that wasn't there may be added later; one that was is kept for the page's life.
        void asset.then((blob) => { if (!blob) assets.delete(path); });
      }
      return asset;
    };
    const answer = (blob: Blob) => new Response(blob, { status: 200, headers: { "Content-Type": blob.type || "application/octet-stream" } });

    const nativeFetch = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const request = typeof input === "object" && input !== null && !(input instanceof URL) ? input as Request : null;
      const method = String(init?.method ?? request?.method ?? "GET").toUpperCase();
      const path = method === "GET" ? assetPath(request ? request.url : input) : null;
      if (!path) return nativeFetch(input, init);
      return loadAsset(path).then((blob) => blob ? answer(blob) : nativeFetch(input, init));
    }) as typeof window.fetch;

    // A script, picture, sound or stylesheet the page points at a file beside it gets that file.
    const redirected: Array<{ type: typeof Element; name: string; set: (element: Element, value: unknown) => void }> = [];
    const redirect = (type: typeof Element | undefined, name: string) => {
      const described = type && Object.getOwnPropertyDescriptor(type.prototype, name);
      if (!type || !described?.get || !described.set) return;
      const wanted = new WeakMap<Element, string>();
      const set = (element: Element, value: unknown) => {
        const path = assetPath(value);
        if (!path) { wanted.delete(element); described.set!.call(element, value); return; }
        const address = new URL(String(value), document.baseURI).href;
        if (wanted.get(element) === address) return;
        wanted.set(element, address);
        void loadAsset(path).then((blob) => {
          if (wanted.get(element) === address) described.set!.call(element, blob ? URL.createObjectURL(blob) : address);
        });
      };
      Object.defineProperty(type.prototype, name, {
        configurable: true, enumerable: described.enumerable,
        get(this: Element) { return wanted.get(this) ?? described.get!.call(this); },
        set(this: Element, value: unknown) { set(this, value); },
      });
      redirected.push({ type, name, set });
    };
    redirect(window.HTMLScriptElement, "src");
    redirect(window.HTMLImageElement, "src");
    redirect(window.HTMLMediaElement, "src");
    redirect(window.HTMLSourceElement, "src");
    redirect(window.HTMLLinkElement, "href");
    const redirectFor = (element: Element, name: string) => redirected.find((entry) => entry.name === name && element instanceof entry.type);
    const nativeSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function setAttribute(this: Element, name: string, value: string) {
      const entry = typeof name === "string" ? redirectFor(this, name.toLowerCase()) : undefined;
      if (entry && assetPath(value)) entry.set(this, value); else nativeSetAttribute.call(this, name, value);
    };
    // Markup (the page's own, or what a script writes with innerHTML) names files too.
    const adopt = (root: ParentNode) => {
      for (const element of root.querySelectorAll("img[src], audio[src], video[src], source[src], link[href]")) {
        const name = element instanceof HTMLLinkElement ? "href" : "src";
        const value = element.getAttribute(name);
        if (value && assetPath(value)) redirectFor(element, name)?.set(element, value);
      }
    };
    new MutationObserver((changes) => {
      for (const change of changes) for (const node of change.addedNodes) {
        if (node instanceof Element) adopt(node.parentNode ?? document);
      }
    }).observe(document, { childList: true, subtree: true });

    /*
     * A worker has its own fetch, out of this page's reach, and the engines that need files beside them
     * (a compiler and its libraries) run in one. A worker started from text the page made gets a few
     * lines ahead of its own that send such fetches back here.
     */
    function workerShim(folder: string) {
      const scope = self as unknown as { fetch: typeof fetch; addEventListener: typeof addEventListener; removeEventListener: typeof removeEventListener };
      let port: MessagePort | null = null;
      const unsent: Array<{ id: number; path: string }> = [];
      const waiting = new Map<number, (blob: Blob | null) => void>();
      let next = 0;
      const first = (event: Event) => {
        const message = event as MessageEvent;
        if (!message.data || message.data.marginAssetPort !== 1 || !message.ports[0]) return;
        event.stopImmediatePropagation();
        scope.removeEventListener("message", first);
        port = message.ports[0];
        port.onmessage = (reply) => { const resolve = waiting.get(reply.data.id); waiting.delete(reply.data.id); resolve?.(reply.data.blob ?? null); };
        for (const request of unsent.splice(0)) port.postMessage(request);
      };
      scope.addEventListener("message", first);
      const native = scope.fetch.bind(self);
      scope.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        let path: string | null = null;
        try {
          const address = typeof input === "object" && input !== null && !(input instanceof URL) ? (input as Request).url : String(input);
          const plain = new URL(address).href.split(/[?#]/u)[0]!;
          const method = String(init?.method ?? "GET").toUpperCase();
          if (method === "GET" && plain.startsWith(folder) && !plain.endsWith("/")) path = decodeURIComponent(plain.slice(folder.length));
        } catch { path = null; }
        if (!path) return native(input, init);
        const asked = path;
        return new Promise<Blob | null>((resolve) => {
          const id = next += 1;
          waiting.set(id, resolve);
          if (port) port.postMessage({ id, path: asked }); else unsent.push({ id, path: asked });
        }).then((blob) => blob
          ? new Response(blob, { status: 200, headers: { "Content-Type": blob.type || "application/octet-stream" } })
          : native(input, init));
      }) as typeof fetch;
    }
    const NativeWorker = window.Worker;
    const made = new Map<string, Blob>();
    const nativeCreate = URL.createObjectURL.bind(URL);
    const nativeRevoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (source: Blob | MediaSource) => {
      const url = nativeCreate(source);
      if (source instanceof Blob && source.size < 50_000_000) made.set(url, source);
      return url;
    };
    URL.revokeObjectURL = (url: string) => { made.delete(url); nativeRevoke(url); };
    if (NativeWorker) {
      const prelude = `(${workerShim.toString()})(${JSON.stringify(baseFolder)});\n`;
      const PageWorker = function PageWorker(address: string | URL, options?: WorkerOptions) {
        const source = made.get(String(address));
        if (!source || options?.type === "module") return new NativeWorker(address, options);
        const url = nativeCreate(new Blob([prelude, source], { type: "text/javascript" }));
        const worker = new NativeWorker(url, options);
        window.setTimeout(() => nativeRevoke(url), 30_000);
        const channel = new MessageChannel();
        channel.port1.onmessage = (event) => {
          const { id, path } = event.data ?? {};
          void loadAsset(String(path)).then((blob) => channel.port1.postMessage({ id, blob }));
        };
        worker.postMessage({ marginAssetPort: 1 }, [channel.port2]);
        return worker;
      };
      PageWorker.prototype = NativeWorker.prototype;
      stand(window, "Worker", PageWorker);
    }
    const start = () => adopt(document);
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
  }

  function textNodes() {
    const nodes: Text[] = [];
    if (!document.body) return nodes;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        for (let element = node.parentElement; element && element !== document.body; element = element.parentElement) {
          if (SKIP.test(element.tagName)) return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
    return nodes;
  }

  /** The page's text: every visible text node in order, as the offsets of passages count it. */
  function pageText(nodes: Text[]) {
    return nodes.map((node) => node.data).join("");
  }

  function offsetOf(nodes: Text[], container: Node, offset: number) {
    const point = document.createRange();
    point.setStart(container, offset);
    let total = 0;
    for (const node of nodes) {
      if (node === container) return total + Math.min(offset, node.data.length);
      if (point.comparePoint(node, 0) >= 0) return total;
      total += node.data.length;
    }
    return total;
  }

  const collapse = (value: string) => value.replace(/\s+/gu, " ").trim();
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

  /** Where a saved passage is now: at its saved offsets, else the copy of its words nearest to them. */
  function locate(text: string, anchor: { quote: string; start: number; end: number }) {
    if (collapse(text.slice(anchor.start, anchor.end)) === anchor.quote) return [anchor.start, anchor.end];
    const words = anchor.quote.split(" ").filter(Boolean).map(escape);
    if (!words.length) return null;
    const pattern = new RegExp(words.join("\\s+"), "gu");
    let best: [number, number] | null = null;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      if (!best || Math.abs(match.index - anchor.start) < Math.abs(best[0] - anchor.start)) best = [match.index, match.index + match[0].length];
      if (match.index > anchor.start) break;
    }
    return best;
  }

  function rangeAt(nodes: Text[], start: number, end: number) {
    let total = 0;
    const range = document.createRange();
    let started = false;
    for (const node of nodes) {
      const length = node.data.length;
      if (!started && start < total + length) { range.setStart(node, start - total); started = true; }
      if (started && end <= total + length) { range.setEnd(node, end - total); return range; }
      total += length;
    }
    return null;
  }

  let markedRanges: Array<{ id: string; range: Range }> = [];
  function reportMarks() {
    const nodes = textNodes();
    const text = pageText(nodes);
    markedRanges = [];
    const marks: Array<Record<string, unknown>> = [];
    for (const anchor of anchors) {
      const found = locate(text, anchor);
      const range = found && rangeAt(nodes, found[0], found[1]);
      if (!range) continue;
      markedRanges.push({ id: anchor.id, range });
      for (const rect of range.getClientRects()) {
        if (rect.width < 1 || rect.height < 1) continue;
        marks.push({ id: anchor.id, left: rect.left + window.scrollX, top: rect.top + window.scrollY, width: rect.width, height: rect.height });
      }
    }
    post({ type: "marks", marks });
    drawMarks(marks);
  }

  /*
   * When the page fills its panel it scrolls inside the frame, where the app can't follow it. The marks
   * are then drawn here, in a layer of the page's own that scrolls with the text. The layer takes no
   * clicks; a click on a marked passage is found by where it landed, below.
   */
  let fills = firstLayout === "fill";
  let layer: HTMLElement | null = null;
  let drawn = "";
  function drawMarks(marks: Array<Record<string, unknown>>) {
    if (!fills || !marks.length) { layer?.remove(); layer = null; drawn = ""; return; }
    const next = marks.map((mark) => `${mark.left},${mark.top},${mark.width},${mark.height}`).join(";");
    if (layer?.isConnected && next === drawn) return;
    drawn = next;
    if (!layer) {
      layer = document.createElement("div");
      layer.setAttribute("data-margin-highlight", "layer");
      layer.setAttribute("aria-hidden", "true");
      layer.style.cssText = "position:absolute;top:0;left:0;width:0;height:0;margin:0;padding:0;border:0;pointer-events:none;z-index:2147483646;";
    }
    layer.replaceChildren(...marks.map((mark) => {
      const piece = document.createElement("span");
      piece.setAttribute("data-margin-highlight", String(mark.id));
      piece.style.cssText = `position:absolute;left:${mark.left}px;top:${mark.top}px;width:${mark.width}px;height:${mark.height}px;`
        + "background:rgba(240,176,0,.26);border-bottom:1.5px solid rgba(214,150,0,.8);border-radius:2px;pointer-events:none;";
      return piece;
    }));
    // Beside the body, not in it: the page's own scripts and its text are left as they were.
    if (layer.parentNode !== document.documentElement) document.documentElement.appendChild(layer);
  }

  let lastHeight = -1;
  function reportSize() {
    const root = document.documentElement;
    // The scroll height is never less than the frame, so a page that fits is measured by its layout instead; otherwise the frame could only grow.
    const overflowing = root.scrollHeight > window.innerHeight + 1;
    const body = document.body?.getBoundingClientRect();
    const bodyMargin = document.body ? parseFloat(getComputedStyle(document.body).marginBottom) || 0 : 0;
    const height = Math.ceil(overflowing ? root.scrollHeight
      : Math.max(root.getBoundingClientRect().height, body ? body.bottom + window.scrollY + bodyMargin : 0));
    if (height !== lastHeight) { lastHeight = height; post({ type: "size", height }); }
  }

  let selected = false;
  function reportSelection() {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) {
      if (selected) { selected = false; post({ type: "clear" }); }
      return;
    }
    const range = selection.getRangeAt(0);
    const nodes = textNodes();
    const text = pageText(nodes);
    let start = offsetOf(nodes, range.startContainer, range.startOffset);
    let end = offsetOf(nodes, range.endContainer, range.endOffset);
    // Leading and trailing spaces and line breaks are not part of the passage.
    while (start < end && /\s/u.test(text[start])) start += 1;
    while (end > start && /\s/u.test(text[end - 1])) end -= 1;
    const quote = collapse(text.slice(start, end));
    if (!quote) return;
    const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 || rect.height > 0);
    const rect = rects.at(-1) ?? range.getBoundingClientRect();
    selected = true;
    post({ type: "selection", quote, start, end, context: collapse(text.slice(Math.max(0, start - 1500), end + 1500)),
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } });
  }

  let timer = 0;
  const later = (run: () => void, wait: number) => () => { window.clearTimeout(timer); timer = window.setTimeout(run, wait); };
  document.addEventListener("selectionchange", later(reportSelection, 300));
  document.addEventListener("mouseup", () => window.setTimeout(reportSelection, 0));
  document.addEventListener("keyup", () => window.setTimeout(reportSelection, 0));

  let marksFrame = 0;
  const queueMarks = () => { if (!anchors.length || marksFrame) return; marksFrame = requestAnimationFrame(() => { marksFrame = 0; reportMarks(); }); };
  const queueSize = () => requestAnimationFrame(reportSize);
  window.addEventListener("load", () => { reportSize(); queueMarks(); });
  window.addEventListener("resize", () => { queueSize(); queueMarks(); });
  document.addEventListener("scroll", queueMarks, true);
  document.addEventListener("DOMContentLoaded", () => {
    reportSize();
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => { queueSize(); queueMarks(); }).observe(document.documentElement);
    new MutationObserver(queueMarks).observe(document.body ?? document.documentElement, { childList: true, subtree: true, characterData: true });
  });

  // A click on a marked passage opens its note or chat; links open in a new tab, not inside the frame.
  document.addEventListener("click", (event) => {
    const link = (event.target as Element | null)?.closest?.("a[href]");
    if (link) {
      const href = link.getAttribute("href") ?? "";
      if (href.startsWith("#") || /^javascript:/iu.test(href)) return;
      event.preventDefault();
      if (/^(?:https?:|mailto:)/iu.test(href)) window.open(href, "_blank", "noopener,noreferrer");
      return;
    }
    if (!document.getSelection()?.isCollapsed) return;
    for (const { id, range } of markedRanges) {
      for (const rect of range.getClientRects()) {
        if (event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) { post({ type: "open", id }); return; }
      }
    }
  }, true);
  // A form the page doesn't handle itself would load something else into the frame.
  window.addEventListener("submit", (event) => { if (!event.defaultPrevented) event.preventDefault(); });

  /*
   * Games load their questions from the vault. `marginChat.getQuestions()` resolves with
   * { questions: [{ id, question, answer, choices?, correct?, deck }], decks }, and
   * `marginChat.onQuestions(listener)` is called again whenever the person's questions change.
   */
  let content: { questions: unknown[]; decks: unknown[] } = { questions: [], decks: [] };
  let contentKnown = false;
  let contentWaiters: Array<(value: unknown) => void> = [];
  const contentListeners = new Set<(value: unknown) => void>();
  const contentCopy = () => JSON.parse(JSON.stringify(content));
  stand(window, "marginChat", Object.freeze({
    version: 1,
    getQuestions: () => new Promise((resolve) => {
      if (contentKnown) { resolve(contentCopy()); return; }
      contentWaiters.push(resolve);
      post({ type: "content-request" });
      // Outside Margin Chat's reach (or before it answers) a game still starts, with nothing to ask yet.
      window.setTimeout(() => { if (contentWaiters.includes(resolve)) { contentWaiters = contentWaiters.filter((waiter) => waiter !== resolve); resolve(contentCopy()); } }, 3_000);
    }),
    onQuestions: (listener: (value: unknown) => void) => {
      if (typeof listener !== "function") return () => {};
      contentListeners.add(listener);
      if (contentKnown) window.setTimeout(() => { if (contentListeners.has(listener)) listener(contentCopy()); }, 0);
      else post({ type: "content-request" });
      return () => { contentListeners.delete(listener); };
    },
  }));

  /**
   * The page as it looks now between `top` and `bottom` (frame pixels; the app scrolls the frame, not the page).
   * Lines are rebuilt from where each piece of text sits, so a screen drawn by scripts reads in order.
   */
  function readScreen(top: number, bottom: number) {
    const lines: string[] = [];
    let line = "";
    let lineTop = Number.NaN;
    let lastParent: Element | null = null;
    const view = (rect: DOMRect) => rect.width > 0 && rect.height > 0 && rect.bottom + window.scrollY > top && rect.top + window.scrollY < bottom;
    for (const node of textNodes()) {
      const words = node.data.replace(/\s+/gu, " ");
      if (!words.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      if (!view(rect)) continue;
      if (!Number.isNaN(lineTop) && Math.abs(rect.top - lineTop) > rect.height / 2) { lines.push(line.trim()); line = ""; }
      if (Number.isNaN(lineTop) || !line) lineTop = rect.top;
      // Pieces side by side (a score, a button, a label) are separate words even with no space in the markup.
      line += line && !/\s$/u.test(line) && !/^\s/u.test(words) && range.startContainer.parentElement !== lastParent ? ` ${words}` : words;
      lastParent = range.startContainer.parentElement;
    }
    if (line.trim()) lines.push(line.trim());
    const fields: Array<{ label: string; value: string }> = [];
    for (const element of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("textarea, input, select")) {
      if (fields.length >= 20 || !view(element.getBoundingClientRect())) continue;
      const type = element instanceof HTMLInputElement ? element.type : "";
      if (/^(?:password|hidden|file|submit|button|reset|image)$/u.test(type)) continue;
      const value = element instanceof HTMLSelectElement ? element.selectedOptions[0]?.text ?? ""
        : /^(?:checkbox|radio)$/u.test(type) ? ((element as HTMLInputElement).checked ? "checked" : "") : element.value;
      if (!value.trim()) continue;
      const label = element.getAttribute("aria-label") || (element.id && document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.textContent)
        || element.getAttribute("placeholder") || element.getAttribute("name") || element.tagName.toLowerCase();
      fields.push({ label: collapse(label || ""), value: value.slice(0, 12_000) });
    }
    const page = (document.body?.innerText ?? "").replace(/\n{3,}/gu, "\n\n").trim();
    return { visible: lines.filter(Boolean).join("\n").slice(0, 12_000), fields, page: page.slice(0, 30_000) };
  }

  window.addEventListener("message", (event) => {
    if (event.source !== parentWindow || !event.data || event.data.marginHtml !== 1) return;
    if (event.data.type === "content" && Array.isArray(event.data.questions)) {
      content = { questions: event.data.questions, decks: Array.isArray(event.data.decks) ? event.data.decks : [] };
      contentKnown = true;
      const waiting = contentWaiters;
      contentWaiters = [];
      for (const resolve of waiting) resolve(contentCopy());
      for (const listener of contentListeners) { try { listener(contentCopy()); } catch { /* A game's own mistake stays its own. */ } }
      return;
    }
    if (event.data.type === "theme") { setTheme(event.data.theme); return; }
    if (event.data.type === "layout") { fills = event.data.layout === "fill"; reportMarks(); return; }
    if (event.data.type === "asset" && typeof event.data.id === "string") {
      const resolve = assetWaiters.get(event.data.id);
      assetWaiters.delete(event.data.id);
      resolve?.(event.data.blob instanceof Blob ? event.data.blob : null);
      return;
    }
    if (event.data.type === "read-screen" && typeof event.data.requestId === "string") {
      // A page that scrolls inside its frame shows what is in the frame's own window.
      const self = event.data.mode === "self";
      const top = self ? window.scrollY : Number(event.data.top) || 0;
      const bottom = self ? window.scrollY + window.innerHeight
        : Number.isFinite(Number(event.data.bottom)) ? Number(event.data.bottom) : Number.POSITIVE_INFINITY;
      let screen;
      try { screen = readScreen(top, bottom); } catch { screen = { visible: "", fields: [], page: "" }; }
      post({ type: "screen", requestId: event.data.requestId, screen });
      return;
    }
    if (event.data.type === "anchors" && Array.isArray(event.data.anchors)) { anchors = event.data.anchors; reportMarks(); }
    if (event.data.type === "clear-selection") { selected = false; document.getSelection()?.removeAllRanges(); }
  });
}

/** What `htmlFrameDocument` is told about the page beyond its text. */
export interface HtmlFrameOptions {
  /** Whether the page may ask for the files beside it. */
  assets?: boolean;
  /** The theme the page starts in; later changes are sent as `theme` messages, so the page isn't reloaded. */
  theme?: "light" | "dark";
  /** "fill" when the page scrolls inside its frame, so it draws its own highlight marks. */
  layout?: "fill" | "inline";
}

/** A change of layout, sent to the page's frame. */
export function htmlLayoutMessage(layout: "fill" | "inline") {
  return { marginHtml: 1 as const, type: "layout" as const, layout };
}

/** A change of theme, sent to the page's frame. */
export function htmlThemeMessage(theme: "light" | "dark") {
  return { marginHtml: 1 as const, type: "theme" as const, theme };
}

const VIEWPORT = /<meta\b[^>]*\bname\s*=\s*["']?viewport\b/iu;

/**
 * The page as the frame loads it: the bridge goes first in the head, after any doctype so the page keeps its rendering mode.
 * `storage` is what the page last kept in its localStorage. Nothing else is added to the page except a
 * viewport line when it has none, so it fits a phone as it would opened by itself.
 */
export function htmlFrameDocument(html: string, storage: Record<string, string> = {}, options: HtmlFrameOptions | boolean = {}) {
  const { assets = false, theme = "light", layout = "inline" }: HtmlFrameOptions = typeof options === "boolean" ? { assets: options } : options;
  // Escaped so the page's saved text can't close the script early.
  const saved = JSON.stringify(readStorageData(storage) ?? {}).replace(/</gu, "\\u003c").replace(/\u2028/gu, "\\u2028").replace(/\u2029/gu, "\\u2029");
  const viewport = VIEWPORT.test(html) ? "" : `<meta name="viewport" content="width=device-width,initial-scale=1">`;
  const script = `<script>(${bridge.toString()})(${saved},${assets ? "true" : "false"},"${theme === "dark" ? "dark" : "light"}","${layout === "fill" ? "fill" : "inline"}");</script>${viewport}`;
  const head = /<head(?:\s[^>]*)?>/iu.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + script + html.slice(head.index + head[0].length);
  const root = /<html(?:\s[^>]*)?>/iu.exec(html);
  if (root) return html.slice(0, root.index + root[0].length) + script + html.slice(root.index + root[0].length);
  const doctype = /^\s*<!doctype[^>]*>/iu.exec(html);
  return doctype ? doctype[0] + script + html.slice(doctype[0].length) : script + html;
}

const BLOCK = /^(?:ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|BR|DD|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|TR|UL)$/u;

/** A page's readable text for AI: its title and words, without scripts, styles or markup. */
export function htmlTextForAI(html: string) {
  if (typeof DOMParser === "undefined") {
    return html.replace(/<(script|style|noscript|template)[^>]*>[\s\S]*?<\/\1>/giu, " ")
      .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/giu, "\n").replace(/<[^>]+>/gu, " ")
      .replace(/&nbsp;/gu, " ").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&quot;/gu, "\"").replace(/&#39;/gu, "'").replace(/&amp;/gu, "&")
      .replace(/[ \t]+/gu, " ").replace(/ *\n[\s]*/gu, "\n").trim();
  }
  // Parsing never runs the page's scripts.
  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed.querySelectorAll("script, style, noscript, template").forEach((element) => element.remove());
  let text = "";
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) { text += (node as Text).data.replace(/\s+/gu, " "); return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const block = BLOCK.test((node as Element).tagName);
    if (block) text += "\n";
    node.childNodes.forEach(walk);
    if (block) text += "\n";
  };
  if (parsed.body) walk(parsed.body);
  const body = text.replace(/[ \t]+/gu, " ").replace(/ *\n\s*/gu, "\n").trim();
  const title = parsed.title.trim();
  return title && !body.startsWith(title) ? `${title}\n\n${body}` : body;
}
