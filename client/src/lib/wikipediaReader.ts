import { wikipediaArticleUrl } from "./wikipedia";

/**
 * Wikipedia articles drawn inside Margin Chat, so their text can be selected
 * like a document's. The article's HTML is cut down to an allowlist of
 * reading tags and attributes before it is shown.
 */

const HTML_URL = "https://en.wikipedia.org/api/rest_v1/page/html/";
const REQUEST_TIMEOUT = 15_000;

export interface WikipediaArticle { title: string; url: string; html: string }

const KEEP = new Set(["p", "a", "b", "i", "em", "strong", "u", "s", "small", "ul", "ol", "li", "h2", "h3", "h4", "h5", "blockquote", "table", "thead", "tbody", "tfoot", "tr", "td", "th",
  "caption", "img", "figure", "figcaption", "span", "div", "section", "sub", "sup", "dl", "dt", "dd", "br", "code", "pre", "abbr", "cite", "q", "math", "hr"]);
/** Whole elements left out: page furniture, citations and anything active. */
const DROP = new Set(["script", "style", "link", "meta", "iframe", "object", "embed", "form", "input", "button", "textarea", "select", "noscript", "template", "svg", "audio", "video", "source", "base", "title", "head"]);
const DROP_CLASS = /\b(navbox|vertical-navbox|reflist|references|mw-references-wrap|reference|mw-ref|mw-editsection|hatnote|ambox|metadata|noprint|sistersitebox|portalbox|shortdescription|mw-empty-elt|sidebar|authority-control)\b/;
const DROP_SECTIONS = /^(references|notes|footnotes|citations|sources|bibliography|further reading|external links|works cited|notes and references|references and notes|general and cited references|cited sources)$/i;

const titleFromHref = (href: string) => {
  const match = /^(?:\.\/|\/wiki\/|https?:\/\/en\.wikipedia\.org\/wiki\/)([^?#]+)(#.*)?$/.exec(href);
  if (!match) return null;
  try {
    const title = decodeURIComponent(match[1]).replace(/_/g, " ");
    return /^(File|Image|Category|Help|Special|Wikipedia|Template|Portal|Talk|User|Module|Draft):/i.test(title) ? null : title;
  } catch { return null; }
};

/**
 * Keeps only reading markup. Links to other articles get `data-wiki-title`
 * so the pane can open them in place; other links open in a new tab.
 */
export function sanitizeArticleHtml(html: string, parse: (html: string) => Document = (text) => new DOMParser().parseFromString(text, "text/html")): string {
  const source = parse(html);
  const output = parse("<!doctype html><html><body></body></html>");
  const copy = (node: Node, into: Element) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) { into.appendChild(output.createTextNode(child.textContent ?? "")); continue; }
      if (child.nodeType !== 1) continue;
      const element = child as Element;
      const tag = element.tagName.toLowerCase();
      if (DROP.has(tag) || DROP_CLASS.test(element.getAttribute("class") ?? "") || element.getAttribute("role") === "navigation" || element.getAttribute("style")?.includes("display:none")) continue;
      if (tag === "section") {
        const heading = element.querySelector("h2, h3")?.textContent?.trim() ?? "";
        if (DROP_SECTIONS.test(heading)) continue;
      }
      if (!KEEP.has(tag)) { copy(element, into); continue; }
      const clean = output.createElement(tag);
      if (tag === "a") {
        const href = element.getAttribute("href") ?? "";
        const title = titleFromHref(href);
        if (title) { clean.setAttribute("href", wikipediaArticleUrl(title)); clean.setAttribute("data-wiki-title", title); }
        else if (/^https?:\/\//i.test(href)) { clean.setAttribute("href", href); clean.setAttribute("target", "_blank"); clean.setAttribute("rel", "noreferrer noopener"); }
      } else if (tag === "img") {
        const src = element.getAttribute("src") ?? "";
        const absolute = src.startsWith("//") ? `https:${src}` : src;
        if (!/^https:\/\/upload\.wikimedia\.org\//.test(absolute)) continue;
        clean.setAttribute("src", absolute);
        clean.setAttribute("alt", element.getAttribute("alt") ?? "");
        clean.setAttribute("loading", "lazy");
        for (const attribute of ["width", "height"]) { const value = element.getAttribute(attribute); if (value && /^\d{1,4}$/.test(value)) clean.setAttribute(attribute, value); }
      } else if (tag === "td" || tag === "th") {
        for (const attribute of ["colspan", "rowspan"]) { const value = element.getAttribute(attribute); if (value && /^\d{1,2}$/.test(value)) clean.setAttribute(attribute, value); }
      } else if (tag === "table" && /\binfobox\b/.test(element.getAttribute("class") ?? "")) {
        clean.setAttribute("class", "infobox");
      }
      copy(element, clean);
      into.appendChild(clean);
    }
  };
  copy(source.body, output.body);
  return output.body.innerHTML;
}

const articleCache = new Map<string, WikipediaArticle>();

/** Reads and cleans one article. */
export async function fetchWikipediaArticle(title: string, signal?: AbortSignal): Promise<WikipediaArticle> {
  const key = title.trim().replace(/ /g, "_");
  const cached = articleCache.get(key);
  if (cached) return cached;
  let response: Response;
  try {
    response = await fetch(`${HTML_URL}${encodeURIComponent(key)}?redirect=true`, {
      signal: AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT), ...(signal ? [signal] : [])]),
      credentials: "omit", referrerPolicy: "no-referrer", headers: { Accept: "text/html" },
    });
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof DOMException && error.name === "TimeoutError") throw new Error("Wikipedia took too long to respond. Please try again.");
    throw new Error("Could not reach Wikipedia. Check your connection and try again.");
  }
  if (response.status === 404) throw new Error(`Wikipedia has no article called “${title}”.`);
  if (!response.ok) throw new Error(response.status === 429 ? "Wikipedia is receiving too many requests. Please try again shortly." : `Wikipedia is temporarily unavailable (${response.status}).`);
  const text = await response.text();
  const parsed = new DOMParser().parseFromString(text, "text/html");
  const resolved = parsed.querySelector("title")?.textContent?.trim() || title;
  const article = { title: resolved, url: wikipediaArticleUrl(resolved), html: sanitizeArticleHtml(text) };
  articleCache.set(key, article);
  while (articleCache.size > 24) articleCache.delete(articleCache.keys().next().value!);
  return article;
}

