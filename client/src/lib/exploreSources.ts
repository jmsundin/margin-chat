import { writeSyncedSetting } from "./interfaceSettings";
import type { PublicTopic } from "./publicKnowledge";
import { packCircles } from "./exploreLibrary";
import { wikipediaArticleOutline, wikipediaCategoryMembers, wikipediaTitle, type WikipediaLinkCandidate } from "./wikipedia";

/**
 * Where Explore starts: the person's own notes, Wikipedia read like a library, or a topic that
 * AI splits into sub-topics. Every place you can go is a node that opens into the nodes inside it,
 * fetched the first time you open it.
 */
export type ExploreSource = { kind: "notes" } | { kind: "wikipedia" } | { kind: "ai"; topic: string };

const SOURCE_KEY = "margin-chat:explore-source";

export function readExploreSource(): ExploreSource {
  try { return parseExploreSource(window.localStorage.getItem(SOURCE_KEY)); }
  catch { return { kind: "notes" }; }
}
export function parseExploreSource(value: string | null | undefined): ExploreSource {
  if (value === "wikipedia") return { kind: "wikipedia" };
  if (value?.startsWith("ai:") && value.slice(3).trim()) return { kind: "ai", topic: value.slice(3).trim().slice(0, 200) };
  return { kind: "notes" };
}
export function serializeExploreSource(source: ExploreSource) {
  return source.kind === "ai" ? `ai:${source.topic}` : source.kind;
}
export function writeExploreSource(source: ExploreSource) {
  writeSyncedSetting(SOURCE_KEY, serializeExploreSource(source));
}
export const sameSource = (a: ExploreSource, b: ExploreSource) => serializeExploreSource(a) === serializeExploreSource(b);

export interface BrowseNode {
  id: string;
  label: string;
  /** One line on what it is: a short description or why it matters. */
  summary?: string;
  /**
   * root: the source itself. section: a Wikipedia category. shelf: the articles filed in a category
   * that also has sub-categories. article: a Wikipedia article. group: a part of an article (its
   * lead, a section, See also). topic: a topic AI named.
   */
  kind: "root" | "section" | "shelf" | "article" | "group" | "topic";
  /** How much it holds, for sizing rooms and circles. */
  weight: number;
  /** The Wikipedia article this node is, or stands for. */
  article?: string;
  /** The Wikipedia category a section opens. */
  category?: string;
  /** A topic AI named, with its Wikidata identity. */
  topic?: PublicTopic;
  /** What a reader sees before opening it, such as "320 articles · 34 sections". */
  hint?: string;
  /** What it opens into; undefined until it has been opened once. */
  children?: BrowseNode[];
}

/**
 * Wikipedia's main topic sections, the signs over the aisles. They are categories under
 * "Main topic classifications", in the order a reader scans them.
 */
export const WIKIPEDIA_SECTIONS: Array<{ category: string; label: string; summary: string }> = [
  { category: "Health", label: "Health", summary: "Medicine, fitness, nutrition and the diseases people live with." },
  { category: "Science", label: "Science", summary: "How the natural world works, from physics to biology." },
  { category: "Technology", label: "Technology", summary: "Tools, machines, computing and engineering." },
  { category: "Nature", label: "Nature", summary: "Animals, plants, the Earth and its climate." },
  { category: "Society", label: "Society", summary: "How people live together: politics, law, economics, education." },
  { category: "History", label: "History", summary: "Past events, eras and civilisations." },
  { category: "Culture", label: "Culture", summary: "Customs, food, media and the arts people share." },
  { category: "Arts", label: "Arts", summary: "Music, literature, film and visual art." },
  { category: "Sports", label: "Sports", summary: "Games, athletes, leagues and competitions." },
  { category: "People", label: "People", summary: "Biographies and groups of people." },
  { category: "Geography", label: "Geography", summary: "Places, countries and the physical world." },
  { category: "Philosophy", label: "Philosophy", summary: "Thinking about knowledge, ethics and mind." },
  { category: "Mathematics", label: "Mathematics", summary: "Numbers, structures, shapes and proof." },
  { category: "Religion", label: "Religion", summary: "Beliefs, faiths and their practice." },
  { category: "Economy", label: "Economy", summary: "Money, trade, work and business." },
  { category: "Education", label: "Education", summary: "Teaching, learning and schools." },
];

