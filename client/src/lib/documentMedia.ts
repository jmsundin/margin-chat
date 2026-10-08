/**
 * Media embeds in documents use Obsidian's Markdown so files open the same way
 * there: `![[clip.mp4]]` for a vault file, `![alt](https://…)` for a link.
 * Timestamp list items directly under a video mark moments in it.
 */

export type MediaKind = "image" | "video" | "audio" | "youtube" | "vimeo";

export type MediaEmbed = {
  /** `vault` targets are resolved like Obsidian: by path, else by file name. */
  source: "vault" | "url";
  target: string;
  kind: MediaKind;
  alt: string;
  width?: number;
  height?: number;
  /** YouTube or Vimeo video id. */
  videoId?: string;
  startSeconds?: number;
};

export type MediaTimestamp = { seconds: number; label: string; note: string };

export type MediaBlock = { embed: MediaEmbed; timestamps: MediaTimestamp[] };

const IMAGE = /\.(?:png|jpe?g|gif|webp|avif|svg|bmp|ico)$/iu;
const VIDEO = /\.(?:mp4|m4v|webm|ogv|mov|mkv)$/iu;
const AUDIO = /\.(?:mp3|m4a|wav|ogg|oga|flac|aac|opus)$/iu;

export const MAX_VAULT_MEDIA_BYTES = 4 * 1024 * 1024;

export const MEDIA_CONTENT_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif",
  svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon",
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", ogv: "video/ogg", mov: "video/quicktime", mkv: "video/x-matroska",
  mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", flac: "audio/flac", aac: "audio/aac", opus: "audio/opus",
};

function extension(path: string) {
  return /\.([a-z0-9]+)$/iu.exec(path)?.[1]?.toLowerCase() ?? "";
}

export function mediaContentType(path: string): string {
  return MEDIA_CONTENT_TYPES[extension(path)] ?? "application/octet-stream";
}

export function mediaKindForPath(path: string): "image" | "video" | "audio" | null {
  if (IMAGE.test(path)) return "image";
  if (VIDEO.test(path)) return "video";
  if (AUDIO.test(path)) return "audio";
  return null;
}

export function isMediaFile(file: { name: string; type: string }) {
  return /^(?:image|video|audio)\//u.test(file.type) || mediaKindForPath(file.name) !== null;
}

/** `83`, `1:23`, `1:02:03`, `83s`, `1m23s` and `1h2m3s` all read as seconds. */
export function parseTimestamp(value: string): number | null {
  const text = value.trim();
  if (/^\d+(?:\.\d+)?$/u.test(text)) return Number(text);
  const clock = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.\d+)?$/u.exec(text);
  if (clock) {
    const [hours, minutes, seconds] = [Number(clock[1] ?? 0), Number(clock[2]), Number(clock[3])];
    return seconds < 60 && (!clock[1] || minutes < 60) ? hours * 3600 + minutes * 60 + seconds : null;
  }
  const units = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/u.exec(text);
  if (units && (units[1] || units[2] || units[3])) return Number(units[1] ?? 0) * 3600 + Number(units[2] ?? 0) * 60 + Number(units[3] ?? 0);
  return null;
}

export function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

function parseUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/** The time a link points at: a media fragment `#t=83` or YouTube's `t=1m23s`/`start=83`. */
export function linkSeconds(href: string): number | null {
  const fragment = /#(?:.*&)?t=([^&,]+)/u.exec(href);
  if (fragment) return parseTimestamp(decodeURIComponent(fragment[1]));
  const url = parseUrl(href);
  const query = url?.searchParams.get("t") ?? url?.searchParams.get("start");
  return query ? parseTimestamp(query) : null;
}

