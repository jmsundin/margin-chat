import { HttpError } from "../../lib/errors.mjs";
import { normalizePublicPageUrl } from "../../urlMap/page.mjs";
import { articleLinks, articleMarkdown } from "./xArticle.mjs";

/** Hosts that show X (Twitter) posts, including the common embed-fixing mirrors. */
const TWEET_HOSTS = /^(?:www\.|mobile\.)?(?:x|twitter|fxtwitter|fixupx|vxtwitter|fixvx)\.com$/iu;
/**
 * X's own pages need JavaScript and a sign-in to show replies, so threads are read
 * from FxTwitter's public API, which returns the author's whole self-reply chain for
 * any post in it.
 */
const THREAD_API = "https://api.fxtwitter.com/2/thread/";
/** Posts saved from one thread; longer threads are cut with a note. */
export const THREAD_MAX_POSTS = 200;
/** Quoted posts and shared links one thread saves as their own documents. */
export const THREAD_MAX_RELATED = 12;
const ARTICLE_LINK = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/i\/article\/\d+/iu;

/** An X (Twitter) post address: its author's handle (null for /i/ addresses) and post id. */
export function tweetLocation(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!TWEET_HOSTS.test(url.hostname)) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  const status = segments.findIndex((segment) => segment === "status" || segment === "statuses");
  const id = status > 0 ? segments[status + 1] : null;
  if (!id || !/^\d{1,25}$/u.test(id)) return null;
  const handle = segments[0] === "i" ? null : segments[0];
  if (handle && !/^\w{1,30}$/u.test(handle)) return null;
  return { handle, id };
}

const postUrl = (handle, id) => `https://x.com/${handle ?? "i"}/status/${id}`;

/**
 * A post's text with t.co links swapped for Markdown links to their real addresses.
 * Media links are left out (media is listed below the text), and so is the link to
 * the post's own X Article, whose text is written out below.
 */
function postText(post) {
  let text = String(post.raw_text?.text ?? post.text ?? "");
  for (const facet of post.raw_text?.facets ?? []) {
    if (!facet.original || !text.includes(facet.original)) continue;
    if (facet.type === "media") text = text.replace(facet.original, "");
    else if (facet.type === "url" && facet.replacement) {
      const article = post.article && ARTICLE_LINK.test(facet.replacement);
      const label = String(facet.display ?? "").replace(/[[\]\n]/gu, "").trim() || facet.replacement;
      text = text.replace(facet.original, article ? "" : `[${label}](${facet.replacement})`);
    }
  }
  return text.replace(/[ \t]+$/gmu, "").trim();
}

/** Text without its Markdown links' addresses, for titles. */
const plainText = (text) => text.replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1");

const quoted = (text) => text.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n");

function postDate(post) {
  const time = post.created_timestamp ? post.created_timestamp * 1000 : Date.parse(post.created_at ?? "");
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : null;
}

function mediaMarkdown(post) {
  const lines = [];
  for (const item of post.media?.all ?? []) {
    if (!item?.url) continue;
    if (item.type === "photo") lines.push(`![${String(item.altText ?? item.alt_text ?? "").replace(/[\[\]\n]/gu, " ").trim()}](${item.url})`);
    else lines.push(`[${item.type === "gif" ? "GIF" : "Video"}](${item.url})`);
  }
  return lines;
}

function postMarkdown(post, number, total) {
  const parts = [];
  const text = postText(post);
  if (text) parts.push(text);
  parts.push(...mediaMarkdown(post));
  if (post.quote?.url) {
    const author = post.quote.author?.screen_name ? `@${post.quote.author.screen_name}` : "a post";
    const quoteText = postText(post.quote);
    const article = post.quote.article?.title ? `Article: **${String(post.quote.article.title).replace(/[*\n]/gu, " ").trim()}**` : "";
    const body = [quoteText, article].filter(Boolean).join("\n\n");
    parts.push(quoted(`Quoting [${author}](${post.quote.url})${body ? `:\n\n${body}` : ""}`));
  }
  if (post.article?.title) parts.push(articleMarkdown(post.article) ?? `Article: [${post.article.title}](${post.url ?? postUrl(post.author?.screen_name, post.id)})`);
  const date = postDate(post);
  const label = total > 1 ? `${number}/${total}` : "Post";
  parts.push(`*[${label}](${post.url ?? postUrl(post.author?.screen_name, post.id)})${date ? ` · ${date}` : ""}*`);
  return parts.join("\n\n");
}