export function sourceRoot(source: Exclude<ExploreSource, { kind: "notes" }>): BrowseNode {
  if (source.kind === "wikipedia") return { id: "wikipedia", label: "Wikipedia", kind: "root", weight: 1,
    summary: "Wikipedia's main topic sections. Open one to walk into the categories and articles filed under it." };
  return { id: `ai:${source.topic}`, label: source.topic, kind: "root", weight: 1, summary: "Sub-topics named by AI. Each one opens into its own sub-topics." };
}

/* ---------- Opening nodes ---------- */

const MAX_SECTIONS = 30, MAX_SHELF = 60, MAX_GROUP = 14, MAX_GROUPS = 12;
const articleId = (title: string, parent: string) => `${parent}/a:${title}`;

/** What a Wikipedia node opens into. Articles and groups already hold their children. */
export async function openWikipediaNode(node: BrowseNode, signal?: AbortSignal): Promise<BrowseNode[]> {
  // The main sections hold few articles of their own, so they are drawn the same size and need no request.
  if (node.kind === "root") return WIKIPEDIA_SECTIONS.map((section) => ({ id: `c:${section.category}`, label: section.label, summary: section.summary, kind: "section",
    category: section.category, weight: 6 }));
  if (node.kind === "section" && node.category) return categoryChildren(node, await wikipediaCategoryMembers(node.category, signal));
  if (node.kind === "article" && node.article) return articleChildren(node, await wikipediaArticleOutline(node.article, signal));
  if (node.kind === "topic" && node.article) return articleChildren(node, await wikipediaArticleOutline(node.article, signal));
  return node.children ?? [];
}

const categoryWeight = (size: number) => 3 + Math.sqrt(Math.max(0, size));
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
export const categoryHint = (pages: number, subcats: number) => [pages ? plural(pages, "article") : "", subcats ? plural(subcats, "section") : ""].filter(Boolean).join(" · ");

export function categoryChildren(node: BrowseNode, members: Awaited<ReturnType<typeof wikipediaCategoryMembers>>): BrowseNode[] {
  const sections = members.filter((member) => member.kind === "category")
    .sort((a, b) => (b.size ?? 0) - (a.size ?? 0)).slice(0, MAX_SECTIONS)
    .map((member): BrowseNode => ({ id: `c:${member.title}`, label: member.title, kind: "section", category: member.title, weight: categoryWeight(member.size ?? 0),
      ...(member.pages || member.subcats ? { hint: categoryHint(member.pages ?? 0, member.subcats ?? 0) } : {}) }));
  // The category's own main article usually shares its name; it leads the shelf.
  const own = node.category?.toLocaleLowerCase();
  const articles = members.filter((member) => member.kind === "article")
    .sort((a, b) => Number(b.title.toLocaleLowerCase() === own) - Number(a.title.toLocaleLowerCase() === own)).slice(0, MAX_SHELF)
    .map((member): BrowseNode => ({ id: articleId(member.title, node.id), label: member.title, kind: "article", article: member.title, weight: 1,
      ...(member.description ? { summary: member.description } : {}) }));
  if (!sections.length) return articles;
  if (!articles.length) return sections;
  const shelf: BrowseNode = { id: `${node.id}/shelf`, label: `Articles in ${node.label}`, kind: "shelf", weight: Math.max(3, Math.sqrt(articles.length) * 2.5),
    summary: `${articles.length} article${articles.length === 1 ? "" : "s"} filed directly under ${node.label}.`, children: articles };
  return [...sections, shelf];
}

const GROUP_LABEL: Record<WikipediaLinkCandidate["kind"], string> = { broader: "Part of", lead: "Main ideas", main: "Main ideas", section: "", "see-also": "See also" };

