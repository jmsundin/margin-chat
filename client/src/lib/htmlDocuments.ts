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
  | { marginHtml: 1; type: "open"; id: string };

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
    case "open": return typeof message.id === "string" && message.id.length <= 200 ? { marginHtml: 1, type: "open", id: message.id } : null;
    case "selection": {
      const { quote, start, end, context, rect } = message;
      if (typeof quote !== "string" || !quote.trim() || quote.length > 20_000 || typeof context !== "string" || context.length > 40_000) return null;
      if (!finite(start) || !finite(end) || start < 0 || end < start || !isRect(rect)) return null;
      return { marginHtml: 1, type: "selection", quote, start, end, context, rect };
    }
    case "marks": {
      if (!Array.isArray(message.marks) || message.marks.length > 2_000) return null;
      const marks = message.marks.filter((mark): mark is HtmlRect & { id: string } => isRect(mark) && typeof (mark as { id?: unknown }).id === "string");
      return { marginHtml: 1, type: "marks", marks };
    }
    default: return null;
  }
}

/**
 * Runs inside the frame, before the page's own scripts. It must stay
 * self-contained: it is sent to the frame as source text.
 */
function bridge() {
  const SKIP = /^(?:SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TEXTAREA|SELECT|OPTION)$/u;
  const parentWindow = window.parent;
  const post = (message: Record<string, unknown>) => parentWindow.postMessage({ marginHtml: 1, ...message }, "*");
  let anchors: Array<{ id: string; quote: string; start: number; end: number }> = [];

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

  window.addEventListener("message", (event) => {
    if (event.source !== parentWindow || !event.data || event.data.marginHtml !== 1) return;
    if (event.data.type === "anchors" && Array.isArray(event.data.anchors)) { anchors = event.data.anchors; reportMarks(); }
    if (event.data.type === "clear-selection") { selected = false; document.getSelection()?.removeAllRanges(); }
  });
}

/** The page as the frame loads it: the bridge goes first in the head, after any doctype so the page keeps its rendering mode. */
export function htmlFrameDocument(html: string) {
  const script = `<script>(${bridge.toString()})();</script>`;
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