function youtubeId(url: URL): string | null {
  const host = url.hostname.replace(/^(?:www\.|m\.|music\.)/u, "");
  let id: string | null = null;
  if (host === "youtu.be") id = url.pathname.slice(1).split("/")[0];
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (url.pathname === "/watch") id = url.searchParams.get("v");
    else id = /^\/(?:embed|shorts|live|v)\/([^/?#]+)/u.exec(url.pathname)?.[1] ?? null;
  }
  return id && /^[\w-]{6,20}$/u.test(id) ? id : null;
}

function vimeoId(url: URL): string | null {
  const host = url.hostname.replace(/^www\./u, "");
  if (host !== "vimeo.com" && host !== "player.vimeo.com") return null;
  return /^\/(?:video\/)?(\d{5,})/u.exec(url.pathname)?.[1] ?? null;
}

/** Obsidian sizes embeds with `|300` or `|300x200` in place of alt text. */
function readSize(label: string) {
  const size = /^(\d{1,5})(?:x(\d{1,5}))?$/u.exec(label.trim());
  return size ? { width: Number(size[1]), ...(size[2] ? { height: Number(size[2]) } : {}) } : null;
}

/** Read a line that is exactly one embed, as Obsidian would render it. */
export function parseMediaEmbed(line: string): MediaEmbed | null {
  const text = line.trim();
  const wiki = /^!\[\[([^\]|\n]+?)(?:\|([^\]\n]*))?\]\]$/u.exec(text);
  if (wiki) {
    const [path, fragment = ""] = wiki[1].trim().split("#", 2);
    const kind = mediaKindForPath(path);
    if (!kind) return null;
    const size = wiki[2] === undefined ? null : readSize(wiki[2]);
    const start = /^t=/u.test(fragment) ? parseTimestamp(fragment.slice(2).split(",")[0]) : null;
    return { source: "vault", target: path, kind, alt: size ? "" : (wiki[2] ?? "").trim(), ...size, ...(start !== null ? { startSeconds: start } : {}) };
  }
  const markdown = /^!\[([^\]\n]*)\]\(\s*<?([^\s<>()]+(?:\([^\s()]*\))?[^\s<>()]*)>?(?:\s+"[^"\n]*")?\s*\)$/u.exec(text);
  if (!markdown) return null;
  const href = markdown[2];
  const size = readSize(markdown[1].split("|").at(-1) ?? "");
  const alt = size ? markdown[1].split("|").slice(0, -1).join("|").trim() : markdown[1].trim();
  const start = linkSeconds(href);
  const url = parseUrl(href);
  if (!url) {
    // A relative `![](Attachments/clip.mp4)` names a vault file too.
    if (/^[a-z][a-z0-9+.-]*:/iu.test(href) || href.startsWith("//")) return null;
    const path = decodeURIComponent(href.split("#")[0]);
    const kind = mediaKindForPath(path);
    return kind ? { source: "vault", target: path, kind, alt, ...size, ...(start !== null ? { startSeconds: start } : {}) } : null;
  }
  const youtube = youtubeId(url);
  if (youtube) return { source: "url", target: href, kind: "youtube", alt, videoId: youtube, ...size, ...(start !== null ? { startSeconds: start } : {}) };
  const vimeo = vimeoId(url);
  if (vimeo) return { source: "url", target: href, kind: "vimeo", alt, videoId: vimeo, ...size, ...(start !== null ? { startSeconds: start } : {}) };
  // Markdown image syntax means an image unless the file says otherwise.
  const kind = mediaKindForPath(url.pathname) ?? "image";
  return { source: "url", target: href, kind, alt, ...size, ...(start !== null ? { startSeconds: start } : {}) };
}

