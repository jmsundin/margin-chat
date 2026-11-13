/**
 * The Map's zoom levels. Zooming out doesn't just shrink the documents: each step swaps them for a
 * bigger, named group, so there is always something readable on screen.
 *
 *   themes    a few broad areas, each holding several topics
 *   topics    one tile per topic box
 *   blocks    circles with the titles that fit, and each block of alike documents named
 *   notes     circles with titles, as the Map always drew them
 *   previews  each document's opening lines under its title
 */
import { titleWords, type DocumentSimilarity } from "./similarityBlocks";

export type MapZoomLevel = "themes" | "topics" | "blocks" | "notes" | "previews";
export const MAP_ZOOM_LEVELS: readonly MapZoomLevel[] = ["themes", "topics", "blocks", "notes", "previews"];
export const MAP_ZOOM_LEVEL_LABELS: Record<MapZoomLevel, string> = { themes: "Themes", topics: "Topics", blocks: "Blocks", notes: "Notes", previews: "Previews" };

/** Fewer topics than this are easy to take in at once; themes would only add a step. */
export const MIN_TOPICS_FOR_THEMES = 6;
const MAX_THEMES = 9;
/** Documents compared per topic when scoring how alike two topics are. */
const TOPIC_SAMPLE = 5;
/** Topics less alike than this never share a theme, however many topics there are. */
const MIN_THEME_SIMILARITY = 0.18;
/** Topics this alike share a theme even when the map already has few themes. */
const CLEAR_THEME_SIMILARITY = 0.3;

export interface MapThemeTopic { id: string; label: string; memberIds: string[] }
export interface MapTheme {
  id: string;
  /** A name made from its topics, until AI names it. */
  label: string;
  /** Biggest topic first. */
  topicIds: string[];
  memberIds: string[];
}

