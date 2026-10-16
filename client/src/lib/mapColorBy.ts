import type { Conversation, ConversationGroup } from "../types";
import { rankedHues } from "./graphFamilies";
import { lensDate, mapDocumentType, MAP_DOCUMENT_TYPES, newLensFilter, type MapDocumentType, type MapLensFilter } from "./mapLens";

/**
 * What the map's colors mean. "family" is the default: each family of
 * documents shares a hue (Clusters uses each cluster's hue instead).
 */
export type MapColorBy = "family" | "edited" | "created" | "connections" | "type" | "tag" | "group";

export const MAP_COLOR_BY_OPTIONS: Array<{ value: MapColorBy; label: string }> = [
  { value: "family", label: "Family" },
  { value: "edited", label: "Last edited" },
  { value: "created", label: "Created" },
  { value: "connections", label: "Connections" },
  { value: "type", label: "Kind of document" },
  { value: "tag", label: "Tag" },
  { value: "group", label: "Group" },
];

export function readMapColorBy(value: unknown): MapColorBy {
  return MAP_COLOR_BY_OPTIONS.some((option) => option.value === value) ? value as MapColorBy : "family";
}

export interface MapLegendItem {
  label: string;
  color: string;
  count: number;
  /** Clicking the swatch adds this filter, narrowing the map to that color. */
  filter?: MapLensFilter;
}

export interface MapColoring {
  /** Each document's color, or null for neutral grey. */
  colorOf: Map<string, string | null>;
  legend: MapLegendItem[];
}

export interface MapColorContext {
  conversations: Record<string, Conversation>;
  groups: Record<string, ConversationGroup>;
  connectionCounts: Map<string, number>;
  now?: number;
}

const DAY = 86_400_000;
const hsl = (hue: number, saturation = 58, lightness = 48) => `hsl(${hue} ${saturation}% ${lightness}%)`;
/** Recent is warm, older cools and greys out, so the eye finds fresh work first. */
const AGE_BUCKETS: Array<{ days: number | null; label: string; color: string }> = [
  { days: 7, label: "Past week", color: hsl(18, 82, 52) },
  { days: 30, label: "Past month", color: hsl(40, 80, 48) },
  { days: 90, label: "Past 3 months", color: hsl(160, 55, 42) },
  { days: 365, label: "Past year", color: hsl(205, 55, 50) },
  { days: null, label: "Older", color: hsl(225, 18, 52) },
];
const CONNECTION_BUCKETS: Array<{ min: number; max: number | null; label: string; color: string | null }> = [
  { min: 0, max: 0, label: "No connections", color: null },
  { min: 1, max: 2, label: "1 to 2", color: hsl(170, 35, 58) },
  { min: 3, max: 9, label: "3 to 9", color: hsl(215, 75, 55) },
  { min: 10, max: null, label: "10 or more", color: hsl(300, 70, 60) },
];
const TYPE_HUES: Record<MapDocumentType, number> = { document: 210, side: 170, branch: 32, marginNote: 48, note: 290, file: 350, topic: 120 };
/** Tags and groups beyond this many share the neutral "Other" color. */
const MAX_CATEGORIES = 8;

function startOfDay(time: number) {
  return Math.floor(time / DAY) * DAY;
}

