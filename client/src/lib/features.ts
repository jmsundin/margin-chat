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
export type FeatureId = "flashcards" | "roadmaps" | "boards" | "claims" | "voice" | "groups" | "spaces" | "outline" | "tiles" | "mapTools";

export interface FeatureInfo {
  id: FeatureId;
  group: "Think" | "Learn" | "Capture" | "Organize";
  name: string;
  description: string;
  /** Where its controls appear when it is on, in the words the app uses. */
  adds: string;
}

export const FEATURES: readonly FeatureInfo[] = [
  { id: "roadmaps", group: "Think", name: "Roadmaps", description: "Learning paths drawn over your map, with AI drafts and Dive deeper.",
    adds: "Roadmaps on the map, flags where roadmaps start, “Make a roadmap from this…” in a document's ⋯ menu" },
  { id: "claims", group: "Think", name: "Claim checking", description: "Find the claims a document makes and check each against your other notes.",
    adds: "“Check claims…” in a document's ⋯ menu" },
  { id: "boards", group: "Think", name: "Boards", description: "A full-page canvas to draw and think on.",
    adds: "“New board” in the sidebar's ⋯ and + menus, “Board” in a document's ⋯ menu" },
  { id: "flashcards", group: "Learn", name: "Flashcards and quiz", description: "Lines like “Question :: Answer” become cards you review with spaced repetition.",
    adds: "Quiz on the selection menu, “Make flashcards…” and “Review cards” in a document's ⋯ menu, Review in the sidebar" },
  { id: "voice", group: "Capture", name: "Voice typing", description: "Talk instead of typing in any text field.",
    adds: "The mic button in text fields and Hold Space to talk" },
  { id: "groups", group: "Organize", name: "Groups", description: "Collect documents into named groups.",
    adds: "A Groups tab in the sidebar, “New group” in the sidebar's ⋯ menu, “Group” in a document's ⋯ menu" },
  { id: "spaces", group: "Organize", name: "Spaces", description: "Save a set of open documents to come back to.",
    adds: "A Spaces tab in the sidebar, “Add to space” in a document's ⋯ menu" },
  { id: "outline", group: "Organize", name: "Outline", description: "The open document's headings, to jump between.",
    adds: "An Outline tab in the sidebar" },
  { id: "tiles", group: "Organize", name: "Tile view", description: "Every open document side by side as tiles.",
    adds: "The page and tiles switch at the top of the sidebar" },
  { id: "mapTools", group: "Think", name: "More map tools", description: "Other ways to look at the map: themes, evidence, colours, line filters and the explorer.",
    adds: "“Explore groups and sources”, views, colours and lines in the map's ⋯ menu" },
];

export const FEATURE_GROUPS = ["Think", "Learn", "Capture", "Organize"] as const;

export type FeaturePreset = "simple" | "researcher" | "student" | "everything";
export const FEATURE_PRESETS: readonly { id: FeaturePreset; name: string; features: readonly FeatureId[] }[] = [
  { id: "simple", name: "Simple", features: [] },
  { id: "researcher", name: "Researcher", features: ["roadmaps", "claims", "mapTools", "outline"] },
  { id: "student", name: "Student", features: ["flashcards", "voice", "outline"] },
  { id: "everything", name: "Everything", features: FEATURES.map((feature) => feature.id) },
];

export type FeatureSet = Readonly<Record<FeatureId, boolean>>;

export const FEATURES_KEY = "margin-chat:features";
const ALL_OFF = Object.fromEntries(FEATURES.map(({ id }) => [id, false])) as unknown as FeatureSet;
const listeners = new Set<() => void>();
let cached: { raw: string | null; features: FeatureSet } | null = null;

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
  saveFeatures(Object.fromEntries(FEATURES.map(({ id }) => [id, chosen.has(id)])));
}

/** The preset these switches match exactly, if any. */
export function matchingPreset(features: FeatureSet): FeaturePreset | null {
  return FEATURE_PRESETS.find((preset) => FEATURES.every(({ id }) => features[id] === preset.features.includes(id)))?.id ?? null;
}

export function subscribeFeatures(listener: () => void): () => void {
  listeners.add(listener);
  const stop = onSyncedSettingChange([FEATURES_KEY], listener);
  return () => { listeners.delete(listener); stop(); };
}

export function useFeatures(): FeatureSet {
  return useSyncExternalStore(subscribeFeatures, readFeatures, () => ALL_OFF);
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
