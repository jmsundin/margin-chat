import { useSyncExternalStore } from "react";
import { onSyncedSettingChange, writeSyncedSetting } from "./interfaceSettings";

/**
 * Margin Chat starts simple: a page, the map beside it, and one way to ask AI. Everything
 * else is a feature the person switches on in Settings → Features (thread "Simplify Margin
 * Chat with opt-in features"). Rules every feature follows:
 * - It adds its controls in fixed places (a ⋯ menu item, at most one toolbar button, at most
 *   one sidebar entry) and switching it off removes exactly those.
 * - Off never deletes or hides what you wrote: flashcard lines, roadmap notes and boards stay
 *   as they are, and a board still opens as a board.
 * The choices are saved to the account (see interfaceSettings.ts), so every device matches.
 */
export type FeatureId = "language" | "flashcards" | "roadmaps" | "boards" | "claims" | "voice" | "groups" | "spaces" | "outline" | "tiles" | "mapTools";

export interface FeatureInfo {
  id: FeatureId;
  group: "Think" | "Learn" | "Capture" | "Organize";
  name: string;
  description: string;
  /** Where its controls appear when it is on, in the words the app uses. */
  adds: string;
  /** Other words people may type in ⌘K looking for it. */
  keywords: readonly string[];
}

export const FEATURES: readonly FeatureInfo[] = [
  { id: "roadmaps", group: "Think", name: "Roadmaps", description: "Learning paths drawn over your map, with AI drafts and Dive deeper.",
    adds: "Roadmaps on the map, flags where roadmaps start, “Roadmap…” under Make in a document's ⋮ More menu", keywords: ["roadmap", "learning path", "path", "dive deeper", "plan"] },
  { id: "claims", group: "Think", name: "Claim checking", description: "Find the claims a document makes and check each against your other notes.",
    adds: "“Check claims…” under AI in a document's ⋮ More menu", keywords: ["claim", "fact check", "check claims", "ratchet", "evidence"] },
  { id: "boards", group: "Think", name: "Boards", description: "A full-page canvas to draw and think on.",
    adds: "“New board” in the sidebar's ⋯ and + menus, Board in a document's mode button", keywords: ["board", "canvas", "whiteboard", "draw", "drawing"] },
  { id: "flashcards", group: "Learn", name: "Flashcards and quiz", description: "Lines like “Question :: Answer” become cards you review with spaced repetition.",
    adds: "Quiz on the selection menu, “Flashcards…” under Make in a document's ⋮ More menu, Review in its mode button and the sidebar", keywords: ["flashcard", "cards", "quiz", "review", "spaced repetition", "anki", "study"] },
  { id: "language", group: "Learn", name: "Language learning", description: "Read a document in another language: tap a word to see, save and rate what it means.",
    adds: "Language in a document's mode button", keywords: ["language", "translate", "translation", "vocabulary", "words", "spanish", "lingq", "foreign"] },
  { id: "voice", group: "Capture", name: "Voice typing", description: "Talk instead of typing in any text field.",
    adds: "The mic button in text fields and Hold Space to talk", keywords: ["voice", "dictation", "dictate", "mic", "microphone", "speech", "talk"] },
  { id: "groups", group: "Organize", name: "Groups", description: "Collect documents into named groups.",
    adds: "A Groups tab in the sidebar, “New group” in the sidebar's ⋯ menu, “Group” in a document's ⋯ menu", keywords: ["group", "folder", "collection"] },
  { id: "spaces", group: "Organize", name: "Spaces", description: "Save a set of open documents to come back to.",
    adds: "A Spaces tab in the sidebar, “Add to space” in a document's ⋯ menu", keywords: ["space", "session", "workspace"] },
  { id: "outline", group: "Organize", name: "Outline", description: "The open document's headings, to jump between.",
    adds: "An Outline tab in the sidebar", keywords: ["outline", "headings", "table of contents", "toc"] },
  { id: "tiles", group: "Organize", name: "Tile view", description: "Every open document side by side as tiles.",
    adds: "The page and tiles switch at the top of the sidebar", keywords: ["tile", "tiles", "grid", "side by side"] },
  { id: "mapTools", group: "Think", name: "More map tools", description: "Other ways to look at the map: themes, evidence, colours, line filters and the explorer.",
    adds: "“Explore groups and sources”, views, colours and lines in the map's ⋯ menu", keywords: ["map", "explore", "themes", "evidence", "colour", "color", "lines", "wikipedia", "web source"] },
];

