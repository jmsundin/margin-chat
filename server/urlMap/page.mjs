import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import ipaddr from "ipaddr.js";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import { HttpError } from "../lib/errors.mjs";

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

function download(url, address, signal) {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: "GET", agent: false, signal,
      headers: { "User-Agent": "MarginChat-URLMap/0.1", Accept: "text/html,text/plain;q=0.8", "Accept-Encoding": "identity" },
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
      if (!/^(text\/html|application\/xhtml\+xml|text\/plain)(;|$)/.test(contentType)) {
        response.destroy(); reject(new HttpError(422, "Choose an HTML webpage or a plain-text page for this first version.")); return;
      }
      if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") {
        response.destroy(); reject(new HttpError(422, "This page could not be read in a supported format. Try another URL.")); return;
      }
      let size = 0;
      const chunks = [];
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > PAGE_BYTE_LIMIT) response.destroy(new HttpError(413, "This page is too large to map. Try a shorter article."));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => resolve({ status, contentType, html: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end();
  });
}

const clean = (text) => String(text ?? "").replace(/\s+/gu, " ").trim();

export function extractPage(html, url, contentType = "text/html") {
  let text = html, title = new URL(url).hostname, byline = null;
  const links = [];
  if (!contentType.startsWith("text/plain")) {
    const { document } = parseHTML(html);
    // Parsing never runs scripts or loads images, frames, or other page resources.
    for (const node of document.querySelectorAll("script,style,noscript,iframe,form,nav,footer,[hidden],[aria-hidden='true']")) node.remove();
    title = clean(document.title) || title;
    for (const node of document.querySelectorAll("p,li,h1,h2,h3,h4,blockquote,br")) node.appendChild(document.createTextNode("\n"));
    const fallback = document.querySelector("main,article") ?? document.body;
    let article = null;
    try { article = new Readability(document.cloneNode(true), { maxElemsToParse: 30_000, charThreshold: 100, disableJSONLD: true }).parse(); } catch { /* Text fallback for short pages. */ }
    text = article?.textContent || fallback?.textContent || "";
    title = clean(article?.title) || title;
    byline = clean(article?.byline) || null;
    const source = article?.content ? parseHTML(`<html><body>${article.content}</body></html>`).document.body : fallback;
    const seen = new Set([url]);
    for (const link of source?.querySelectorAll("a[href]") ?? []) {
      try {
        const target = normalizePublicPageUrl(new URL(link.getAttribute("href"), url).href).href;
        const label = clean(link.textContent).slice(0, 120);
        if (label && !seen.has(target)) { links.push({ url: target, label }); seen.add(target); }
        if (links.length === 24) break;
      } catch { /* Skip non-web and local links. */ }
    }
  }
  text = clean(text);
  if (text.length < 100) throw new HttpError(422, "There is not enough readable text on this page. It may require sign-in or JavaScript. Try an article URL.");
  return { url, title: title.slice(0, 240), byline, text: text.slice(0, PAGE_TEXT_LIMIT), truncated: text.length > PAGE_TEXT_LIMIT, links, retrievedAt: new Date().toISOString() };
}

export async function readPublicPage(input, { signal, lookupImpl = lookup, downloadImpl = download } = {}) {
  const timeout = AbortSignal.timeout(20_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let url = normalizePublicPageUrl(input);
  try {
    for (let redirects = 0; redirects <= 4; redirects += 1) {
      combined.throwIfAborted();
      const address = await abortable(resolvePublicPageAddress(url, lookupImpl), combined);
      combined.throwIfAborted();
      const result = await downloadImpl(url, address, combined);
      combined.throwIfAborted();
      if (result.location) { url = normalizePublicPageUrl(new URL(result.location, url).href); continue; }
      return extractPage(result.html, url.href, result.contentType);
    }
    throw new HttpError(422, "This page redirects too many times. Try its final article address.");
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (timeout.aborted) throw new HttpError(504, "The webpage took too long to respond. Try again or choose another page.");
    if (error instanceof HttpError) throw error;
    throw new HttpError(422, "The webpage could not be reached. Check the address or try another public page.");
  }
}
