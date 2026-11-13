import { HttpError } from "../../lib/errors.mjs";
import { fetchPublicPage, normalizePublicPageUrl, readPublicPage } from "../../urlMap/page.mjs";
import { readTweetThread, tweetLocation } from "./tweetThread.mjs";
import { readRoadmapSh, roadmapShLocation } from "./roadmapSh.mjs";

/** Longest page saved as one document; longer pages are cut with a note. */
export const IMPORT_DOCUMENT_CHARACTERS = 150_000;
/** Pages one import may save, across all its levels. */
export const IMPORT_MAX_PAGES = 80;
/** Linked pages followed from any one page. */
const CHILDREN_PER_PAGE = 60;
const CONCURRENCY = 4;
/** The first page's other links listed back to the agent, to pick relevant ones from. */
const OTHER_LINKS_RETURNED = 30;
const MARKDOWN_FILE = /\.(md|markdown|mdx|txt)$/iu;
const NOT_A_PAGE = /\.(png|jpe?g|gif|svg|webp|ico|bmp|avif|zip|gz|tgz|tar|7z|rar|exe|dmg|pkg|deb|mp3|wav|mp4|mov|webm|avi|woff2?|ttf|otf|css|js|mjs|json|xml|csv|ya?ml|toml|lock|ipynb|py|ts|tsx|jsx|java|c|h|cpp|go|rs|rb|php|sh)$/iu;
const GITHUB_RESERVED = new Set(["orgs", "settings", "topics", "features", "marketplace", "sponsors", "explore", "login", "about", "pricing", "collections", "search", "notifications", "apps"]);

/** An address without its trailing slashes or doubled slashes, for telling pages apart. */
export function pageKey(value) {
  const url = new URL(value);
  url.hash = "";
  url.pathname = url.pathname.replace(/\/{2,}/gu, "/").replace(/(.)\/+$/u, "$1");
  return url.href;
}

function decoded(segment) {
  try { return decodeURIComponent(segment); } catch { return segment; }
}

/** A github.com repository, folder or file address, with its path still percent-encoded. */
export function gitHubLocation(value) {
  const url = new URL(value);
  if (!/^(www\.)?github\.com$/iu.test(url.hostname)) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2 || GITHUB_RESERVED.has(segments[0].toLowerCase())) return null;
  const [owner, repo] = segments;
  if (segments.length === 2) return { owner, repo: repo.replace(/\.git$/u, ""), kind: "repo", branch: null, path: "" };
  if ((segments[2] === "tree" || segments[2] === "blob") && segments.length >= 4) {
    return { owner, repo, kind: segments[2], branch: segments[3], path: segments.slice(4).join("/") };
  }
  return null;
}