export const FEATURE_GROUPS = ["Think", "Learn", "Capture", "Organize"] as const;

export type FeaturePreset = "simple" | "researcher" | "student" | "everything";
export const FEATURE_PRESETS: readonly { id: FeaturePreset; name: string; features: readonly FeatureId[] }[] = [
  { id: "simple", name: "Simple", features: [] },
  { id: "researcher", name: "Researcher", features: ["roadmaps", "claims", "mapTools", "outline"] },
  { id: "student", name: "Student", features: ["flashcards", "language", "voice", "outline"] },
  { id: "everything", name: "Everything", features: FEATURES.map((feature) => feature.id) },
];

export type FeatureSet = Readonly<Record<FeatureId, boolean>>;

/**
 * Features that aren't ready for everyone: only accounts the server lists in
 * OWNER_ONLY_FEATURE_EMAILS get them (it sends them as `ownerFeatures` on the signed-in user,
 * and refuses their API for everyone else). Keep in step with server/features/ownerOnly.mjs.
 */
export const OWNER_ONLY_FEATURES: readonly FeatureId[] = ["voice", "flashcards"];
let ownerAccess: ReadonlySet<FeatureId> = new Set();

/** Which held-back features the signed-in account may use; call with nothing on sign-out. */
export function setOwnerFeatureAccess(ids: readonly string[] | null | undefined) {
  const next = new Set(OWNER_ONLY_FEATURES.filter((id) => ids?.includes(id)));
  if (next.size === ownerAccess.size && [...next].every((id) => ownerAccess.has(id))) return;
  ownerAccess = next;
  listeners.forEach((listener) => listener());
}

/** False for a held-back feature this account can't use: it has no switch and stays off. */
export function featureAvailable(id: FeatureId): boolean {
  return !OWNER_ONLY_FEATURES.includes(id) || ownerAccess.has(id);
}

export const FEATURES_KEY = "margin-chat:features";
const ALL_OFF = Object.fromEntries(FEATURES.map(({ id }) => [id, false])) as unknown as FeatureSet;
const listeners = new Set<() => void>();
let cached: { raw: string | null; features: FeatureSet } | null = null;
let usableCached: { saved: FeatureSet; access: ReadonlySet<FeatureId>; features: FeatureSet } | null = null;
let availableCached: { access: ReadonlySet<FeatureId>; features: readonly FeatureInfo[] } | null = null;

export function parseFeatures(raw: string | null): FeatureSet {
  let value: Record<string, unknown> = {};
  try { value = raw ? JSON.parse(raw) ?? {} : {}; } catch { value = {}; }
  if (typeof value !== "object" || Array.isArray(value)) value = {};
  return Object.fromEntries(FEATURES.map(({ id }) => [id, value[id] === true])) as unknown as FeatureSet;
}

function readRaw(): string | null {
  try { return localStorage.getItem(FEATURES_KEY); } catch { return cached?.raw ?? null; }
}

/** The same object until the saved value changes, as useSyncExternalStore needs. */
export function readFeatures(): FeatureSet {
  const raw = readRaw();
  if (!cached || cached.raw !== raw) cached = { raw, features: parseFeatures(raw) };
  return cached.features;
}

/** The saved choices, with held-back features this account can't use left off. */
export function readUsableFeatures(): FeatureSet {
  const saved = readFeatures();
  if (usableCached && usableCached.saved === saved && usableCached.access === ownerAccess) return usableCached.features;
  const features = Object.fromEntries(FEATURES.map(({ id }) => [id, saved[id] && featureAvailable(id)])) as unknown as FeatureSet;
  usableCached = { saved, access: ownerAccess, features };
  return features;
}

/** The features this account can switch on (all but held-back ones it isn't allowed). */
export function availableFeatures(): readonly FeatureInfo[] {
  if (availableCached && availableCached.access === ownerAccess) return availableCached.features;
  availableCached = { access: ownerAccess, features: FEATURES.filter(({ id }) => featureAvailable(id)) };
  return availableCached.features;
}

/** Whether this device or the account has ever saved a choice (new accounts and existing ones differ here). */
export function hasFeatureChoices(): boolean {
  return readRaw() !== null;
}

/**
 * Features this device or account has never chosen for, because they were added after the
 * choice was saved (or nothing was saved yet). Each one starts from what the person already uses.
 */
export function unchosenFeatures(): FeatureId[] {
  const raw = readRaw();
  let value: unknown = null;
  try { value = raw ? JSON.parse(raw) : null; } catch { value = null; }
  const chosen = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return FEATURES.map(({ id }) => id).filter((id) => typeof chosen[id] !== "boolean");
}

