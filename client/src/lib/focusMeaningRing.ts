export type MeaningRingItem = { id: string; similarity: number };
export const EMPTY_MEANING_RING: MeaningRingItem[] = [];
/** Below this, a server neighbour is too loosely related to put in front of the reader. */
export const MEANING_RING_MIN_SIMILARITY = 0.3;
const MEANING_RING_SIZE = 8;

/** The focused document's nearest documents by meaning that its links do not already show, closest first. */
export function focusMeaningRing(focusId: string, neighbours: ReadonlyArray<{ id: string; similarity: number }> | undefined,
  shown: ReadonlySet<string>, conversations: Record<string, unknown>): MeaningRingItem[] {
  if (!neighbours?.length) return EMPTY_MEANING_RING;
  return [...neighbours].filter((near) => near.id !== focusId && !shown.has(near.id) && conversations[near.id] && near.similarity >= MEANING_RING_MIN_SIMILARITY)
    .sort((a, b) => b.similarity - a.similarity || (a.id < b.id ? -1 : 1)).slice(0, MEANING_RING_SIZE)
    .map(({ id, similarity }) => ({ id, similarity }));
}