const gitHubPage = ({ owner, repo }, kind, branch, path) => `https://github.com/${owner}/${repo}/${kind}/${branch}/${path}`.replace(/\/+$/u, "");
const rawFile = ({ owner, repo }, branch, path) => `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;

/** Points a README's relative links at GitHub and its relative images at the raw files. */
function absoluteGitHubMarkdown(markdown, location, branch, directory) {
  const folder = directory ? `${directory}/` : "";
  const resolve = (target, image) => {
    if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/iu.test(target)) return target;
    const base = image ? rawFile(location, branch, folder) : `https://github.com/${location.owner}/${location.repo}/blob/${branch}/${folder}`;
    let url;
    try { url = new URL(target, base); } catch { return target; }
    if (image) return url.href;
    url.pathname = url.pathname.replace(/\/{2,}/gu, "/");
    const last = decoded(url.pathname.replace(/\/+$/u, "").split("/").at(-1) ?? "");
    // Folders open as trees; GitHub shows a folder link written with a trailing slash that way too.
    if (!/\.[a-z0-9]{1,8}$/iu.test(last)) url.pathname = url.pathname.replace(`/${location.owner}/${location.repo}/blob/`, `/${location.owner}/${location.repo}/tree/`);
    url.pathname = url.pathname.replace(/(.)\/+$/u, "$1");
    return url.href;
  };
  return markdown
    // Layout wrappers READMEs use around images would show as raw HTML in the editor.
    .replace(/<\/?(?:div|p|center|span|picture)\b[^>]*>/giu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .replace(/(!?)\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?((?:\s+"[^"]*")?)\s*\)/gu, (_match, bang, label, target, title) => `${bang}[${label}](${resolve(target, Boolean(bang))}${title})`)
    // HTML images become Markdown images, which the editor shows.
    .replace(/<img\b[^>]*?>/giu, (tag) => {
      const src = /\bsrc=["']([^"']+)["']/iu.exec(tag)?.[1];
      const alt = /\balt=["']([^"']*)["']/iu.exec(tag)?.[1] ?? "";
      return src ? `![${alt}](${resolve(src, true)})` : "";
    })
    .replace(/(<a\b[^>]*?\bhref=")([^"]+)(")/giu, (_match, before, target, after) => `${before}${resolve(target, false)}${after}`);
}

/** Links in Markdown text (not images), in reading order. */
export function markdownLinks(markdown) {
  const links = [];
  const pattern = /(!?)\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|<a\b[^>]*?\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/giu;
  for (const match of markdown.matchAll(pattern)) {
    if (match[1]) continue;
    const target = match[3] ?? match[4];
    const label = (match[2] ?? match[5] ?? "").replace(/<[^>]+>/gu, "").replace(/[*_`]/gu, "").replace(/\s+/gu, " ").trim();
    try { links.push({ url: normalizePublicPageUrl(target).href, label: label.slice(0, 160) }); } catch { /* Not a public web address. */ }
  }
  return links;
}

const firstHeading = (markdown) => markdown.match(/^\s{0,3}#{1,2}\s+(.+?)\s*#*\s*$/mu)?.[1]
  .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1").replace(/[*_`]/gu, "").trim() || null;

/** A GitHub folder or repository's README, or a Markdown file, read from the raw file rather than the page. */
async function readGitHub(location, fetchPage) {
  let branch = location.branch;
  let path = location.path;
  if (location.kind !== "blob") {
    const page = await fetchPage(location.kind === "repo" ? `https://github.com/${location.owner}/${location.repo}` : gitHubPage(location, "tree", branch, path));
    const folder = path ? `${path.replace(/\/+$/u, "")}/` : "";
    const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const readme = new RegExp(`href="/${escape(location.owner)}/${escape(location.repo)}/blob/([^/"]+)/(${escape(folder)}readme(?:\\.(?:md|markdown|mdx|txt))?)"`, "iu").exec(page.html ?? "");
    if (!readme) return null;
    [, branch, path] = readme;
  } else if (!MARKDOWN_FILE.test(path)) return null;
  const file = await fetchPage(rawFile(location, branch, path));
  const directory = path.split("/").slice(0, -1).join("/");
  const markdown = absoluteGitHubMarkdown(String(file.html ?? ""), location, branch, directory);
  const name = decoded(location.kind === "blob" ? path.split("/").at(-1) : location.path.split("/").filter(Boolean).at(-1) ?? location.repo);
  return {
    url: location.kind === "repo" ? `https://github.com/${location.owner}/${location.repo}` : gitHubPage(location, location.kind, branch, location.kind === "blob" ? path : location.path),
    title: firstHeading(markdown) ?? name,
    markdown,
    links: markdownLinks(markdown),
  };
}

/**
 * One page for import: its title, its main content as Markdown with links kept,
 * and the links in that content. GitHub repositories, folders and Markdown files
 * are read from their raw README or file, which the GitHub page itself only shows
 * with JavaScript. An X (Twitter) post is read with the rest of its author's
 * thread; if that fails, the post's own page gives at least its first post.
 * A roadmap.sh roadmap is read from the site's data as an outline.
 */
export async function readImportPage(url, { signal, userAgent, fetchPage, readPage = readPublicPage } = {}) {
  const fetchRaw = fetchPage ?? ((address, options) => fetchPublicPage(address, { signal, userAgent, ...options }));
  const tweet = tweetLocation(url);
  if (tweet) {
    try {
      return await readTweetThread(tweet, (address) => fetchRaw(address, { json: true }));
    } catch (error) {
      if (signal?.aborted) throw error;
    }
  }
  const roadmap = roadmapShLocation(url);
  if (roadmap) {
    const page = await readRoadmapSh(roadmap, (address) => fetchRaw(address, { json: true }), url);
    if (page) return page;
  }
  const location = gitHubLocation(url);
  if (location) {
    const page = await readGitHub(location, fetchRaw);
    if (page) return page;
  }
  const page = await readPage(url, { signal, userAgent, markdown: true, markdownLinks: true, images: true, pdf: true, textLimit: IMPORT_DOCUMENT_CHARACTERS + 1, linkLimit: 200 });
  return { url: page.url, title: page.title, markdown: page.text, links: page.links };
}

/** Linked pages that sit under this page: the same GitHub repository and folder, or the same site section. */
export function sectionLinks(page, root = page.url) {
  const base = new URL(pageKey(root));
  const location = gitHubLocation(base.href);
  // A page's section is the folder under it ("/book" holds "/book/ch1"); a file such as
  // "/book/index.html" stands for its folder. An article's other links are not its section.
  const prefix = location
    ? `/${location.owner}/${location.repo}/`
    : /\.[a-z0-9]{1,8}$/iu.test(base.pathname) ? base.pathname.replace(/[^/]*$/u, "") : `${base.pathname.replace(/\/+$/u, "")}/`;
  const folder = location?.path ? `${location.path.replace(/\/+$/u, "")}/` : "";
  const own = pageKey(page.url);
  const seen = new Set();
  const links = [];
  for (const link of page.links) {
    let url;
    try { url = new URL(pageKey(link.url)); } catch { continue; }
    const key = url.href;
    if (key === own || seen.has(key) || url.hostname !== base.hostname || NOT_A_PAGE.test(url.pathname)) continue;
    if (location) {
      const target = gitHubLocation(key);
      if (!target || `/${target.owner}/${target.repo}/` !== prefix || target.kind === "repo") continue;
      if (location.kind !== "repo" && !target.path.startsWith(folder)) continue;
      if (target.kind === "blob" && !MARKDOWN_FILE.test(target.path)) continue;
    } else if (!url.pathname.startsWith(prefix)) continue;
    seen.add(key);
    links.push({ url: key, label: link.label });
  }
  return links;
}

async function inBatches(items, run, signal) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      signal?.throwIfAborted();
      const index = next++;
      try { results[index] = { ok: true, value: await run(items[index]) }; } catch (error) {
        if (signal?.aborted) throw error;
        results[index] = { ok: false, error };
      }
    }
  }));
  return results;
}

