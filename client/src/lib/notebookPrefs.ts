/**
 * How the AI thinks with you, and where its questions and your notes show (the Customise
 * window). Saved per device, like the quiet page.
 *
 * - aiBehaviour "thinks": pressing Enter after a line or paragraph asks one question about it in the
 *   margin, and answers hand the thinking back with a follow-up question.
 *   "asks": the AI only answers what you ask.
 * - marginMode "bubbles" (the default): a small bubble beside each passage with the note's first
 *   words; pointing at it shows more, clicking it opens the note. The margin stays narrow.
 *   "full": every note sits open in a wide right margin beside its passage (phones keep bubbles
 *   while the quiet page is on). Settings saved before bubbles ("right", "marks") read as bubbles,
 *   so everyone starts from the narrow margin.
 * - phoneNotesFrom: where an open note comes from on a phone. "bottom" (the default): a sheet from the
 *   bottom you can drag to any height. "side": a panel from the right that covers all but a thin strip
 *   of the page on the left; tapping that strip goes back to the page.
 * - proactive: no longer used (Thinks with you now asks on Enter); kept so saved settings still read.
 * - stance: how its questions lean: supportive, neutral or antagonistic.
 */
export type AIBehaviour = "thinks" | "asks";
export type MarginMode = "bubbles" | "full";
export type PhoneNotesFrom = "bottom" | "side";
export type AIStance = "supportive" | "neutral" | "antagonistic";
export interface NotebookPrefs { aiBehaviour: AIBehaviour; marginMode: MarginMode; phoneNotesFrom: PhoneNotesFrom; proactive: boolean; stance: AIStance }

import { onSyncedSettingChange, writeSyncedSetting } from "./interfaceSettings";

const KEY = "margin-chat:notebook";
export const DEFAULT_NOTEBOOK_PREFS: NotebookPrefs = { aiBehaviour: "thinks", marginMode: "bubbles", phoneNotesFrom: "bottom", proactive: false, stance: "supportive" };
const listeners = new Set<() => void>();
let cached: { raw: string | null; prefs: NotebookPrefs } | null = null;

export function parseNotebookPrefs(raw: string | null): NotebookPrefs {
  let value: Partial<NotebookPrefs> = {};
  try { value = raw ? JSON.parse(raw) ?? {} : {}; } catch { value = {}; }
  return {
    aiBehaviour: value.aiBehaviour === "asks" ? "asks" : "thinks",
    marginMode: (value.marginMode as string) === "full" ? "full" : "bubbles",
    phoneNotesFrom: value.phoneNotesFrom === "side" ? "side" : "bottom",
    proactive: value.proactive === true,
    stance: value.stance === "neutral" || value.stance === "antagonistic" ? value.stance : "supportive",
  };
}

/** The same object until the saved value changes, as useSyncExternalStore needs. */
export function readNotebookPrefs(): NotebookPrefs {
  let raw: string | null;
  try { raw = localStorage.getItem(KEY); }
  catch { return cached?.prefs ?? DEFAULT_NOTEBOOK_PREFS; }
  if (!cached || cached.raw !== raw) cached = { raw, prefs: parseNotebookPrefs(raw) };
  return cached.prefs;
}

export function saveNotebookPrefs(change: Partial<NotebookPrefs>) {
  const next = { ...readNotebookPrefs(), ...change };
  writeSyncedSetting(KEY, JSON.stringify(next));
  cached = { raw: JSON.stringify(next), prefs: next };
  listeners.forEach((listener) => listener());
}

export function subscribeNotebookPrefs(listener: () => void): () => void {
  listeners.add(listener);
  const stop = onSyncedSettingChange([KEY], listener);
  return () => { listeners.delete(listener); stop(); };
}