/** A note or highlight on an article passage, kept with the exploration until saved. */
export interface PassageNote {
  id: string;
  /** The article's title. */
  article: string;
  url: string;
  quote: string;
  /** Empty for a highlight. */
  text: string;
  kind: "note" | "highlight";
  createdAt: string;
}

export function isPassageNote(value: unknown): value is PassageNote {
  if (!value || typeof value !== "object") return false;
  const note = value as Record<string, unknown>;
  return typeof note.id === "string" && typeof note.article === "string" && typeof note.url === "string" && typeof note.quote === "string" && note.quote.length <= 4000
    && typeof note.text === "string" && note.text.length <= 10_000 && (note.kind === "note" || note.kind === "highlight") && typeof note.createdAt === "string";
}

/**
 * Where a quote sits in a run of text: the first exact match, else one with
 * whitespace evened out. Offsets are into `text`.
 */
export function findQuote(text: string, quote: string): { start: number; end: number } | null {
  const exact = text.indexOf(quote);
  if (exact >= 0) return { start: exact, end: exact + quote.length };
  const words = quote.trim().split(/\s+/).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length || !words[0]) return null;
  const match = new RegExp(words.join("\\s+")).exec(text);
  return match ? { start: match.index, end: match.index + match[0].length } : null;
}

/** Markdown for a document made from a passage, with where it came from. */
export function passageMarkdown(note: Pick<PassageNote, "article" | "url" | "quote" | "text">) {
  const quote = note.quote.trim().split(/\n+/).map((line) => `> ${line}`).join("\n>\n");
  return `${quote}\n\n— [${note.article.replace(/[[\]]/g, "")}](${note.url}), Wikipedia\n\n${note.text.trim()}${note.text.trim() ? "\n" : ""}`;
}

/** A short title for a document made from a passage. */
export function passageTitle(quote: string) {
  const words = quote.replace(/\s+/g, " ").trim().split(" ");
  return words.length > 8 ? `${words.slice(0, 8).join(" ")}…` : words.join(" ");
}