function documentMarkdown(page) {
  const body = page.markdown.trim();
  const shortened = body.length > IMPORT_DOCUMENT_CHARACTERS;
  return {
    markdown: `Source: <${page.url}>\n\n${shortened ? `${body.slice(0, IMPORT_DOCUMENT_CHARACTERS).trimEnd()}\n\n*Shortened: the page continues at the source.*` : body}`,
    shortened,
  };
}

/**
 * The pages to save under one page: its section links, then what it points at
 * that belongs with it (`page.related`, such as the posts an X thread quotes),
 * then for the first page any of its links the agent picked (`chosen`).
 */
function childLinks(page, root, chosen = []) {
  const section = sectionLinks(page, root).slice(0, CHILDREN_PER_PAGE);
  const keys = new Set(section.map((link) => link.url));
  const extra = [];
  for (const link of [...(page.related ?? []).map((item) => ({ ...item, named: true })), ...chosen]) {
    let key;
    try { key = pageKey(link.url); } catch { continue; }
    if (keys.has(key) || key === pageKey(page.url)) continue;
    keys.add(key);
    extra.push({ ...link, url: key });
  }
  return [...section, ...extra.slice(0, CHILDREN_PER_PAGE)];
}

/** The first page's links that are not saved under it, for the agent to pick from. */
function otherLinks(page, saved) {
  const out = [];
  const seen = new Set(saved);
  for (const link of page.links ?? []) {
    let key;
    try { key = pageKey(link.url); } catch { continue; }
    if (seen.has(key) || NOT_A_PAGE.test(new URL(key).pathname)) continue;
    seen.add(key);
    out.push({ url: key, label: link.label });
    if (out.length === OTHER_LINKS_RETURNED) break;
  }
  return out;
}