/** Colors for `ids` by the chosen property, with a legend; null for "family", which the map draws itself. */
export function mapColoring(ids: Iterable<string>, mode: MapColorBy, context: MapColorContext): MapColoring | null {
  if (mode === "family") return null;
  const colorOf = new Map<string, string | null>();
  const now = context.now ?? Date.now();
  const list = [...ids].filter((id) => context.conversations[id]);

  if (mode === "edited" || mode === "created") {
    const counts = AGE_BUCKETS.map(() => 0);
    let undated = 0;
    for (const id of list) {
      const at = lensDate(context.conversations[id], mode);
      if (at === null) { colorOf.set(id, null); undated++; continue; }
      const index = AGE_BUCKETS.findIndex((bucket) => bucket.days === null || at >= now - bucket.days * DAY);
      counts[index]++;
      colorOf.set(id, AGE_BUCKETS[index].color);
    }
    const legend: MapLegendItem[] = AGE_BUCKETS.map((bucket, index) => {
      const newer = index > 0 ? AGE_BUCKETS[index - 1].days : null;
      const base = newLensFilter(mode, now) as Extract<MapLensFilter, { kind: "edited" | "created" }>;
      return { label: bucket.label, color: bucket.color, count: counts[index],
        filter: { ...base, from: bucket.days === null ? null : startOfDay(now - bucket.days * DAY), to: newer === null || newer === undefined ? null : startOfDay(now - newer * DAY) } };
    });
    if (undated) legend.push({ label: "No date", color: "", count: undated });
    return { colorOf, legend: legend.filter((item) => item.count) };
  }

  if (mode === "connections") {
    const counts = CONNECTION_BUCKETS.map(() => 0);
    for (const id of list) {
      const links = context.connectionCounts.get(id) ?? 0;
      const index = CONNECTION_BUCKETS.findIndex((bucket) => links >= bucket.min && (bucket.max === null || links <= bucket.max));
      counts[index]++;
      colorOf.set(id, CONNECTION_BUCKETS[index].color);
    }
    return { colorOf, legend: CONNECTION_BUCKETS.map((bucket, index) => ({ label: bucket.label, color: bucket.color ?? "", count: counts[index],
      filter: { id: `connections-${bucket.min}`, kind: "connections" as const, min: bucket.min, max: bucket.max } })).filter((item) => item.count) };
  }

  if (mode === "type") {
    const counts = new Map<MapDocumentType, number>();
    for (const id of list) {
      const type = mapDocumentType(context.conversations[id]);
      counts.set(type, (counts.get(type) ?? 0) + 1);
      colorOf.set(id, hsl(TYPE_HUES[type]));
    }
    return { colorOf, legend: MAP_DOCUMENT_TYPES.filter((type) => counts.get(type.value)).map((type) => ({
      label: type.label, color: hsl(TYPE_HUES[type.value]), count: counts.get(type.value)!,
      filter: { id: `type-${type.value}`, kind: "type" as const, values: [type.value] } })) };
  }

  // Tags and groups: the most used ones get their own color, the rest share "Other".
  const categoriesOf = (id: string): string[] => mode === "tag" ? context.conversations[id].tags ?? []
    : (groupIds.get(id) ?? []);
  const groupIds = new Map<string, string[]>();
  if (mode === "group") {
    for (const group of Object.values(context.groups)) for (const id of group.conversationIds) {
      const memberOf = groupIds.get(id);
      if (memberOf) memberOf.push(group.id); else groupIds.set(id, [group.id]);
    }
  }
  const usage = new Map<string, number>();
  for (const id of list) for (const category of categoriesOf(id)) usage.set(category, (usage.get(category) ?? 0) + 1);
  const top = [...usage].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, MAX_CATEGORIES).map(([category]) => category);
  const hues = rankedHues(top.map((category) => ({ id: category, size: usage.get(category)! })));
  const colorFor = (category: string) => mode === "group" ? context.groups[category]?.color ?? hsl(hues.get(category)!) : hsl(hues.get(category)!);
  const counts = new Map<string, number>();
  let other = 0, none = 0;
  for (const id of list) {
    const categories = categoriesOf(id);
    // A document in several picks the most used one, so big categories read as whole regions.
    const pick = top.find((category) => categories.includes(category));
    if (pick) { counts.set(pick, (counts.get(pick) ?? 0) + 1); colorOf.set(id, colorFor(pick)); }
    else { colorOf.set(id, null); if (categories.length) other++; else none++; }
  }
  const legend: MapLegendItem[] = top.map((category) => ({
    label: mode === "tag" ? `#${category}` : context.groups[category]?.name ?? "Deleted group",
    color: colorFor(category), count: counts.get(category) ?? 0,
    filter: { id: `${mode}-${category}`, kind: mode, values: [category] } }));
  if (other) legend.push({ label: mode === "tag" ? "Other tags" : "Other groups", color: "", count: other });
  if (none) legend.push({ label: mode === "tag" ? "No tags" : "In no group", color: "", count: none });
  return { colorOf, legend: legend.filter((item) => item.count) };
}