/**
 * What a thread points at that belongs with it: the posts it quotes and the links
 * its author shared, each to be saved as its own document under the thread.
 * Links to the thread's own posts, their media and X Articles shown inline are left out.
 */
function relatedLinks(posts) {
  const own = new Set(posts.map((post) => String(post.id)));
  const seen = new Set();
  const links = [];
  const add = (url, label) => {
    if (links.length >= THREAD_MAX_RELATED) return;
    let href;
    try { href = normalizePublicPageUrl(url).href; } catch { return; }
    const tweet = tweetLocation(href);
    if (tweet && own.has(tweet.id)) return;
    const key = tweet ? `tweet:${tweet.id}` : href;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ url: tweet ? postUrl(tweet.handle, tweet.id) : href, label: String(label ?? "").slice(0, 160) });
  };
  for (const post of posts) {
    for (const facet of post.raw_text?.facets ?? []) {
      if (facet.type !== "url" || !facet.replacement || ARTICLE_LINK.test(facet.replacement)) continue;
      add(facet.replacement, facet.display ?? facet.replacement);
    }
    if (post.quote?.url) add(post.quote.url, post.quote.author?.screen_name ? `@${post.quote.author.screen_name}` : "Quoted post");
    for (const link of articleLinks(post.article)) add(link.url, link.label);
  }
  return links;
}

function firstLine(text) {
  const line = text.split("\n").map((part) => part.trim()).find(Boolean) ?? "";
  return line.length > 90 ? `${line.slice(0, 87).trimEnd()}…` : line;
}

/**
 * An X (Twitter) post and the rest of its author's thread, oldest first, as one
 * Markdown page, with any X Article a post carries written out in full.
 * `fetchJson(url)` returns the API's response body as text. The posts it quotes
 * and the links its author shared come back as `related`, which an import saves
 * as child documents of the thread.
 */
export async function readTweetThread(location, fetchJson) {
  const response = await fetchJson(`${THREAD_API}${location.id}`);
  let data;
  try { data = JSON.parse(String(response.html ?? "")); } catch { throw new HttpError(422, "The post could not be read."); }
  const root = data?.status;
  if (!root || data.code !== 200) throw new HttpError(422, "The post could not be read. It may be deleted, private or age-restricted.");
  const thread = Array.isArray(data.thread) && data.thread.length ? data.thread : [root];
  const posts = thread.slice(0, THREAD_MAX_POSTS);
  const author = root.author ?? posts[0]?.author ?? {};
  const handle = author.screen_name ?? location.handle;
  const name = author.name || (handle ? `@${handle}` : "X post");
  const byline = handle ? `${name} (@${handle})` : name;
  const first = posts[0] ?? root;
  const heading = firstLine(plainText(postText(first)));
  // A post that only carries an X Article is named after the article.
  const articleTitle = !firstLine(plainText(postText(first))) && firstLine(String(first.article?.title ?? ""));
  const title = articleTitle || (heading ? `${byline}: ${heading}` : `Thread by ${byline}`);
  const intro = posts.length > 1 ? `Thread by **${byline}** on X, ${thread.length} posts.` : `Post by **${byline}** on X.`;
  const body = posts.map((post, index) => postMarkdown(post, index + 1, thread.length));
  const related = relatedLinks(posts);
  const more = thread.length > posts.length ? [`*The thread continues at the source: ${thread.length - posts.length} more posts.*`] : [];
  return {
    url: postUrl(handle, location.id),
    title,
    markdown: [intro, ...body, ...more].join("\n\n---\n\n"),
    links: related,
    related,
  };
}