/**
 * Import a page and the pages under it, `levels` deep: level 1 is the pages the
 * first page links to in its own section, plus what it points at that belongs
 * with it (an X thread's quoted posts and shared links) and any of its links in
 * `links` (addresses the agent picked as relevant); level 2 the same for those
 * pages, and so on. Pages already seen are not imported twice. Returns the
 * documents, parents first, how many more pages the next level down would add,
 * and the first page's other links.
 */
export async function importWebSection(url, { levels = 1, links = [], signal, userAgent, readImport = readImportPage, maxPages = IMPORT_MAX_PAGES } = {}) {
  const read = (address) => readImport(address, { signal, userAgent });
  const rootPage = await read(url);
  const seen = new Set([pageKey(url), pageKey(rootPage.url)]);
  const root = { ...rootPage, url: pageKey(rootPage.url) };
  const rootDocument = documentMarkdown(root);
  const documents = [{ url: root.url, parentUrl: null, level: 0, title: root.title, ...rootDocument }];
  const failed = [];
  // Only links on the first page can be picked; anything else is reported, not read.
  const onPage = new Set((root.links ?? []).flatMap((link) => { try { return [pageKey(link.url)]; } catch { return []; } }));
  const chosen = [];
  for (const address of links) {
    let key;
    try { key = pageKey(normalizePublicPageUrl(address).href); } catch { failed.push({ url: String(address), error: "That is not a public web address." }); continue; }
    if (onPage.has(key)) chosen.push({ url: key, label: "", named: true });
    else failed.push({ url: key, error: "That address is not a link on the saved page." });
  }
  let skipped = 0;
  let frontier = [root];
  for (let level = 1; level <= Math.max(levels, chosen.length ? 1 : 0) && frontier.length; level += 1) {
    const candidates = [];
    for (const page of frontier) {
      // With levels 0, only the links the agent picked are saved under the page.
      const picks = page === root ? chosen : [];
      for (const link of level > levels ? picks : childLinks(page, root.url, picks)) {
        if (seen.has(link.url)) continue;
        seen.add(link.url);
        candidates.push({ ...link, parentUrl: page.url });
      }
    }
    const room = maxPages - documents.length;
    skipped += Math.max(0, candidates.length - room);
    const batch = candidates.slice(0, Math.max(0, room));
    const results = await inBatches(batch, (link) => read(link.url), signal);
    const next = [];
    results.forEach((result, index) => {
      const link = batch[index];
      if (!result.ok) {
        failed.push({ url: link.url, error: result.error instanceof HttpError ? result.error.message : "The page could not be read." });
        return;
      }
      const page = { ...result.value, url: link.url };
      // A section link's text names its page (a chapter title); a quoted post's "@name" does not.
      const label = !link.named && link.label && link.label.length <= 120 ? link.label : null;
      documents.push({ url: page.url, parentUrl: link.parentUrl, level, title: label ?? page.title, ...documentMarkdown(page) });
      next.push(page);
    });
    frontier = next;
  }
  const deeper = new Set();
  let deeperFrom = 0;
  for (const page of frontier) {
    const pending = childLinks(page, root.url).filter((link) => !seen.has(link.url));
    if (pending.length) deeperFrom += 1;
    for (const link of pending) deeper.add(link.url);
  }
  return { documents, failed, skipped, deeper: { pages: deeper.size, fromDocuments: deeperFrom }, otherLinks: otherLinks(root, seen) };
}