export function saveFeatures(features: Partial<Record<FeatureId, boolean>>) {
  const next = { ...readFeatures(), ...features };
  const raw = JSON.stringify(next);
  writeSyncedSetting(FEATURES_KEY, raw);
  cached = { raw, features: parseFeatures(raw) };
  listeners.forEach((listener) => listener());
}

export function setFeature(id: FeatureId, on: boolean) {
  saveFeatures({ [id]: on });
}

export function applyFeaturePreset(preset: FeaturePreset) {
  const chosen = new Set(FEATURE_PRESETS.find((entry) => entry.id === preset)?.features ?? []);
  // A held-back feature this account can't use is left as it was.
  saveFeatures(Object.fromEntries(availableFeatures().map(({ id }) => [id, chosen.has(id)])));
}

/** The preset these switches match exactly, if any (held-back features this account can't use don't count). */
export function matchingPreset(features: FeatureSet): FeaturePreset | null {
  return FEATURE_PRESETS.find((preset) => availableFeatures().every(({ id }) => features[id] === preset.features.includes(id)))?.id ?? null;
}

export function subscribeFeatures(listener: () => void): () => void {
  listeners.add(listener);
  const stop = onSyncedSettingChange([FEATURES_KEY], listener);
  return () => { listeners.delete(listener); stop(); };
}

export function useFeatures(): FeatureSet {
  return useSyncExternalStore(subscribeFeatures, readUsableFeatures, () => ALL_OFF);
}

const NO_FEATURES: readonly FeatureInfo[] = [];
export function useAvailableFeatures(): readonly FeatureInfo[] {
  return useSyncExternalStore(subscribeFeatures, availableFeatures, () => NO_FEATURES);
}

/** Features whose name or keywords match what was typed in ⌘K. */
export function matchFeatures(query: string): FeatureInfo[] {
  const text = query.trim().toLocaleLowerCase();
  if (text.length < 3) return [];
  // Typing the start of a name or keyword finds it ("flash", "dictat"); a plural finds it too ("boards").
  return availableFeatures().filter((feature) => [feature.name.toLocaleLowerCase(), ...feature.keywords]
    .some((word) => word.startsWith(text) || text === `${word}s` || text === `${word}es`));
}

export function useFeature(id: FeatureId): boolean {
  return useFeatures()[id];
}

/**
 * Accounts that used Margin Chat before features existed keep what they already use on:
 * a roadmap means Roadmaps, a board means Boards, any flashcards mean Flashcards, a group
 * means Groups, a space means Spaces. New accounts have none of these and start on Simple.
 */
export function featuresFromUsage(usage: Partial<Record<FeatureId, boolean>>): FeatureSet {
  return { ...ALL_OFF, ...usage };
}

/**
 * A quiet line on a page whose content uses a feature that is off ("This note has flashcards…").
 * Dismissing it, or turning the feature on, ends it for that feature on every device.
 */
export const FEATURE_HINTS_KEY = "margin-chat:feature-hints-dismissed";
let hintsCache: { raw: string | null; ids: ReadonlySet<string> } | null = null;
function readDismissedHints(): ReadonlySet<string> {
  let raw: string | null = null;
  try { raw = localStorage.getItem(FEATURE_HINTS_KEY); } catch { raw = hintsCache?.raw ?? null; }
  if (hintsCache && hintsCache.raw === raw) return hintsCache.ids;
  let ids: unknown = [];
  try { ids = raw ? JSON.parse(raw) : []; } catch { ids = []; }
  hintsCache = { raw, ids: new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []) };
  return hintsCache.ids;
}
const hintListeners = new Set<() => void>();
/** Ends one hint on every device: a feature id, a "mode:code"-style hint or a "mode-note:code" first-open note. */
export function dismissFeatureHint(id: FeatureId | `mode:${string}` | `mode-note:${string}`) {
  const next = [...new Set([...readDismissedHints(), id])];
  writeSyncedSetting(FEATURE_HINTS_KEY, JSON.stringify(next));
  hintListeners.forEach((listener) => listener());
}
function subscribeHints(listener: () => void) {
  hintListeners.add(listener);
  const stop = onSyncedSettingChange([FEATURE_HINTS_KEY], listener);
  return () => { hintListeners.delete(listener); stop(); };
}
const NO_HINTS: ReadonlySet<string> = new Set();
export function useDismissedFeatureHints(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeHints, readDismissedHints, () => NO_HINTS);
}
