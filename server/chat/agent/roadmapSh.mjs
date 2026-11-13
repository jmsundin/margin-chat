import { HttpError } from "../../lib/errors.mjs";

/**
 * roadmap.sh draws its roadmaps with JavaScript, so the page itself has no text to read.
 * Its site serves each roadmap's data as JSON, which is read here as a Markdown outline:
 * sections as headings, topics under them, in the order the roadmap lays them out.
 */
const HOSTS = /^(www\.)?roadmap\.sh$/iu;
const SLUG = /^[a-z0-9][a-z0-9-]{0,120}$/iu;
/** Site pages that are not roadmaps. */
const RESERVED = new Set(["ai", "api", "r", "u", "roadmaps", "guides", "videos", "questions", "projects", "best-practices", "teams", "login", "signup", "account", "about", "terms", "privacy", "get-started", "changelog", "pricing", "premium", "dashboard", "discord", "community", "leaderboard", "advertise", "manifest", "assets", "fonts"]);
const OUTLINE_TOPICS = 400;

/** A roadmap.sh roadmap address: one made with its AI generator, or one of the site's own. */
export function roadmapShLocation(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!HOSTS.test(url.hostname)) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length === 3 && segments[0] === "ai" && segments[1] === "roadmap" && SLUG.test(segments[2])) return { kind: "ai", slug: segments[2].toLowerCase() };
  if (segments.length === 1 && SLUG.test(segments[0]) && !RESERVED.has(segments[0].toLowerCase())) return { kind: "official", slug: segments[0].toLowerCase() };
  return null;
}

const oneLine = (value) => String(value ?? "").replace(/\s+/gu, " ").trim();

/**
 * An official roadmap's drawing as an outline. Topics run top to bottom as drawn; each
 * subtopic goes under the topic it is joined to, or the nearest topic when it is joined to none.
 */
export function officialRoadmapOutline(data) {
  const nodes = (Array.isArray(data?.nodes) ? data.nodes : []).filter((node) => node && oneLine(node.data?.label));
  const place = (node) => ({ x: Number(node.position?.x) || 0, y: Number(node.position?.y) || 0 });
  const topics = nodes.filter((node) => node.type === "topic").sort((a, b) => place(a).y - place(b).y || place(a).x - place(b).x);
  const subtopics = nodes.filter((node) => node.type === "subtopic");
  if (!topics.length) return "";
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const owner = new Map();
  const joined = new Map();
  for (const edge of Array.isArray(data?.edges) ? data.edges : []) {
    const pair = [byId.get(edge?.source), byId.get(edge?.target)];
    if (!pair[0] || !pair[1]) continue;
    for (const [from, to] of [pair, [pair[1], pair[0]]]) {
      if (from.type === "topic" && to.type === "subtopic" && !owner.has(to.id)) owner.set(to.id, from.id);
      if (from.type === "subtopic" && to.type === "subtopic") joined.set(from.id, [...(joined.get(from.id) ?? []), to.id]);
    }
  }
  // A subtopic joined only to another subtopic belongs to that one's topic.
  for (let changed = true; changed;) {
    changed = false;
    for (const [id, others] of joined) {
      if (owner.has(id)) continue;
      const found = others.find((other) => owner.has(other));
      if (found) { owner.set(id, owner.get(found)); changed = true; }
    }
  }
  const children = new Map(topics.map((topic) => [topic.id, []]));
  for (const subtopic of subtopics) {
    const at = place(subtopic);
    const nearest = () => topics.reduce((best, topic) => {
      const distance = Math.hypot(place(topic).x - at.x, place(topic).y - at.y);
      return distance < best.distance ? { id: topic.id, distance } : best;
    }, { id: topics[0].id, distance: Infinity }).id;
    children.get(owner.get(subtopic.id) ?? nearest())?.push(subtopic);
  }
  const lines = [];
  let count = 0;
  for (const topic of topics) {
    if (count >= OUTLINE_TOPICS) break;
    lines.push("", `## ${oneLine(topic.data.label)}`);
    count += 1;
    for (const subtopic of (children.get(topic.id) ?? []).sort((a, b) => place(a).y - place(b).y || place(a).x - place(b).x)) {
      if (count >= OUTLINE_TOPICS) break;
      lines.push(`- ${oneLine(subtopic.data.label)}`);
      count += 1;
    }
  }
  return lines.join("\n").trim();
}

/**
 * A roadmap.sh roadmap as a page: its title and its outline as Markdown.
 * `fetchJson(url)` returns the response body as text in `html`. Returns null when the
 * address turns out not to be a roadmap, so the caller reads it as an ordinary page.
 */
export async function readRoadmapSh(location, fetchJson, pageUrl) {
  const address = location.kind === "ai"
    ? `https://roadmap.sh/api/v1-get-ai-roadmap/${location.slug}`
    : `https://roadmap.sh/api/v1-official-roadmap/${location.slug}`;
  let data;
  try {
    const response = await fetchJson(address);
    data = JSON.parse(String(response.html ?? ""));
  } catch (error) {
    if (error instanceof HttpError && location.kind === "ai") throw new HttpError(422, "That roadmap could not be read. It may be private or deleted.");
    return null;
  }
  if (location.kind === "ai") {
    const outline = typeof data?.data === "string" ? data.data.trim() : "";
    if (!outline) throw new HttpError(422, "That roadmap could not be read. It may be private or deleted.");
    const title = oneLine(data.title) || "Roadmap";
    const about = oneLine(data.description);
    const body = outline.replace(/^#\s+.*\n+/u, "");
    return { url: pageUrl, title, markdown: `# ${title}\n\n${about ? `${about}\n\n` : ""}Source: ${pageUrl}\n\n${body}`, links: [] };
  }
  const outline = officialRoadmapOutline(data);
  if (!outline) return null;
  const title = oneLine(data?.title?.page ?? data?.title?.card ?? data?.title) || "Roadmap";
  const about = oneLine(data?.description).replace(/@currentYear@/gu, String(new Date().getFullYear()));
  return { url: pageUrl, title, markdown: `# ${title}\n\n${about ? `${about}\n\n` : ""}Source: ${pageUrl}\n\n${outline}`, links: [] };
}
