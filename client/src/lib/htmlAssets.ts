/**
 * Files beside an HTML page. A page that lives in its own folder (a game with its scripts, styles,
 * pictures and engines) can load the other files in that folder. Notes and PDFs are never handed to
 * a page, and a page at the top of the vault gets nothing, so an uploaded page can't read the vault.
 */

const NOTE = /\.(?:md|markdown|txt|pdf)$/iu;
const TYPES: Record<string, string> = {
  js: "text/javascript", mjs: "text/javascript", css: "text/css", json: "application/json", wasm: "application/wasm",
  html: "text/html", htm: "text/html", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", avif: "image/avif", mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav",
  mp4: "video/mp4", webm: "video/webm", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", txt: "text/plain",
  csv: "text/csv", xml: "application/xml",
};

/** Whether this page may load files beside it: only a page inside a folder. */
export function htmlPageHasAssets(pagePath: string) {
  return pagePath.includes("/");
}

/** The vault path a page's relative address names, or null when the page may not have it. */
export function htmlAssetPath(pagePath: string, relative: string): string | null {
  if (!htmlPageHasAssets(pagePath) || typeof relative !== "string" || !relative || relative.length > 1_000) return null;
  const folder = pagePath.slice(0, pagePath.lastIndexOf("/"));
  const parts: string[] = [];
  for (const part of relative.split("/")) {
    if (part === "" || part === ".") continue;
    // Nothing above the page's own folder, and no hidden files.
    if (part === ".." || part.startsWith(".") || part.includes("\\")) return null;
    parts.push(part);
  }
  if (!parts.length || NOTE.test(parts.at(-1)!)) return null;
  const path = `${folder}/${parts.join("/")}`;
  return path === pagePath ? null : path;
}

export function htmlAssetContentType(path: string) {
  return TYPES[/\.([a-z0-9]+)$/iu.exec(path)?.[1]?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

const attribute = (attributes: string, name: string) => {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "iu").exec(attributes);
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : null;
};
const withoutAttribute = (attributes: string, name: string) =>
  attributes.replace(new RegExp(`(^|\\s)${name}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s"'>]+)`, "iu"), "$1");
/** An address inside the page's folder: no scheme, not from the site's root, not only a fragment. */
const relativeAddress = (value: string | null): value is string =>
  !!value && !/^(?:[a-z][a-z0-9+.-]*:|\/|#|\?)/iu.test(value.trim());
const decoded = (value: string) => {
  const path = value.trim().replace(/&amp;/gu, "&").split(/[?#]/u)[0]!;
  try { return decodeURIComponent(path); } catch { return path; }
};

/**
 * The page with the scripts and stylesheets its markup names put inside it, since the frame it runs in
 * has no address to load them from. They must be in place before the page's scripts run, in order;
 * everything a page asks for later (pictures, sounds, fetches, scripts it adds) is answered as it asks.
 */
export async function inlineHtmlAssets(html: string, load: (relative: string) => Promise<string | null>): Promise<string> {
  const SCRIPT = /<script\b([^>]*)>\s*<\/script\s*>/giu;
  const LINK = /<link\b([^>]*?)\/?>/giu;
  const wanted = new Map<string, Promise<string | null>>();
  const want = (address: string) => {
    const path = decoded(address);
    if (!wanted.has(path)) wanted.set(path, load(path).catch(() => null));
    return path;
  };
  const scriptAddress = (attributes: string) => {
    const src = attribute(attributes, "src");
    return relativeAddress(src) && !/^module$/iu.test(attribute(attributes, "type") ?? "") ? src : null;
  };
  const sheetAddress = (attributes: string) => {
    const href = attribute(attributes, "href");
    return relativeAddress(href) && /(?:^|\s)stylesheet(?:\s|$)/iu.test(attribute(attributes, "rel") ?? "") ? href : null;
  };
  for (const match of html.matchAll(SCRIPT)) { const address = scriptAddress(match[1]!); if (address) want(address); }
  for (const match of html.matchAll(LINK)) { const address = sheetAddress(match[1]!); if (address) want(address); }
  if (!wanted.size) return html;
  const loaded = new Map<string, string | null>();
  await Promise.all([...wanted].map(async ([path, text]) => { loaded.set(path, await text); }));
  // A deferred script waits for the whole page; text inside the page can't wait, so it moves to the page's end.
  const deferred: string[] = [];
  const page = html
    .replace(SCRIPT, (tag, attributes: string) => {
      const address = scriptAddress(attributes);
      const text = address ? loaded.get(decoded(address)) : null;
      if (address == null || text == null) return tag;
      const waits = /(?:^|\s)defer(?:[\s=]|$)/iu.test(attributes);
      const kept = withoutAttribute(attributes, "src").replace(/(^|\s)defer(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?(?=\s|$)/iu, "$1").replace(/\s+/gu, " ").trim();
      // The file's own text can't be allowed to close the tag early.
      const script = `<script${kept ? ` ${kept}` : ""} data-src="${address.replace(/"/gu, "&quot;")}">${text.replace(/<\/script/giu, "<\\/script")}</script>`;
      if (!waits) return script;
      deferred.push(script);
      return "";
    })
    .replace(LINK, (tag, attributes: string) => {
      const address = sheetAddress(attributes);
      const text = address ? loaded.get(decoded(address)) : null;
      if (address == null || text == null) return tag;
      const media = attribute(attributes, "media");
      return `<style data-href="${address.replace(/"/gu, "&quot;")}"${media ? ` media="${media.replace(/"/gu, "&quot;")}"` : ""}>${text.replace(/<\/style/giu, "<\\/style")}</style>`;
    });
  if (!deferred.length) return page;
  const end = page.search(/<\/body\s*>(?![\s\S]*<\/body\s*>)/iu);
  return end < 0 ? page + deferred.join("") : page.slice(0, end) + deferred.join("") + page.slice(end);
}
