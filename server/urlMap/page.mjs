import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import ipaddr from "ipaddr.js";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import { HttpError } from "../lib/errors.mjs";
import { MAX_DOCUMENT_BYTES, extractDocumentText } from "../documents/extraction.mjs";

export const PAGE_BYTE_LIMIT = 1_500_000;
export const PAGE_TEXT_LIMIT = 12_000;

export function isPublicPageAddress(address) {
  try {
    const parsed = ipaddr.process(address);
    return parsed.toString() !== "168.63.129.16" && parsed.range() === "unicast";
  } catch { return false; }
}

export function normalizePublicPageUrl(input) {
  let url;
  try { url = new URL(input); } catch { throw new HttpError(400, "Enter a complete http or https web address."); }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
    || (url.port && !["80", "443"].includes(url.port))
    || /(^|\.)(localhost|local|internal|home|test|invalid)$/i.test(hostname)
    || (ipaddr.isValid(hostname) && !isPublicPageAddress(hostname))) {
    throw new HttpError(400, "Use a public webpage with no sign-in details in its address.");
  }
  url.hash = "";
  return url;
}

export async function resolvePublicPageAddress(url, lookupImpl = lookup) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = ipaddr.isValid(hostname)
    ? [{ address: hostname, family: ipaddr.parse(hostname).kind() === "ipv4" ? 4 : 6 }]
    : await lookupImpl(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicPageAddress(address))) {
    throw new HttpError(400, "That address does not point to a public webpage.");
  }
  return addresses[0];
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function download(url, address, signal, { pdf = false, json = false, userAgent = "MarginChat-URLMap/0.1" } = {}) {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: "GET", agent: false, signal,
      headers: { "User-Agent": userAgent, Accept: json ? "application/json" : `text/html,text/plain;q=0.8${pdf ? ",application/pdf;q=0.7" : ""}`, "Accept-Encoding": "identity" },
      // Pin the validated address; a second DNS lookup could resolve to a private host.
      lookup(_hostname, options, callback) {
        if (options.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      },
    }, (response) => {
      const status = response.statusCode ?? 502;
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.destroy(); resolve({ status, location: response.headers.location }); return;
      }
      if (status < 200 || status >= 300) {
        response.destroy(); reject(new HttpError(422, `The webpage returned ${status}. Try another public page.`)); return;
      }
      const contentType = String(response.headers["content-type"] ?? "").toLowerCase();
      const isPdf = pdf && /^application\/pdf(;|$)/.test(contentType);
      const isJson = json && /^application\/json(;|$)/.test(contentType);
      if (!isPdf && !isJson && !/^(text\/html|application\/xhtml\+xml|text\/plain)(;|$)/.test(contentType)) {
        response.destroy(); reject(new HttpError(422, pdf ? "Only webpages, plain text and PDFs can be read." : "Choose an HTML webpage or a plain-text page for this first version.")); return;
      }
      const byteLimit = isPdf ? MAX_DOCUMENT_BYTES : PAGE_BYTE_LIMIT;
      if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") {
        response.destroy(); reject(new HttpError(422, "This page could not be read in a supported format. Try another URL.")); return;
      }
      let size = 0;
      const chunks = [];
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > byteLimit) response.destroy(new HttpError(413, isPdf ? "This PDF is too large to read." : "This page is too large to map. Try a shorter article."));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        const body = Buffer.concat(chunks);
        resolve(isPdf ? { status, contentType, buffer: body } : { status, contentType, html: body.toString("utf8") });
      });
    });
    request.on("error", reject);
    request.end();
  });
}

const clean = (text) => String(text ?? "").replace(/\s+/gu, " ").trim();