/** "Angular", "Angular and React", "Angular, React and 3 more". */
export function themeFallbackLabel(labels: string[]) {
  if (labels.length <= 1) return labels[0] ?? "Theme";
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels[0]}, ${labels[1]} and ${labels.length - 2} more`;
}

/**
 * Topics alike in meaning, joined into a few broad themes: aiming for about the square root of the
 * topic count, between 3 and 9. Average linkage over a few documents from each topic, with no theme
 * allowed to swallow most of the map. Topics alike to no other stay outside every theme, as boxes of
 * their own. A theme's id comes from its biggest topic, so it stays put while smaller topics come
 * and go. Returns nothing when there are too few topics to need themes, or they have little in common.
 */
export function groupTopicsIntoThemes(unordered: MapThemeTopic[], similarity: DocumentSimilarity): MapTheme[] {
  const n = unordered.length;
  if (n < MIN_TOPICS_FOR_THEMES) return [];
  // The same topics give the same themes whatever order they arrive in.
  const topics = [...unordered].sort((a, b) => a.id.localeCompare(b.id));
  const target = Math.max(3, Math.min(MAX_THEMES, Math.round(Math.sqrt(n * 1.5))));
  const maxSize = Math.ceil(2.5 * n / target);
  const samples = topics.map((topic) => topic.memberIds.slice(0, TOPIC_SAMPLE));
  const sums = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    let total = 0;
    for (const a of samples[i]) for (const b of samples[j]) total += Math.max(0, Math.min(1, similarity(a, b) || 0));
    const mean = total / Math.max(1, samples[i].length * samples[j].length);
    sums[i * n + j] = mean; sums[j * n + i] = mean;
  }
  const members = topics.map((_, index) => [index]);
  const alive = members.map((_, index) => index);
  while (alive.length > 2) {
    let best = -1, bestA = -1, bestB = -1;
    for (let x = 0; x < alive.length; x++) for (let y = x + 1; y < alive.length; y++) {
      const a = alive[x], b = alive[y];
      if (members[a].length + members[b].length > maxSize) continue;
      const mean = sums[a * n + b] / (members[a].length * members[b].length);
      if (mean > best) { best = mean; bestA = a; bestB = b; }
    }
    if (bestA < 0 || best < (alive.length > target ? MIN_THEME_SIMILARITY : CLEAR_THEME_SIMILARITY)) break;
    alive.splice(alive.indexOf(bestB), 1);
    for (const other of alive) {
      if (other === bestA) continue;
      const total = sums[bestA * n + other] + sums[bestB * n + other];
      sums[bestA * n + other] = total; sums[other * n + bestA] = total;
    }
    members[bestA] = [...members[bestA], ...members[bestB]];
  }
  const themes = alive.filter((index) => members[index].length > 1).map((index) => {
    const own = members[index].map((at) => topics[at])
      .sort((a, b) => b.memberIds.length - a.memberIds.length || a.id.localeCompare(b.id));
    return { id: `theme:${own[0].id}`, label: themeFallbackLabel(own.map((topic) => topic.label)),
      topicIds: own.map((topic) => topic.id), memberIds: own.flatMap((topic) => topic.memberIds) };
  });
  if (themes.length < 2) return [];
  return themes.sort((a, b) => b.memberIds.length - a.memberIds.length || a.id.localeCompare(b.id));
}

const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * A block's name from what its titles share: the one or two words most of them use ("Rapamycin",
 * "Sleep tracker"). Blocks whose titles share no word are named after their first document.
 */
export function blockFallbackName(titles: string[]) {
  const counts = new Map<string, number>(), firstSeen = new Map<string, number>();
  let position = 0;
  for (const title of titles) for (const word of titleWords(title)) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
    if (!firstSeen.has(word)) firstSeen.set(word, position++);
  }
  const needed = Math.max(2, Math.ceil(titles.length * 0.6));
  const shared = [...counts].filter(([, count]) => count >= needed)
    .sort((a, b) => b[1] - a[1] || firstSeen.get(a[0])! - firstSeen.get(b[0])!).slice(0, 2)
    .sort((a, b) => firstSeen.get(a[0])! - firstSeen.get(b[0])!).map(([word]) => word);
  if (shared.length) return capitalize(shared.join(" "));
  const first = (titles[0] ?? "").trim().replace(/\s+/gu, " ");
  if (!first) return "Alike notes";
  const short = first.length > 28 ? `${first.slice(0, 27).trimEnd()}…` : first;
  return titles.length > 1 ? `${short} +${titles.length - 1}` : short;
}

/** The camera scales where one level hands over to the next. */
export interface MapZoomScales {
  /** Below this, topic boxes are too small to name and themes stand in for them. 0 when there are no themes. */
  topicsFrom: number;
  /** Below this, a card's title has no room and each topic is a tile. */
  blocksFrom: number;
  /** From here every document has room for a title. */
  notesFrom: number;
  /** From here every document has room for its opening lines. */
  previewsFrom: number;
}

/** On-screen sizes, in pixels, at which each level becomes readable. */
const TOPIC_TILE_MIN_SIDE = 60;
/** Matches the Map's own cutoff: below it a card's title has no room. */
export const NOTES_CARD_WIDTH = 56;
const NOTE_CELL_WIDTH = 88;
/** From this size a card stops being a circle and shows its opening lines (the Map's own rule). */
const PREVIEW_CARD_WIDTH = 210, PREVIEW_CARD_HEIGHT = 110, PREVIEW_MIN_SCALE = 1.15;

export function mapZoomScales({ cardWidth, cardHeight = 96, cellWidth, topicSide, hasThemes, hasBlocks }: {
  /** A typical card's width on the map, before zoom. */
  cardWidth: number;
  cardHeight?: number;
  /** A card's width plus the gap to the next one. */
  cellWidth: number;
  /** The shorter side of a typical topic box inside a theme. */
  topicSide: number;
  hasThemes: boolean;
  hasBlocks: boolean;
}): MapZoomScales {
  const card = Math.max(1, cardWidth), cell = Math.max(card, cellWidth);
  // Topic tiles hand over to circles where the Map always did: where a card's title first has room.
  const blocksFrom = NOTES_CARD_WIDTH / card, titlesFrom = blocksFrom;
  return {
    topicsFrom: hasThemes ? Math.min(blocksFrom * 0.7, TOPIC_TILE_MIN_SIDE / Math.max(1, topicSide)) : 0,
    blocksFrom,
    notesFrom: hasBlocks ? Math.max(titlesFrom, NOTE_CELL_WIDTH / cell) : titlesFrom,
    previewsFrom: Math.max(PREVIEW_MIN_SCALE, PREVIEW_CARD_WIDTH / card, PREVIEW_CARD_HEIGHT / Math.max(1, cardHeight)),
  };
}

export function mapZoomLevel(scale: number, scales: MapZoomScales): MapZoomLevel {
  if (scale < scales.topicsFrom) return "themes";
  if (scale < scales.blocksFrom) return "topics";
  if (scale < scales.notesFrom) return "blocks";
  return scale < scales.previewsFrom ? "notes" : "previews";
}

/** The scale the ladder flies to for a level: comfortably inside it, not on its edge. */
export function mapZoomLevelScale(level: MapZoomLevel, scales: MapZoomScales) {
  switch (level) {
    case "themes": return scales.topicsFrom * 0.8;
    case "topics": return Math.max(scales.topicsFrom * 1.15, Math.min(scales.blocksFrom * 0.85, scales.topicsFrom ? Math.sqrt(scales.topicsFrom * scales.blocksFrom) : scales.blocksFrom * 0.7));
    case "blocks": return Math.sqrt(scales.blocksFrom * scales.notesFrom);
    case "notes": return Math.min(scales.notesFrom * 1.35, Math.sqrt(scales.notesFrom * scales.previewsFrom));
    case "previews": return scales.previewsFrom * 1.04;
  }
}

/**
 * The levels worth offering for this map: a level you could only reach by shrinking the whole map
 * to a corner of the screen is left out, so a small vault gets a short ladder.
 */
export function reachableMapZoomLevels(scales: MapZoomScales, fitScale: number, { hasThemes, hasBlocks }: { hasThemes: boolean; hasBlocks: boolean }): MapZoomLevel[] {
  const floor = fitScale > 0 ? fitScale * 0.6 : 0;
  return MAP_ZOOM_LEVELS.filter((level) => {
    if (level === "themes" && !hasThemes) return false;
    if (level === "blocks" && !hasBlocks) return false;
    if (level === "notes" || level === "previews") return true;
    const upper = level === "themes" ? scales.topicsFrom : level === "topics" ? scales.blocksFrom : scales.notesFrom;
    return upper > floor;
  });
}
