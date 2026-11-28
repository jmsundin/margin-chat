import { writeSyncedSetting } from "./interfaceSettings";

/** How Explore draws the notes around one note: rings around it, or the free Canvas. */
export type AroundLayout = "rings" | "canvas";
const AROUND_SETTING = "margin-chat:explore-around-layout" as const;

/** Rings read at a glance, so they are where the map around a note starts. */
export function readAroundLayout(): AroundLayout {
  let value: string | null = null;
  try { value = localStorage.getItem(AROUND_SETTING); } catch { /* Private windows start on Rings. */ }
  return value === "canvas" ? "canvas" : "rings";
}

export function writeAroundLayout(layout: AroundLayout) {
  writeSyncedSetting(AROUND_SETTING, layout);
}

/** A note on the inner ring: linked to the one in the middle, or close to it in meaning. */
export interface AroundNeighbour { id: string; kind: "linked" | "similar" }

/** At most this many notes sit on the inner ring, so every one can carry its title. */
export const AROUND_NOTE_LIMIT = 10;
/** And at most this many public topics on the outer ring. */
export const AROUND_PUBLIC_LIMIT = 8;

/**
 * The notes for the inner ring: notes linked to the center first (the most linked first), then
 * notes close to it in meaning, keeping a few places for those so forgotten connections show.
 */
export function pickAroundNeighbours(centerId: string, connections: ReadonlyArray<{ sourceId: string; targetId: string }>,
  similar: ReadonlyArray<{ id: string }>, exists: (id: string) => boolean, limit = AROUND_NOTE_LIMIT): AroundNeighbour[] {
  const counts = new Map<string, number>();
  for (const { sourceId, targetId } of connections) {
    const other = sourceId === centerId ? targetId : targetId === centerId ? sourceId : null;
    if (other && other !== centerId && exists(other)) counts.set(other, (counts.get(other) ?? 0) + 1);
  }
  const linked = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([id]) => id);
  const near = similar.map((item) => item.id).filter((id, at, all) => id !== centerId && !counts.has(id) && exists(id) && all.indexOf(id) === at);
  const linkedRoom = Math.max(0, limit - Math.min(3, near.length));
  const picked: AroundNeighbour[] = linked.slice(0, linkedRoom).map((id) => ({ id, kind: "linked" }));
  for (const id of near) { if (picked.length >= limit) break; picked.push({ id, kind: "similar" }); }
  return picked;
}

/** Wikipedia articles a note links to, in the order they appear. */
export function wikipediaTitlesIn(text: string, limit = 3): string[] {
  const titles: string[] = [];
  for (const match of text.matchAll(/https?:\/\/en(?:\.m)?\.wikipedia\.org\/wiki\/([^\s)\]>"'#?]+)/giu)) {
    let title = match[1];
    try { title = decodeURIComponent(title); } catch { /* Keep it as written. */ }
    title = title.replace(/_/g, " ").trim();
    if (title && !title.includes(":") && !titles.includes(title)) titles.push(title);
    if (titles.length >= limit) break;
  }
  return titles;
}

/** A note title as a Wikipedia search: no trailing ellipsis, markup or dates, and not too long. */
export function topicQuery(title: string): string {
  return title.replace(/\(\d{4}-\d{2}-\d{2}\)/gu, " ").replace(/[…]+|\.{3,}/gu, " ").replace(/[#*_`[\](){}|<>"]/gu, " ")
    .replace(/\s+/gu, " ").trim().slice(0, 80);
}

/** Whether an article's name is the note's title, ignoring case, punctuation and a "(disambiguation)" part. */
export function sameTopicName(label: string, title: string) {
  const plain = (text: string) => text.toLocaleLowerCase().replace(/\s*\([^)]*\)\s*/gu, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return plain(label) === plain(title);
}

export interface RingPoint { x: number; y: number }

/** Evenly spaced points on an ellipse, starting at the top and turned by `turn` (a share of a full circle). */
export function ringPoints(count: number, cx: number, cy: number, rx: number, ry: number, turn = 0): RingPoint[] {
  return Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI / 2 + (index / Math.max(1, count) + turn) * Math.PI * 2;
    return { x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry };
  });
}
