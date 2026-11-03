/**
 * X (Twitter) Articles, as FxTwitter's API returns them on the post that carries
 * one: a Draft.js document (`content.blocks` and `content.entityMap`) plus the
 * images it uses (`media_entities`). This turns one into Markdown, images kept
 * as Markdown images so an import can save them into the vault.
 */

const HEADINGS = { "header-one": "##", "header-two": "###", "header-three": "####", "header-four": "####", "header-five": "####", "header-six": "####" };
const STYLES = { Bold: "**", BOLD: "**", Italic: "*", ITALIC: "*", Strikethrough: "~~", STRIKETHROUGH: "~~", Code: "`", CODE: "`" };

const oneLine = (text) => String(text ?? "").replace(/\s+/gu, " ").trim();
const altText = (text) => oneLine(text).replace(/[[\]]/gu, " ").replace(/\s+/gu, " ").trim();
/** Markdown that would otherwise read as formatting in plain article text. */
const escapeText = (text) => text.replace(/([\\`*_[\]])/gu, "\\$1");

/** The entity map as `key → entity`, whether the API sent an object or a list of `{ key, value }`. */
function entities(content) {
  const map = new Map();
  const raw = content?.entityMap;
  if (Array.isArray(raw)) for (const entry of raw) { if (entry && entry.value) map.set(String(entry.key), entry.value); }
  else if (raw && typeof raw === "object") for (const [key, value] of Object.entries(raw)) map.set(String(key), value);
  return map;
}

function mediaUrls(article) {
  const urls = new Map();
  for (const item of article?.media_entities ?? []) {
    const url = item?.media_info?.original_img_url ?? item?.media_info?.preview_image?.original_img_url;
    if (item?.media_id && url) urls.set(String(item.media_id), url);
  }
  return urls;
}

/** A block's text with bold, italic and links as Markdown. */
function inlineMarkdown(block, entityMap) {
  const text = String(block.text ?? "");
  if (!text) return "";
  const cuts = new Set([0, text.length]);
  const styles = (block.inlineStyleRanges ?? []).filter((range) => STYLES[range.style]);
  const links = (block.entityRanges ?? []).filter((range) => entityMap.get(String(range.key))?.type === "LINK");
  for (const range of [...styles, ...links]) {
    cuts.add(Math.max(0, Math.min(text.length, range.offset)));
    cuts.add(Math.max(0, Math.min(text.length, range.offset + range.length)));
  }
  const points = [...cuts].sort((a, b) => a - b);
  const runs = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index];
    const to = points[index + 1];
    const covers = (range) => range.offset <= from && range.offset + range.length >= to;
    const marks = [...new Set(styles.filter(covers).map((range) => STYLES[range.style]))];
    const link = links.find(covers);
    runs.push({ text: text.slice(from, to), marks, href: link ? entityMap.get(String(link.key))?.data?.url : null });
  }
  // Neighbouring runs under the same link become one link, styled inside.
  let out = "";
  for (let index = 0; index < runs.length;) {
    const href = runs[index].href;
    let end = index + 1;
    if (href) while (end < runs.length && runs[end].href === href) end += 1;
    const inner = runs.slice(index, end).map((run) => styled(run.text, run.marks)).join("");
    out += href && /^https?:\/\//iu.test(href) && inner.trim() ? `[${inner}](${href})` : inner;
    index = end;
  }
  return out;
}

/** Wraps text in Markdown marks, keeping its outer spaces outside them so the marks still apply. */
function styled(text, marks) {
  const escaped = marks.includes("`") ? text : escapeText(text);
  if (!marks.length || !escaped.trim()) return escaped;
  const lead = /^\s*/u.exec(escaped)[0];
  const trail = /\s*$/u.exec(escaped)[0];
  const core = escaped.slice(lead.length, escaped.length - trail.length);
  const open = marks.join("");
  const close = [...marks].reverse().join("");
  return `${lead}${open}${core}${close}${trail}`;
}

/** An atomic block: an image with its caption, a table or other Markdown, a divider, or an embedded post. */
function atomicMarkdown(block, entityMap, images) {
  const parts = [];
  for (const range of block.entityRanges ?? []) {
    const entity = entityMap.get(String(range.key));
    if (!entity) continue;
    const data = entity.data ?? {};
    if (entity.type === "MEDIA" || entity.type === "IMAGE") {
      const caption = oneLine(data.caption);
      for (const item of data.mediaItems ?? []) {
        const url = images.get(String(item?.mediaId ?? ""));
        if (url) parts.push(`![${altText(caption)}](${url})`);
      }
      if (data.url && !(data.mediaItems ?? []).length) parts.push(`![${altText(caption)}](${data.url})`);
      if (caption && parts.length) parts.push(`*${escapeText(caption)}*`);
    } else if (entity.type === "MARKDOWN" && data.markdown) {
      parts.push(String(data.markdown).trim());
    } else if (entity.type === "DIVIDER") {
      parts.push("---");
    } else if (entity.type === "TWEET" && /^\d{1,25}$/u.test(String(data.tweetId ?? ""))) {
      parts.push(`[Embedded post](https://x.com/i/status/${data.tweetId})`);
    } else if (entity.type === "LINK" && data.url) {
      parts.push(`[${data.url}](${data.url})`);
    }
  }
  return parts;
}

/**
 * An X Article as Markdown: its title, cover image, headings, paragraphs, lists,
 * quotes, code, tables and images with their captions. Null when the post's
 * article came without its content.
 */
export function articleMarkdown(article) {
  const blocks = article?.content?.blocks;
  if (!Array.isArray(blocks) || !blocks.length) return null;
  const entityMap = entities(article.content);
  const images = mediaUrls(article);
  const out = [];
  const title = oneLine(article.title);
  if (title) out.push(`## ${escapeText(title)}`);
  const cover = article.cover_media?.media_info?.original_img_url;
  if (cover) out.push(`![${altText(title)}](${cover})`);
  // Consecutive list items and code lines stay one Markdown block.
  let group = null;
  const flush = () => { if (group) out.push(group.lines.join("\n")); group = null; };
  for (const block of blocks) {
    const type = String(block?.type ?? "unstyled");
    const depth = Math.max(0, Math.min(4, Number(block?.depth) || 0));
    if (type === "unordered-list-item" || type === "ordered-list-item") {
      const kind = type === "ordered-list-item" ? "ol" : "ul";
      if (!group || group.kind !== "list") { flush(); group = { kind: "list", lines: [], numbers: [] }; }
      group.numbers.length = depth + 1;
      if (kind === "ol") group.numbers[depth] = (group.numbers[depth] ?? 0) + 1;
      else group.numbers[depth] = 0;
      const marker = kind === "ol" ? `${group.numbers[depth]}.` : "-";
      group.lines.push(`${"  ".repeat(depth)}${marker} ${inlineMarkdown(block, entityMap).trim()}`);
      continue;
    }
    if (type === "code-block") {
      if (!group || group.kind !== "code") { flush(); group = { kind: "code", lines: ["```"] }; }
      group.lines.push(String(block.text ?? ""));
      continue;
    }
    if (group?.kind === "code") group.lines.push("```");
    flush();
    if (type === "atomic") { out.push(...atomicMarkdown(block, entityMap, images)); continue; }
    const text = inlineMarkdown(block, entityMap).trim();
    if (!text) continue;
    if (HEADINGS[type]) out.push(`${HEADINGS[type]} ${text}`);
    else if (type === "blockquote") out.push(text.split("\n").map((line) => `> ${line}`.trimEnd()).join("\n"));
    else out.push(text);
  }
  if (group?.kind === "code") group.lines.push("```");
  flush();
  return out.join("\n\n");
}

/** The web links in an X Article's text, in reading order, each once. */
export function articleLinks(article) {
  const entityMap = entities(article?.content);
  const links = [];
  const seen = new Set();
  for (const block of article?.content?.blocks ?? []) {
    for (const range of block?.entityRanges ?? []) {
      const entity = entityMap.get(String(range.key));
      const url = entity?.type === "LINK" ? String(entity.data?.url ?? "") : "";
      if (!/^https?:\/\//iu.test(url) || seen.has(url)) continue;
      seen.add(url);
      links.push({ url, label: oneLine(String(block.text ?? "").slice(range.offset, range.offset + range.length)) });
    }
  }
  return links;
}