const TIMESTAMP_LINE = /^\s*[-*+]\s+(?:\[\[([^\]|\n]*#t=[^\]|\n]+)(?:\|([^\]\n]*))?\]\]|\[([^\]\n]+)\]\(([^)\s]+)\)|(\d+(?::\d{2}){1,2}))(?:\s+(?:[-–—:]\s+)?(.*))?$/u;

/** A list item that starts with a time: a timestamp link or a plain `1:23`. */
export function parseTimestampLine(line: string): MediaTimestamp | null {
  const match = TIMESTAMP_LINE.exec(line);
  if (!match) return null;
  const note = (match[6] ?? "").trim();
  if (match[1] !== undefined) {
    const seconds = linkSeconds(`#${match[1].split("#").slice(1).join("#")}`);
    return seconds === null ? null : { seconds, label: (match[2] ?? "").trim() || formatTimestamp(seconds), note };
  }
  if (match[3] !== undefined) {
    const seconds = linkSeconds(match[4]) ?? parseTimestamp(match[3]);
    return seconds === null ? null : { seconds, label: match[3].trim(), note };
  }
  const seconds = parseTimestamp(match[5]);
  return seconds === null ? null : { seconds, label: match[5], note };
}

export function isPlayable(kind: MediaKind) {
  return kind !== "image";
}

/**
 * A block is shown as media when its first line is one embed and every other
 * line is blank or, for playable media, a timestamp. Anything else stays text.
 */
export function parseMediaBlock(markdown: string): MediaBlock | null {
  const lines = markdown.replace(/\r\n?/gu, "\n").trim().split("\n");
  const embed = parseMediaEmbed(lines[0] ?? "");
  if (!embed) return null;
  const timestamps: MediaTimestamp[] = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const timestamp = isPlayable(embed.kind) ? parseTimestampLine(line) : null;
    if (!timestamp) return null;
    timestamps.push(timestamp);
  }
  return { embed, timestamps };
}

/** A link to `seconds` in this media that Obsidian (with Media Extended) and browsers both follow. */
export function timestampHref(embed: MediaEmbed, seconds: number): string {
  const whole = Math.floor(seconds);
  if (embed.kind === "youtube" && embed.videoId) return `https://www.youtube.com/watch?v=${embed.videoId}&t=${whole}s`;
  if (embed.kind === "vimeo" && embed.videoId) return `https://vimeo.com/${embed.videoId}#t=${whole}s`;
  return `${embed.target.split("#")[0]}#t=${whole}`;
}

export function timestampMarkdown(embed: MediaEmbed, seconds: number, note: string): string {
  const label = formatTimestamp(seconds);
  const text = note.replace(/\s+/gu, " ").trim();
  const link = embed.source === "vault"
    ? `[[${embed.target.split("#")[0]}#t=${Math.floor(seconds)}|${label}]]`
    : `[${label}](${timestampHref(embed, seconds)})`;
  return `- ${link}${text ? ` ${text}` : ""}`;
}

/** Insert a timestamp line in time order, leaving every other line as written. */
export function addTimestamp(markdown: string, seconds: number, note: string): string {
  const block = parseMediaBlock(markdown);
  if (!block) return markdown;
  const line = timestampMarkdown(block.embed, seconds, note);
  const source = markdown.replace(/\s+$/u, "");
  const lines = source.split("\n");
  let index = lines.length;
  for (let position = 1; position < lines.length; position += 1) {
    const existing = parseTimestampLine(lines[position]);
    if (existing && existing.seconds > seconds) { index = position; break; }
  }
  lines.splice(index, 0, line);
  return `${lines.join("\n")}${markdown.slice(source.length)}`;
}

export function embedMarkdownForUrl(href: string): string | null {
  const url = parseUrl(href.trim());
  if (!url) return null;
  const markdown = `![](${url.href})`;
  return parseMediaEmbed(markdown) ? markdown : null;
}

/** Obsidian finds `![[name]]` anywhere in the vault: exact path first, then that name in Attachments/, then the shortest path. */
export function resolveVaultMediaPath(target: string, paths: Iterable<string>): string | null {
  const wanted = target.replace(/^\/+/u, "").normalize("NFC");
  const all = [...paths];
  if (all.includes(wanted)) return wanted;
  const lower = wanted.toLowerCase();
  const exact = all.find((path) => path.toLowerCase() === lower);
  if (exact) return exact;
  const suffix = `/${lower}`;
  const attached = (path: string) => /^attachments\//iu.test(path) ? 0 : 1;
  return all.filter((path) => path.toLowerCase().endsWith(suffix))
    .sort((a, b) => attached(a) - attached(b) || a.length - b.length || a.localeCompare(b))[0] ?? null;
}

function safeName(name: string) {
  return name.normalize("NFC").replace(/[\\/\u0000-\u001f\u007f#^[\]|:*?"<>%]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 150);
}

/** Pasted images get Obsidian's `Pasted image 20261008204953.png` name; files keep theirs. */
export function attachmentPath(file: { name: string; type: string }, existing: Iterable<string>, now = new Date()): string {
  const fromType = Object.entries(MEDIA_CONTENT_TYPES).find(([, type]) => type === file.type)?.[0];
  const ext = extension(file.name) || fromType || "bin";
  let base = safeName(file.name.replace(/\.[^.]+$/u, ""));
  if (!base || /^image$/iu.test(base)) {
    const pad = (value: number) => String(value).padStart(2, "0");
    base = `Pasted image ${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  }
  const taken = new Set([...existing].map((path) => path.toLowerCase()));
  for (let copy = 0; ; copy += 1) {
    const path = `Attachments/${base}${copy ? ` ${copy}` : ""}.${ext}`;
    if (!taken.has(path.toLowerCase())) return path;
  }
}

/** The shortest embed that still finds `path`: its name when no other file shares it. */
export function vaultEmbedMarkdown(path: string, paths: Iterable<string>): string {
  const name = path.split("/").at(-1)!;
  const shared = [...paths].filter((candidate) => candidate !== path && candidate.split("/").at(-1)!.toLowerCase() === name.toLowerCase());
  return `![[${shared.length ? path : name}]]`;
}
