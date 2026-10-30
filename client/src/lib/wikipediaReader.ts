import { wikipediaArticleUrl } from "./wikipedia";

/**
 * Wikipedia articles shown inside Margin Chat as the page itself: the
 * mobile Wikipedia page (Wikipedia's own HTML and stylesheets) in a
 * same-origin frame that runs no scripts, so text can still be selected and
 * marked like a document's.
 */

const PAGE_URL = "https://en.wikipedia.org/api/rest_v1/page/mobile-html/";
const REQUEST_TIMEOUT = 15_000;
/** Wikipedia's own page styles; the scripts that normally sit beside them are left out. */
export const WIKIPEDIA_STYLESHEETS = [
  "https://meta.wikimedia.org/api/rest_v1/data/css/mobile/base",
  "https://meta.wikimedia.org/api/rest_v1/data/css/mobile/pcs",
  "https://en.wikipedia.org/api/rest_v1/data/css/mobile/site",
];

export interface WikipediaArticle { title: string; url: string; html: string }

/** Whole elements left out: anything active, and page parts that only work with Wikipedia's scripts. */
const DROP = new Set(["script", "iframe", "object", "embed", "form", "input", "button", "textarea", "select", "noscript", "template", "audio", "video", "base", "meta", "link", "style", "frame", "frameset", "applet"]);
const DROP_CLASS = /\b(pcs-edit-section-link-container|pcs-edit-section-link|mw-editsection|pcs-footer|pcs-collapse-table-collapsed-container|pcs-collapse-table-collapsed-bottom|noprint)\b/;
const SAFE_URL = /^(https:\/\/|\/\/|\.\/|#)/i;

const titleFromHref = (href: string) => {
  const match = /^(?:\.\/|\/wiki\/|(?:https?:)?\/\/en\.(?:m\.)?wikipedia\.org\/wiki\/)([^?#]+)(#.*)?$/.exec(href);
  if (!match) return null;
  try {
    const title = decodeURIComponent(match[1]).replace(/_/g, " ");
    return /^(File|Image|Category|Help|Special|Wikipedia|Template|Portal|Talk|User|Module|Draft):/i.test(title) ? null : title;
  } catch { return null; }
};
const absolute = (url: string) => url.startsWith("//") ? `https:${url}` : url;
const imageUrl = (url: string) => /^https:\/\/upload\.wikimedia\.org\//.test(absolute(url)) ? absolute(url) : null;

/**
 * Wikipedia's page markup with everything active taken out: scripts, event
 * attributes, frames and forms go, links and images must be web addresses,
 * and images Wikipedia loads with script are turned into plain images.
 * Links to other articles get `data-wiki-title` so the pane opens them in place.
 */
export function sanitizePageHtml(html: string, parse: (html: string) => Document = (text) => new DOMParser().parseFromString(text, "text/html")): string {
  const page = parse(html);
  // Images Wikipedia's script would load: <span class="pcs-lazy-load-placeholder" data-src=…>.
  for (const placeholder of Array.from(page.querySelectorAll("span.pcs-lazy-load-placeholder"))) {
    const src = imageUrl(placeholder.getAttribute("data-src") ?? "");
    if (!src) { placeholder.remove(); continue; }
    const image = page.createElement("img");
    image.setAttribute("src", src);
    for (const [from, to] of [["data-width", "width"], ["data-height", "height"], ["data-alt", "alt"], ["data-class", "class"]]) {
      const value = placeholder.getAttribute(from);
      if (value) image.setAttribute(to, value);
    }
    const srcset = (placeholder.getAttribute("data-srcset") ?? "").split(",").map((entry) => entry.trim().split(/\s+/)).flatMap(([url, size]) => {
      const safe = url ? imageUrl(url) : null;
      return safe ? [`${safe}${size ? ` ${size}` : ""}`] : [];
    });
    if (srcset.length) image.setAttribute("srcset", srcset.join(", "));
    placeholder.replaceWith(image);
  }
  const clean = (element: Element) => {
    for (const child of Array.from(element.children)) {
      const tag = child.tagName.toLowerCase();
      if (DROP.has(tag) || DROP_CLASS.test(child.getAttribute("class") ?? "")) { child.remove(); continue; }
      for (const attribute of Array.from(child.attributes)) {
        const name = attribute.name.toLowerCase(), value = attribute.value;
        const keep = name === "class" || name === "id" || name === "title" || name === "alt" || name === "lang" || name === "dir" || name === "colspan" || name === "rowspan"
          || name === "width" || name === "height" || name === "role" || name === "scope" || name.startsWith("aria-")
          || (name === "style" && !/url\s*\(|expression|@import|behavior/i.test(value))
          || (name === "href" && tag === "a" && SAFE_URL.test(value.trim()))
          || ((name === "src" || name === "srcset") && tag === "img");
        if (!keep) child.removeAttribute(attribute.name);
      }
      if (tag === "img") {
        const src = imageUrl(child.getAttribute("src") ?? "");
        if (!src) { child.remove(); continue; }
        child.setAttribute("src", src);
        const srcset = child.getAttribute("srcset");
        if (srcset) {
          const safe = srcset.split(",").map((entry) => entry.trim().split(/\s+/)).flatMap(([url, size]) => { const ok = url ? imageUrl(url) : null; return ok ? [`${ok}${size ? ` ${size}` : ""}`] : []; });
          if (safe.length) child.setAttribute("srcset", safe.join(", ")); else child.removeAttribute("srcset");
        }
        child.setAttribute("loading", "lazy");
      }
      if (tag === "a") {
        const href = child.getAttribute("href") ?? "";
        const title = titleFromHref(href);
        if (title) { child.setAttribute("href", wikipediaArticleUrl(title)); child.setAttribute("data-wiki-title", title); }
        else if (href.startsWith("#")) { /* A footnote or section on the same page. */ }
        else if (/^(https:)?\/\//i.test(href)) { child.setAttribute("href", absolute(href)); child.setAttribute("target", "_blank"); child.setAttribute("rel", "noreferrer noopener"); }
        else child.removeAttribute("href");
      }
      clean(child);
    }
  };
  clean(page.body);
  return page.body.innerHTML;
}

/** Wikipedia's page colour in each theme, so the pane around the frame matches it. */
export const WIKIPEDIA_BACKGROUND = { light: "#ffffff", dark: "#101418" } as const;

/**
 * The page shown in the frame: Wikipedia's styles in its light or dark
 * theme, the cleaned article, and Margin Chat's marks. Sections and tables
 * that Wikipedia's script would expand are shown open, as on the site.
 */
export function wikipediaPageDocument(article: WikipediaArticle, theme: "light" | "dark") {
  const styles = WIKIPEDIA_STYLESHEETS.map((href) => `<link rel="stylesheet" href="${href}">`).join("");
  return `<!doctype html><html lang="en" dir="ltr" class="pcs-v2"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><base href="https://en.wikipedia.org/wiki/" target="_blank">${styles}`
    + `<style>html,body{overflow:hidden!important}body{margin:0!important;padding:8px 34px 24px 16px}`
    + `.pcs-section-hidden{display:block!important}.pcs-collapse-table-collapsed-container,.pcs-collapse-table-collapsed-bottom{display:none!important}.pcs-collapse-table-content{display:block!important}`
    + `::highlight(explore-passage-notes){text-decoration:underline dotted #3d9b78 2px;text-underline-offset:3px;background-color:rgba(61,155,120,.16)}`
    + `::highlight(explore-passage-highlights){background-color:rgba(255,212,121,.45)}</style></head>`
    + `<body class="pcs-theme-${theme === "dark" ? "dark" : "default"}"><div id="pcs" class="mw-body-content">${article.html}</div></body></html>`;
}

const articleCache = new Map<string, WikipediaArticle>();

/** Reads and cleans one article page. */
export async function fetchWikipediaArticle(title: string, signal?: AbortSignal): Promise<WikipediaArticle> {
  const key = title.trim().replace(/ /g, "_");
  const cached = articleCache.get(key);
  if (cached) return cached;
  let response: Response;
  try {
    response = await fetch(`${PAGE_URL}${encodeURIComponent(key)}?redirect=true`, {
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
  // The page's own body: its #pcs wrapper when there is one.
  const inner = parsed.querySelector("#pcs")?.innerHTML ?? parsed.body.innerHTML;
  const article = { title: resolved, url: wikipediaArticleUrl(resolved), html: sanitizePageHtml(`<body>${inner}</body>`) };
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
