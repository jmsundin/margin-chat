import type { Conversation } from "../types";

/** How a map card is drawn so parents read above their children. */
export interface MapFamilyStyle {
  /** Steps below the family's top document: 0 for the top, 1 for its children... */
  depth: number;
  /** Size multiplier for the card: 1 at the top, smaller for each level down. */
  size: number;
  /** The family's hue, or null for a document with no family (drawn neutral). */
  hue: number | null;
}

/** Each level down shrinks the card by this much... Top documents keep full size, so nothing grows into its neighbors. */
const FAMILY_LEVEL_STEP = 0.15;
/** ...but never below this, so deep notes stay readable. */
export const FAMILY_MIN_SIZE = 0.7;

export function mapFamilySize(depth: number) {
  return Math.max(FAMILY_MIN_SIZE, 1 - depth * FAMILY_LEVEL_STEP);
}

/** Golden-angle hues by size rank keep neighboring groups visibly distinct; shared with Clusters' circles. */
export function rankedHues<T extends { id: string; size: number }>(groups: T[]) {
  const ranked = [...groups].sort((a, b) => b.size - a.size || (a.id < b.id ? -1 : 1));
  return new Map(ranked.map((group, rank) => [group.id, Math.round((210 + rank * 137.508) % 360)]));
}

/**
 * Depth and color for each document on the map. Families follow the branch
 * lines the map draws (parentId), so a child sits under the card it hangs
 * from. Every family of two or more shares one hue; lone documents have none.
 */
export function getMapFamilyStyles(conversations: Record<string, Conversation>): Map<string, MapFamilyStyle> {
  const rootOf = new Map<string, string>();
  const depthOf = new Map<string, number>();
  const resolve = (id: string): [string, number] => {
    const known = rootOf.get(id);
    if (known !== undefined) return [known, depthOf.get(id)!];
    // Walk up to the first ancestor already resolved (or the top), then fill the path in.
    const path: string[] = [];
    const seen = new Set<string>();
    let current: string = id;
    let base: [string, number] | null = null;
    while (true) {
      if (rootOf.has(current)) { base = [rootOf.get(current)!, depthOf.get(current)!]; break; }
      path.push(current);
      seen.add(current);
      const parentId = conversations[current]?.parentId;
      if (!parentId || !conversations[parentId] || seen.has(parentId)) break;
      current = parentId;
    }
    let [root, depth] = base ? [base[0], base[1] + 1] : [path[path.length - 1], 0];
    for (let index = path.length - 1; index >= 0; index--, depth++) {
      rootOf.set(path[index], root);
      depthOf.set(path[index], depth);
    }
    return [rootOf.get(id)!, depthOf.get(id)!];
  };

  const familySize = new Map<string, number>();
  for (const id of Object.keys(conversations)) {
    const [root] = resolve(id);
    familySize.set(root, (familySize.get(root) ?? 0) + 1);
  }
  const hues = rankedHues([...familySize].filter(([, size]) => size > 1).map(([id, size]) => ({ id, size })));

  const result = new Map<string, MapFamilyStyle>();
  for (const id of Object.keys(conversations)) {
    const root = rootOf.get(id)!, depth = depthOf.get(id)!;
    result.set(id, { depth, size: mapFamilySize(depth), hue: hues.get(root) ?? null });
  }
  return result;
}
