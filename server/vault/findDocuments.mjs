/**
 * "Found it": which of the user's documents a search is about. The passage
 * index ranks passages; this ranks whole documents from them, so a document
 * that covers a topic across several sections beats one with a single stray
 * mention, and says whether the search looks like a find or a question.
 *
 * Pure functions, no AI call. The thresholds are starting points, kept here so
 * they can be tuned against an evaluation set without touching the callers.
 */
import { titleMatcher, vaultSearchTerms } from "./search.mjs";

export const FIND_THRESHOLDS = Object.freeze({
  /** The top document must score this many times the second to stand alone. */
  leadRatio: 1.6,
  /** Its best passage must be at least this close in meaning, or its title must hold every word. */
  foundSimilarity: 0.55,
  /** Documents within this share of the top score form a group of up to `groupSize`. */
  groupShare: 0.8,
  groupSimilarity: 0.45,
  groupSize: 3,
  /** Below this, and with no word matches, nothing in the vault is on the topic. */
  weakSimilarity: 0.35,
});

/** Passage weights for a document's best, second and third passages. */
const PASSAGE_WEIGHTS = [1, 0.5, 0.25];
/** Reciprocal-rank scores sit near 1/60; bonuses are on that scale. */
const RANK_UNIT = 1 / 61;
const TITLE_BONUS = 1.5 * RANK_UNIT;
const HUB_BONUS = 0.35 * RANK_UNIT;
const RECENCY_BONUS = 0.15 * RANK_UNIT;
const RECENCY_HALF_LIFE_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;
const QUESTION_START = /^(how|why|what|which|who|when|where|should|does|do|did|is|are|can|could|would|will)\b/iu;

/** Whether a query reads as a question rather than a description of a document. */
export function isQuestion(query) {
  const text = String(query ?? "").trim();
  return text.endsWith("?") || (text.split(/\s+/u).length >= 3 && QUESTION_START.test(text));
}

const documentIdOf = (passage) => (passage.sourceKind === "attachment" ? passage.attachedTo : passage.id) ?? null;

function recency(updatedAt, now) {
  const time = Date.parse(updatedAt ?? "");
  if (!Number.isFinite(time)) return 0;
  return RECENCY_BONUS * 0.5 ** (Math.max(0, now - time) / DAY_MS / RECENCY_HALF_LIFE_DAYS);
}

function why({ titleMatch, passages, keywordPassages, meaningPassages, hub }) {
  const parts = [];
  if (titleMatch) parts.push("Title has every word");
  if (keywordPassages && meaningPassages) parts.push(`Same words and meaning in ${passages} ${passages === 1 ? "section" : "sections"}`);
  else if (keywordPassages) parts.push(`Same words in ${keywordPassages} ${keywordPassages === 1 ? "section" : "sections"}`);
  else if (meaningPassages) parts.push(`Related by meaning in ${meaningPassages} ${meaningPassages === 1 ? "section" : "sections"}`);
  if (hub) parts.push(`links ${hub} other matches`);
  return parts.join(" · ") || "Matches your search";
}

/**
 * Ranks documents from `passages` (passage index results, best first, each
 * with `score`, `similarity` and `matched`) and `titles` (index entries whose
 * title holds every word). `related(id)` lists the IDs a document's parent and
 * links point at, for spotting the hub of a topic.
 */