/** An article opens into its parts: the ideas its opening names, each section, then See also. Each part holds the articles it links to. */
export function articleChildren(node: BrowseNode, outline: { title: string; candidates: WikipediaLinkCandidate[] }): BrowseNode[] {
  const groups = new Map<string, WikipediaLinkCandidate[]>();
  for (const candidate of outline.candidates) {
    if (candidate.kind === "broader" || candidate.title === outline.title) continue;
    const label = candidate.kind === "section" || candidate.kind === "main" && candidate.section ? candidate.section ?? "Main ideas" : GROUP_LABEL[candidate.kind];
    const list = groups.get(label) ?? [];
    if (!list.some((item) => item.title === candidate.title)) list.push(candidate);
    groups.set(label, list);
  }
  const ordered = [...groups.entries()].filter(([, list]) => list.length).slice(0, MAX_GROUPS + 1);
  const groupId = (label: string) => `${node.id}/g:${label}`;
  return ordered.slice(0, MAX_GROUPS).map(([label, list]): BrowseNode => {
    const children = list.sort((a, b) => b.score - a.score).slice(0, MAX_GROUP)
      .map((candidate): BrowseNode => ({ id: articleId(candidate.title, groupId(label)), label: candidate.title, kind: "article", article: candidate.title, weight: 1 }));
    return { id: groupId(label), label, kind: "group", article: outline.title, weight: 2 + children.length, children };
  });
}

/** AI sub-topics as nodes. Each one can be opened again, by AI, or read on Wikipedia when it has an article. */
export function topicChildren(node: BrowseNode, topics: PublicTopic[]): BrowseNode[] {
  return topics.map((topic) => {
    const article = wikipediaTitle(topic.wikipediaUrl)?.replaceAll("_", " ");
    return { id: `${node.id}/t:${topic.id}`, label: topic.label, kind: "topic", topic, weight: 3, ...(topic.description ? { summary: topic.description } : {}),
      ...(article ? { article } : {}) };
  });
}

/* ---------- The tree ---------- */

/** A copy of the tree with one node's children set. */
export function withChildren(root: BrowseNode, id: string, children: BrowseNode[] | undefined): BrowseNode {
  if (root.id === id) { const { children: _old, ...rest } = root; return children ? { ...rest, children } : rest; }
  if (!root.children) return root;
  let changed = false;
  const next = root.children.map((child) => { const made = withChildren(child, id, children); if (made !== child) changed = true; return made; });
  return changed ? { ...root, children: next } : root;
}

/** The nodes from the root down the given ids, stopping at the first id not found. */
export function browsePath(root: BrowseNode, ids: readonly string[]): BrowseNode[] {
  const path = [root];
  for (const id of ids) {
    const next = path[path.length - 1].children?.find((child) => child.id === id);
    if (!next) break;
    path.push(next);
  }
  return path;
}

/** Whether a node can open into more: everything but a shelf or group already shown in full. */
export const canOpen = (node: BrowseNode) => node.kind !== "shelf" && node.kind !== "group" ? true : Boolean(node.children?.length);

/* ---------- Circles that keep their place as they fill in ---------- */

export interface BrowseCircle {
  id: string;
  /** Unique even when the same node sits in two places: the ids from the root down. */
  key: string;
  parentKey: string | null;
  node: BrowseNode; x: number; y: number; r: number; depth: number; color: string;
}

/**
 * Packs the loaded tree top-down: every node keeps the circle it was given, and the nodes inside it
 * are scaled to fit, so opening a node never moves anything already on screen.
 */
export function packBrowse(root: BrowseNode, colorOf: (node: BrowseNode, at: number, parentColor: string) => string): BrowseCircle[] {
  const out: BrowseCircle[] = [];
  const place = (node: BrowseNode, x: number, y: number, r: number, depth: number, parentKey: string | null, color: string) => {
    const key = parentKey === null ? node.id : `${parentKey}>${node.id}`;
    out.push({ id: node.id, key, parentKey, node, x, y, r, depth, color });
    // A category can be filed inside itself further down; stop rather than draw it forever.
    if (parentKey?.split(">").includes(node.id)) return;
    const children = node.children ?? [];
    if (!children.length) return;
    const radii = children.map((child) => Math.sqrt(Math.max(0.5, child.weight)));
    const packed = packCircles(radii, Math.max(...radii) * 0.12);
    // The opened circle keeps room for its name along the top.
    const scale = (r * 0.86) / packed.radius;
    children.forEach((child, at) => place(child, x + packed.centers[at].x * scale, y + packed.centers[at].y * scale + r * 0.04, radii[at] * scale, depth + 1, key,
      colorOf(child, at, color)));
  };
  place(root, 0, 0, 1000, 0, null, "var(--muted)");
  return out;
}
