import type { AIRetrievalRecord } from "../types";
import type { VaultSearchResults } from "./vaultSearch";

/**
 * Show on Map: a search's or an answer's documents lit on the Map, brighter the
 * stronger the match, with the documents linked to them kept faintly in view.
 */
export interface MapSpotlight {
  /** What lit them, such as the search words or the question. */
  label: string;
  /** Document id → match strength, 0 to 1. */
  scores: Record<string, number>;
  requestId: number;
}

export type SpotlightHeat = 1 | 2 | 3;

/** 3 is a likely match, 2 a maybe, 1 a faint one. */
export function spotlightHeat(score: number): SpotlightHeat {
  return score >= 0.75 ? 3 : score >= 0.45 ? 2 : 1;
}

const keepBest = (scores: Record<string, number>, id: string | undefined, score: number) => {
  if (!id) return;
  scores[id] = Math.max(scores[id] ?? 0, score);
};

/** "Found it" documents first (likely), then the best-matching passages' documents (maybe). Cloud-only hits have no place on the Map yet. */
export function spotlightFromSearch(results: VaultSearchResults | null | undefined): Record<string, number> {
  const scores: Record<string, number> = {};
  if (!results) return scores;
  results.found?.hits.forEach((entry, rank) => {
    const id = entry.kind === "passage" ? (entry.hit.cloudPath ? undefined : entry.hit.conversationId)
      : entry.hit.target.kind === "loaded" ? entry.hit.target.conversationId : undefined;
    keepBest(scores, id, Math.max(0.75, 1 - rank * 0.08));
  });
  results.related?.forEach((hit, rank) => {
    if (!hit.cloudPath) keepBest(scores, hit.conversationId, Math.max(0.3, 0.65 - rank * 0.04));
  });
  return scores;
}

/** The documents an answer cites (likely), and those it read without citing (faint). */
export function spotlightFromAnswer(retrieval: AIRetrievalRecord | null | undefined): Record<string, number> {
  const scores: Record<string, number> = {};
  for (const passage of retrieval?.passages ?? []) keepBest(scores, passage.openId ?? passage.id, passage.cited ? 1 : 0.4);
  return scores;
}

/** The documents one link away from a lit one, which stay faintly in view for context. */
export function spotlightNeighbours(lit: ReadonlySet<string>, edges: Iterable<{ sourceId: string; targetId: string }>, shown: ReadonlySet<string>): Set<string> {
  const near = new Set<string>();
  for (const { sourceId, targetId } of edges) {
    if (lit.has(sourceId) && !lit.has(targetId) && shown.has(targetId)) near.add(targetId);
    else if (lit.has(targetId) && !lit.has(sourceId) && shown.has(sourceId)) near.add(sourceId);
  }
  return near;
}

/** "2 likely · 3 maybe", for the bar over the Map. */
export function describeSpotlight(scores: Iterable<number>): string {
  const counts = { 3: 0, 2: 0, 1: 0 };
  for (const score of scores) counts[spotlightHeat(score)]++;
  return [counts[3] ? `${counts[3]} likely` : "", counts[2] ? `${counts[2]} maybe` : "", counts[1] ? `${counts[1]} faint` : ""].filter(Boolean).join(" · ");
}