export function rankDocuments({ query, passages = [], titles = [], related = () => [], now = Date.now(), limit = 5 }) {
  const terms = vaultSearchTerms(query);
  const titleMatches = titleMatcher(terms);
  const byId = new Map();
  const entry = (id, title, updatedAt) => {
    let found = byId.get(id);
    if (!found) {
      found = { id, title, updatedAt: updatedAt ?? null, passages: [], titleMatch: false, hidden: false };
      byId.set(id, found);
    }
    return found;
  };
  for (const passage of passages) {
    const id = documentIdOf(passage);
    if (!id) continue;
    // A file's passages count toward the chat or document it is attached to,
    // whose title is not the file's; that title is filled in from `titles` when listed.
    const found = entry(id, passage.sourceKind === "attachment" ? null : passage.title, passage.updatedAt);
    found.passages.push(passage);
  }
  for (const title of titles) {
    if (!terms.length || !titleMatches(title.title ?? "")) continue;
    const found = entry(title.id, title.title, title.updated ?? title.created);
    found.title ??= title.title;
    found.titleMatch = true;
    if (title.hiddenFromAI) found.hidden = true;
  }
  const ranked = [...byId.values()].filter((found) => found.title).map((found) => {
    const scores = found.passages.map((passage) => Number(passage.score) || 0).sort((a, b) => b - a);
    const passageScore = PASSAGE_WEIGHTS.reduce((sum, weight, index) => sum + weight * (scores[index] ?? 0), 0);
    const best = found.passages[0] ?? null;
    const similarity = Math.max(0, ...found.passages.map((passage) => Number(passage.similarity) || 0));
    if (!found.titleMatch && titleMatches(found.title)) found.titleMatch = terms.length > 0;
    return {
      ...found, best, similarity, passageScore,
      keywordPassages: found.passages.filter((passage) => passage.matched !== "meaning").length,
      meaningPassages: found.passages.filter((passage) => passage.matched !== "keyword").length,
      score: passageScore + (found.titleMatch ? TITLE_BONUS : 0) + recency(found.updatedAt, now),
    };
  }).sort((left, right) => right.score - left.score);

  // A document whose parent or links point at two or more of the other top
  // matches is probably the topic's hub.
  const top = ranked.slice(0, limit);
  const topIds = new Set(top.map((found) => found.id));
  for (const found of top) {
    const pointsAt = new Set(related(found.id) ?? []);
    const pointedBy = top.filter((other) => other.id !== found.id && (related(other.id) ?? []).includes(found.id)).length;
    found.hub = [...pointsAt].filter((id) => id !== found.id && topIds.has(id)).length + pointedBy;
    if (found.hub >= 2) found.score += HUB_BONUS;
  }
  return ranked.sort((left, right) => right.score - left.score).slice(0, limit).map((found) => ({
    id: found.id, title: found.title, score: found.score, similarity: found.similarity || null,
    titleMatch: found.titleMatch, hidden: found.hidden, updatedAt: found.updatedAt, keywordPassages: found.keywordPassages,
    why: why({ titleMatch: found.titleMatch, passages: found.passages.length, keywordPassages: found.keywordPassages, meaningPassages: found.meaningPassages, hub: found.hub >= 2 ? found.hub : 0 }),
    best: found.best,
  }));
}

/**
 * "found" when one document clearly covers the search, "several" when a few
 * share it, "answer" for a question, "none" when nothing is on the topic, and
 * "unclear" otherwise. `documents` are what the card shows.
 */
export function findVerdict(query, ranked, thresholds = FIND_THRESHOLDS) {
  const question = isQuestion(query);
  const [first, second] = ranked;
  const strong = (found, similarity) => found.titleMatch || (found.similarity ?? 0) >= similarity || found.keywordPassages > 0;
  if (!first || (!first.titleMatch && (first.similarity ?? 0) < thresholds.weakSimilarity && !(first.best && first.best.matched !== "meaning"))) {
    return { verdict: "none", question, documents: [] };
  }
  const leads = !second || first.score >= thresholds.leadRatio * second.score;
  if (leads && (first.titleMatch || (first.similarity ?? 0) >= thresholds.foundSimilarity)) {
    return { verdict: question ? "answer" : "found", question, documents: [first] };
  }
  const group = ranked.filter((found) => found.score >= thresholds.groupShare * first.score && strong(found, thresholds.groupSimilarity))
    .slice(0, thresholds.groupSize);
  if (group.length >= 2) return { verdict: question ? "answer" : "several", question, documents: group };
  return { verdict: question ? "answer" : "unclear", question, documents: question ? ranked.slice(0, 1) : [] };
}