function absoluteWebUrl(value, base) {
  try {
    const url = new URL(value, base);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

/** Readable HTML as Markdown: headings, paragraphs, lists, quotes, code, tables, links and images. */
export function htmlToMarkdown(root, baseUrl, { links = true } = {}) {
  const inline = (node) => [...node.childNodes].map((child) => render(child, 0)).join("").replace(/[ \t]*\n[ \t]*/gu, " ");
  const block = (text) => `\n\n${text.trim()}\n\n`;
  const list = (node, depth) => {
    const ordered = node.localName === "ol";
    let index = 0;
    const items = [...node.children].filter((child) => child.localName === "li").map((item) => {
      index += 1;
      const nested = [...item.children].filter((child) => child.localName === "ul" || child.localName === "ol");
      for (const child of nested) child.remove();
      const text = inline(item).replace(/\s+/gu, " ").trim();
      const marker = ordered ? `${index}.` : "-";
      return `${"  ".repeat(depth)}${marker} ${text}${nested.map((child) => `\n${list(child, depth + 1)}`).join("")}`;
    });
    return items.join("\n");
  };
  function render(node, depth) {
    if (node.nodeType === 3) return String(node.textContent ?? "").replace(/\s+/gu, " ");
    if (node.nodeType !== 1) return "";
    const tag = node.localName;
    const children = () => [...node.childNodes].map((child) => render(child, depth)).join("");
    if (/^h[1-6]$/.test(tag)) { const text = inline(node).trim(); return text ? block(`${"#".repeat(Number(tag[1]))} ${text}`) : ""; }
    if (tag === "br") return "\n";
    if (tag === "hr") return block("---");
    if (tag === "ul" || tag === "ol") return depth ? `\n${list(node, depth)}` : block(list(node, 0));
    if (tag === "pre") return block(`\`\`\`\n${String(node.textContent ?? "").replace(/\n+$/u, "")}\n\`\`\``);
    if (tag === "code") { const text = String(node.textContent ?? ""); return text ? `\`${text}\`` : ""; }
    if (tag === "blockquote") return block(children().trim().replace(/\n{3,}/gu, "\n\n").split("\n").map((line) => `> ${line}`.trimEnd()).join("\n"));
    if (tag === "strong" || tag === "b") { const text = inline(node).trim(); return text ? `**${text}**` : ""; }
    if (tag === "em" || tag === "i") { const text = inline(node).trim(); return text ? `*${text}*` : ""; }
    if (tag === "a") {
      const text = inline(node).trim();
      const href = absoluteWebUrl(node.getAttribute("href"), baseUrl);
      return text && href && links ? `[${text}](${href})` : text;
    }
    if (tag === "img") {
      const src = absoluteWebUrl(node.getAttribute("src"), baseUrl);
      const alt = clean(node.getAttribute("alt"));
      return src && alt && links ? `![${alt}](${src})` : "";
    }
    if (tag === "table") {
      const rows = [...node.querySelectorAll("tr")].map((row) => [...row.children]
        .filter((cell) => cell.localName === "td" || cell.localName === "th")
        .map((cell) => inline(cell).replace(/\s+/gu, " ").replace(/\|/gu, "\\|").trim()));
      const width = Math.max(0, ...rows.map((row) => row.length));
      if (!width) return "";
      const line = (cells) => `| ${Array.from({ length: width }, (_, index) => cells[index] ?? "").join(" | ")} |`;
      return block([line(rows[0]), line(Array(width).fill("---")), ...rows.slice(1).map(line)].join("\n"));
    }
    if (["p", "div", "section", "article", "main", "header", "figure", "figcaption", "dl", "dt", "dd", "details", "summary"].includes(tag)) return block(children());
    return children();
  }
  return render(root, 0).split("\n").map((line) => line.trimEnd()).join("\n").replace(/\n{3,}/gu, "\n\n").trim();
}

export function extractPage(html, url, contentType = "text/html", { markdown = false, markdownLinks = true, textLimit = PAGE_TEXT_LIMIT, linkLimit = 24 } = {}) {
  let text = html, title = new URL(url).hostname, byline = null;
  const links = [];
  if (!contentType.startsWith("text/plain")) {
    const { document } = parseHTML(html);
    // Parsing never runs scripts or loads images, frames, or other page resources.
    for (const node of document.querySelectorAll("script,style,noscript,iframe,form,nav,footer,[hidden],[aria-hidden='true']")) node.remove();
    title = clean(document.title) || title;
    if (!markdown) for (const node of document.querySelectorAll("p,li,h1,h2,h3,h4,blockquote,br")) node.appendChild(document.createTextNode("\n"));
    const fallback = document.querySelector("main,article") ?? document.body;
    let article = null;
    try { article = new Readability(document.cloneNode(true), { maxElemsToParse: 30_000, charThreshold: 100, disableJSONLD: true }).parse(); } catch { /* Text fallback for short pages. */ }
    text = article?.textContent || fallback?.textContent || "";
    title = clean(article?.title) || title;
    byline = clean(article?.byline) || null;
    const source = article?.content ? parseHTML(`<html><body>${article.content}</body></html>`).document.body : fallback;
    if (markdown) text = source ? htmlToMarkdown(source.cloneNode(true), url, { links: markdownLinks }) : "";
    const seen = new Set([url]);
    for (const link of source?.querySelectorAll("a[href]") ?? []) {
      try {
        const target = normalizePublicPageUrl(new URL(link.getAttribute("href"), url).href).href;
        const label = clean(link.textContent).slice(0, 120);
        if (label && !seen.has(target)) { links.push({ url: target, label }); seen.add(target); }
        if (links.length === linkLimit) break;
      } catch { /* Skip non-web and local links. */ }
    }
  }
  text = markdown ? String(text ?? "").replace(/\n{3,}/gu, "\n\n").trim() : clean(text);
  if (clean(text).length < 100) throw new HttpError(422, "There is not enough readable text on this page. It may require sign-in or JavaScript. Try an article URL.");
  // Readability lifts the article's own heading into its title; put it back on top.
  if (markdown && !contentType.startsWith("text/plain") && !/^#\s/u.test(text)) text = `# ${title}\n\n${text}`;
  return { url, title: title.slice(0, 240), byline, text: text.slice(0, textLimit), truncated: text.length > textLimit, links, retrievedAt: new Date().toISOString() };
}

async function extractPdfPage(buffer, url, textLimit) {
  let sections;
  try { sections = await extractDocumentText({ buffer, filename: "page.pdf", mimeType: "application/pdf" }); } catch {
    throw new HttpError(422, "This PDF has no readable text. It may be scanned images.");
  }
  const text = sections.map((section) => section.content.trim()).filter(Boolean).join("\n\n");
  const last = new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "";
  let name = last;
  try { name = decodeURIComponent(last); } catch { /* Keep the encoded name. */ }
  name ||= new URL(url).hostname;
  return { url, title: name.slice(0, 240), byline: null, text: text.slice(0, textLimit), truncated: text.length > textLimit, links: [], pdf: true, retrievedAt: new Date().toISOString() };
}

/**
 * Download a public page, following redirects only to other public addresses, and
 * return its body: `html` for HTML and plain text, `buffer` for a PDF when `pdf` is set.
 */
export async function fetchPublicPage(input, { signal, lookupImpl = lookup, downloadImpl = download, pdf = false, json = false, userAgent } = {}) {
  const timeout = AbortSignal.timeout(20_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let url = normalizePublicPageUrl(input);
  try {
    for (let redirects = 0; redirects <= 4; redirects += 1) {
      combined.throwIfAborted();
      const address = await abortable(resolvePublicPageAddress(url, lookupImpl), combined);
      combined.throwIfAborted();
      const result = await downloadImpl(url, address, combined, { pdf, json, ...(userAgent ? { userAgent } : {}) });
      combined.throwIfAborted();
      if (result.location) { url = normalizePublicPageUrl(new URL(result.location, url).href); continue; }
      return { ...result, url: url.href };
    }
    throw new HttpError(422, "This page redirects too many times. Try its final article address.");
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (timeout.aborted) throw new HttpError(504, "The webpage took too long to respond. Try again or choose another page.");
    if (error instanceof HttpError) throw error;
    throw new HttpError(422, "The webpage could not be reached. Check the address or try another public page.");
  }
}

/**
 * Download a public page and return its readable text. `markdown` keeps headings,
 * lists and links as Markdown (link addresses only with `markdownLinks`); `pdf` also accepts PDF files.
 */
export async function readPublicPage(input, { markdown = false, markdownLinks = true, textLimit = PAGE_TEXT_LIMIT, linkLimit, ...options } = {}) {
  const result = await fetchPublicPage(input, options);
  if (result.buffer) return extractPdfPage(result.buffer, result.url, textLimit);
  return extractPage(result.html, result.url, result.contentType, { markdown, markdownLinks, textLimit, ...(linkLimit ? { linkLimit } : {}) });
}
